import {
  PerspectiveCamera,
  Raycaster,
  Vector2,
  Vector3,
  Object3D,
} from "three";
import { vector3ToLatLon, reticleRadiusKm } from "../geo/coords";

export interface PickResult {
  lat: number;
  lon: number;
  radiusKm: number;
}

export class Picker {
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private hitTarget: Object3D;
  private camera: PerspectiveCamera;
  private globe: Object3D;
  private dom: HTMLElement;
  private localHit = new Vector3();

  hoverResult: PickResult | null = null;

  constructor(
    camera: PerspectiveCamera,
    hitTarget: Object3D,
    globe: Object3D,
    dom: HTMLElement,
  ) {
    this.camera = camera;
    this.hitTarget = hitTarget;
    this.globe = globe;
    this.dom = dom;
  }

  updatePointer(clientX: number, clientY: number) {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  pick(): PickResult | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.hitTarget);
    if (hits.length === 0) {
      this.hoverResult = null;
      return null;
    }

    // Convert the world-space hit into globe-local space so the lat/lon stays
    // correct no matter how the globe has been rotated by navigation.
    this.localHit.copy(hits[0].point);
    this.globe.worldToLocal(this.localHit);
    const { lat, lon } = vector3ToLatLon(this.localHit);
    const radiusKm = reticleRadiusKm(
      this.camera.position.length(),
      this.camera.fov,
    );

    this.hoverResult = { lat, lon, radiusKm };
    return this.hoverResult;
  }
}
