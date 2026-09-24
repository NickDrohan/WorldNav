import {
  PerspectiveCamera,
  Vector3,
  Quaternion,
  type Object3D,
} from "three";
import {
  GLOBE_RADIUS,
  CAMERA_MAX_DISTANCE,
  CAMERA_SURFACE_DISTANCE,
  damp,
} from "../geo/coords";

const DEG = Math.PI / 180;

/** Lower = slower, gentler zoom per wheel notch (fraction of altitude per notch). */
const ZOOM_SENSITIVITY = 0.0011;
/** Smoothing rates (1 / seconds). Lower = slower, smoother. */
const ZOOM_LAMBDA = 6;
const ROT_LAMBDA = 11;

const MIN_ALTITUDE = CAMERA_SURFACE_DISTANCE - GLOBE_RADIUS;
const MAX_ALTITUDE = CAMERA_MAX_DISTANCE - GLOBE_RADIUS;

/**
 * Smoothed grab-to-cursor navigation. The camera stays on +Z looking at the
 * origin; only its distance changes (eased). All motion is globe rotation.
 *
 * Input math runs against a "target" state (targetQuat / targetDistance) for
 * stability, while the rendered globe eases toward it, so dragging and zooming
 * always look smooth. Zoom keeps the point under the cursor locked every frame.
 */
export function createNavigation(
  camera: PerspectiveCamera,
  dom: HTMLElement,
  globe: Object3D,
): { getDistance: () => number; update: (dt: number) => void; dispose: () => void } {
  const targetQuat = new Quaternion().copy(globe.quaternion);

  let targetDistance = Math.min(
    Math.max(camera.position.length(), CAMERA_SURFACE_DISTANCE),
    CAMERA_MAX_DISTANCE,
  );
  let dispDistance = targetDistance;

  let dragging = false;
  let activePointer = -1;
  let hasPointer = false;
  let nx = 0;
  let ny = 0;

  const grabLocal = new Vector3();
  const focusLocal = new Vector3();
  const worldHit = new Vector3();
  const curWorld = new Vector3();
  const q = new Quaternion();

  dom.style.touchAction = "none";

  function applyCamera() {
    camera.position.set(0, 0, dispDistance);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }
  applyCamera();

  function setNdc(clientX: number, clientY: number) {
    const rect = dom.getBoundingClientRect();
    nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    hasPointer = true;
  }

  /**
   * World-space unit direction of the globe surface point under the current
   * cursor NDC, for a camera at the given distance (independent of globe
   * rotation since the sphere is centered at the origin). Returns false on a
   * grazing miss so callers can skip unstable corrections.
   */
  function surfaceDirWorld(distance: number, out: Vector3): boolean {
    const th = Math.tan((camera.fov * DEG) / 2);
    out.set(nx * camera.aspect * th, ny * th, -1).normalize();
    const oz = distance;
    const b = oz * out.z;
    const c = oz * oz - GLOBE_RADIUS * GLOBE_RADIUS;
    const disc = b * b - c;
    const hit = disc >= 0;
    const t = hit ? -b - Math.sqrt(disc) : -b;
    out.set(out.x * t, out.y * t, oz + out.z * t).normalize();
    return hit;
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    setNdc(e.clientX, e.clientY);
    dragging = true;
    activePointer = e.pointerId;
    dom.setPointerCapture(e.pointerId);
    // Grab point computed in target space for stable, drift-free dragging.
    surfaceDirWorld(targetDistance, grabLocal);
    grabLocal.applyQuaternion(q.copy(targetQuat).invert()).normalize();
  };

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== activePointer) return;
    dragging = false;
    activePointer = -1;
    if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    setNdc(e.clientX, e.clientY);
    if (!dragging || e.pointerId !== activePointer) return;
    surfaceDirWorld(targetDistance, worldHit);
    curWorld.copy(grabLocal).applyQuaternion(targetQuat).normalize();
    q.setFromUnitVectors(curWorld, worldHit);
    targetQuat.premultiply(q).normalize();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    setNdc(e.clientX, e.clientY);
    // Scale ALTITUDE (distance above the surface), not the raw distance.
    // Near the surface distance is ~1.0, so multiplying distance makes one
    // tick change altitude enormously — the source of deep-zoom jerkiness.
    // Multiplying altitude gives uniform, smooth zoom at every depth.
    const altitude = targetDistance - GLOBE_RADIUS;
    const scaled = altitude * Math.exp(e.deltaY * ZOOM_SENSITIVITY);
    targetDistance =
      GLOBE_RADIUS +
      Math.min(Math.max(scaled, MIN_ALTITUDE), MAX_ALTITUDE);
  };

  dom.addEventListener("pointerdown", onPointerDown);
  dom.addEventListener("pointermove", onPointerMove);
  dom.addEventListener("pointerup", endDrag);
  dom.addEventListener("pointercancel", endDrag);
  dom.addEventListener("wheel", onWheel, { passive: false });

  return {
    getDistance: () => dispDistance,

    update(dt: number) {
      const zooming = Math.abs(dispDistance - targetDistance) > 1e-6;

      if (zooming && !dragging && hasPointer) {
        // Lock the point under the cursor while the zoom distance eases. Only
        // when the cursor ray actually hits the globe both before and after —
        // grazing misses near the surface would otherwise jolt the view.
        const hitBefore = surfaceDirWorld(dispDistance, focusLocal);
        focusLocal.applyQuaternion(q.copy(globe.quaternion).invert()).normalize();

        dispDistance = damp(dispDistance, targetDistance, ZOOM_LAMBDA, dt);
        applyCamera();

        const hitAfter = surfaceDirWorld(dispDistance, worldHit);
        if (hitBefore && hitAfter) {
          curWorld.copy(focusLocal).applyQuaternion(globe.quaternion).normalize();
          q.setFromUnitVectors(curWorld, worldHit);
          globe.quaternion.premultiply(q).normalize();
          targetQuat.premultiply(q).normalize();
        }
      } else {
        dispDistance = damp(dispDistance, targetDistance, ZOOM_LAMBDA, dt);
        applyCamera();
      }

      const a = 1 - Math.exp(-ROT_LAMBDA * dt);
      globe.quaternion.slerp(targetQuat, a);
      globe.updateMatrixWorld();
    },

    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", endDrag);
      dom.removeEventListener("pointercancel", endDrag);
      dom.removeEventListener("wheel", onWheel);
    },
  };
}
