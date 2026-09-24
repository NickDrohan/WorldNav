import {
  Group,
  LineLoop,
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
} from "three";
import { geoCircle } from "d3-geo";
import { latLonToVector3, kmToArcDeg, RETICLE_RADIUS } from "../geo/coords";
import { BLOOM_LAYER } from "../scene/Globe";

export class Reticle {
  readonly group = new Group();
  private ring: LineLoop;
  private outerRing: LineLoop;
  private circleGen = geoCircle();
  private cursorEl: HTMLDivElement;
  private readoutEl: HTMLDivElement;

  constructor() {
    const ringMat = new LineBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.ring = new LineLoop(new BufferGeometry(), ringMat);
    this.ring.layers.enable(BLOOM_LAYER);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 10;
    this.group.add(this.ring);

    const outerMat = new LineBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.2,
      depthTest: false,
      depthWrite: false,
    });
    this.outerRing = new LineLoop(new BufferGeometry(), outerMat);
    this.outerRing.frustumCulled = false;
    this.outerRing.renderOrder = 10;
    this.group.add(this.outerRing);

    this.cursorEl = document.createElement("div");
    this.cursorEl.className = "reticle-cursor";
    document.body.appendChild(this.cursorEl);

    const dot = document.createElement("div");
    dot.className = "reticle-dot";
    this.cursorEl.appendChild(dot);

    for (let i = 0; i < 4; i++) {
      const tick = document.createElement("div");
      tick.className = `reticle-tick reticle-tick-${i}`;
      this.cursorEl.appendChild(tick);
    }

    // Live lat/lon readout that trails the cursor.
    this.readoutEl = document.createElement("div");
    this.readoutEl.className = "reticle-readout";
    this.cursorEl.appendChild(this.readoutEl);

    this.injectStyles();
    document.body.style.cursor = "none";
  }

  updateCursor(clientX: number, clientY: number) {
    this.cursorEl.style.left = `${clientX}px`;
    this.cursorEl.style.top = `${clientY}px`;
    // Flip the readout to the other side of the cursor near screen edges so it
    // never runs off-screen.
    this.readoutEl.classList.toggle("flip-x", clientX > window.innerWidth - 150);
    this.readoutEl.classList.toggle("flip-y", clientY > window.innerHeight - 40);
  }

  /** Show the geographic coordinate currently under the cursor. */
  setReadout(lat: number, lon: number) {
    const latHem = lat >= 0 ? "N" : "S";
    const lonHem = lon >= 0 ? "E" : "W";
    this.readoutEl.textContent = `${Math.abs(lat).toFixed(4)}°${latHem}  ${Math.abs(lon).toFixed(4)}°${lonHem}`;
    this.readoutEl.classList.add("show");
  }

  hideReadout() {
    this.readoutEl.classList.remove("show");
  }

  update(lat: number, lon: number, radiusKm: number) {
    this.group.visible = true;
    const arcDeg = kmToArcDeg(radiusKm);

    this.circleGen.center([lon, lat]).radius(arcDeg).precision(4);
    const coords = this.circleGen()!.coordinates[0];
    this.setRingGeometry(this.ring, coords);

    this.circleGen.radius(arcDeg * 1.2);
    const outerCoords = this.circleGen()!.coordinates[0];
    this.setRingGeometry(this.outerRing, outerCoords);
  }

  hide() {
    this.group.visible = false;
  }

  private setRingGeometry(line: LineLoop, coords: number[][]) {
    const verts: number[] = [];
    for (const [lon, lat] of coords) {
      const v = latLonToVector3(lat, lon, RETICLE_RADIUS);
      verts.push(v.x, v.y, v.z);
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new Float32BufferAttribute(verts, 3));
    line.geometry.dispose();
    line.geometry = geom;
  }

  private injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .reticle-cursor {
        position: fixed;
        pointer-events: none;
        width: 28px;
        height: 28px;
        transform: translate(-50%, -50%);
        z-index: 9999;
      }

      .reticle-cursor::before {
        content: '';
        position: absolute;
        inset: 0;
        border: 1px solid rgba(0, 255, 204, 0.5);
        border-radius: 50%;
        box-shadow: 0 0 10px rgba(0, 255, 204, 0.3),
                    inset 0 0 6px rgba(0, 255, 204, 0.15);
        animation: reticle-pulse 2s ease-in-out infinite;
      }

      .reticle-cursor::after {
        content: '';
        position: absolute;
        inset: -4px;
        border: 1px solid rgba(0, 255, 204, 0.15);
        border-radius: 50%;
        animation: reticle-pulse 2s ease-in-out infinite reverse;
      }

      .reticle-dot {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 2px;
        height: 2px;
        background: #00ffcc;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 6px #00ffcc;
      }

      .reticle-tick {
        position: absolute;
        background: rgba(0, 255, 204, 0.6);
      }
      .reticle-tick-0 { top: 50%; left: -2px; width: 5px; height: 1px; transform: translateY(-50%); }
      .reticle-tick-1 { top: 50%; right: -2px; width: 5px; height: 1px; transform: translateY(-50%); }
      .reticle-tick-2 { left: 50%; top: -2px; width: 1px; height: 5px; transform: translateX(-50%); }
      .reticle-tick-3 { left: 50%; bottom: -2px; width: 1px; height: 5px; transform: translateX(-50%); }

      .reticle-readout {
        position: absolute;
        top: 16px;
        left: 16px;
        padding: 2px 6px;
        font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
        font-size: 11px;
        letter-spacing: 0.5px;
        white-space: nowrap;
        color: #00ffcc;
        background: rgba(2, 12, 12, 0.7);
        border: 1px solid rgba(0, 255, 204, 0.2);
        border-radius: 3px;
        text-shadow: 0 0 6px rgba(0, 255, 204, 0.4);
        opacity: 0;
        transition: opacity 0.15s;
      }
      .reticle-readout.show { opacity: 1; }
      .reticle-readout.flip-x { left: auto; right: 16px; }
      .reticle-readout.flip-y { top: auto; bottom: 16px; }

      @keyframes reticle-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(1.08); }
      }
    `;
    document.head.appendChild(style);
  }
}
