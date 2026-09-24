import { Vector3 } from "three";

export const GLOBE_RADIUS = 1;
export const EARTH_RADIUS_KM = 6371;

const DEG = Math.PI / 180;

export function latLonToVector3(
  lat: number,
  lon: number,
  r: number = GLOBE_RADIUS,
): Vector3 {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}

export function vector3ToLatLon(v: Vector3): { lat: number; lon: number } {
  const r = v.length();
  const lat = 90 - Math.acos(v.y / r) / DEG;
  const lon = Math.atan2(v.z, -v.x) / DEG - 180;
  return {
    lat,
    lon: lon < -180 ? lon + 360 : lon,
  };
}

/** Approximate ground height (km) the viewport spans at this camera distance. */
export function screenSpanKm(cameraDistance: number, fovDeg: number): number {
  const halfH = (cameraDistance - GLOBE_RADIUS) * Math.tan((fovDeg * Math.PI) / 360);
  return Math.max(0, halfH * 2 * EARTH_RADIUS_KM);
}

/** Reticle ring radius as a consistent fraction of the visible area at any zoom. */
export function reticleRadiusKm(cameraDistance: number, fovDeg: number): number {
  return Math.max(0.02, screenSpanKm(cameraDistance, fovDeg) * 0.08);
}

export function kmToArcDeg(km: number): number {
  return (km / EARTH_RADIUS_KM) * (180 / Math.PI);
}

// Surface shell radii. All map geometry sits just above the globe surface (1.0);
// the occluder sits below it. The camera floor stays OUTSIDE the line shell so
// the near surface never ends up behind the camera (which blanked the view).
export const OCCLUDER_RADIUS = 0.998;
export const LINE_RADIUS = 1.0 + 6e-5;
export const RETICLE_RADIUS = 1.0 + 6e-5;

/** Frame-rate independent exponential smoothing toward a target. lambda = 1/timeConstant. */
export function damp(
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Angular half-size (deg) of the globe area visible from this camera distance, plus margin. */
export function visibleCapDeg(distance: number): number {
  const d = Math.max(distance, GLOBE_RADIUS * 1.0001);
  const limbRad = Math.acos(Math.min(1, GLOBE_RADIUS / d));
  return Math.min(170, (limbRad * 180) / Math.PI * 1.35 + 2);
}

export const CAMERA_MAX_DISTANCE = GLOBE_RADIUS * 5;
/** Close zoom floor — stays just outside the LINE_RADIUS shell. ~0.8km view span. */
export const CAMERA_SURFACE_DISTANCE = 1.0 + 1.5e-4;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Fades in as the camera moves closer (distance decreases). */
export function zoomFadeOpacity(
  distance: number,
  fadeInStart: number,
  fadeInEnd: number,
): number {
  return 1 - smoothstep(fadeInEnd, fadeInStart, distance);
}
