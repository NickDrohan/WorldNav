import { Scene, PerspectiveCamera, Color, Vector3, Quaternion } from "three";
import { createRenderer } from "./core/Renderer";
import { createPostFX } from "./core/PostFX";
import { createGlobe, SCENE_BACKGROUND } from "./scene/Globe";
import { createNavigation } from "./controls/Navigation";
import { DetailLayers } from "./scene/DetailLayers";
import { LocalMap } from "./scene/LocalMap";
import { Reticle } from "./cursor/Reticle";
import { Picker } from "./interaction/Picker";
import { Workbench } from "./ui/Workbench";
import { AgentPanel } from "./ui/AgentPanel";
import {
  GLOBE_RADIUS,
  EARTH_RADIUS_KM,
  visibleCapDeg,
  vector3ToLatLon,
  screenSpanKm,
} from "./geo/coords";
import type { Topology } from "topojson-specification";

async function init() {
  const resp = await fetch("/countries-110m.json");
  const topoData: Topology = await resp.json();

  const container = document.getElementById("app")!;

  const scene = new Scene();
  scene.background = new Color(SCENE_BACKGROUND);

  const camera = new PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.001,
    100,
  );
  camera.position.set(0, 0, 3);

  const renderer = createRenderer(container);
  const composer = createPostFX(renderer, scene, camera);

  const globe = createGlobe(topoData);
  scene.add(globe);

  const navigation = createNavigation(camera, renderer.domElement, globe);

  const detailLayers = new DetailLayers();
  globe.add(detailLayers.group);

  const localMap = new LocalMap();
  globe.add(localMap.group);

  const hitSphere = globe.getObjectByName("hitSphere")!;
  const picker = new Picker(camera, hitSphere, globe, renderer.domElement);
  const reticle = new Reticle();
  globe.add(reticle.group);

  const workbench = new Workbench(container);
  void workbench.loadFeedCatalog();

  // Left panel: cloud-agent prose digest, fed by the streamed briefing cells.
  const agentPanel = new AgentPanel(container);
  workbench.onSection = (chunk) => agentPanel.ingestSection(chunk);
  workbench.onClose = () => agentPanel.close();
  agentPanel.onClose = () => workbench.close();

  let downX = 0;
  let downY = 0;

  const canvas = renderer.domElement;

  canvas.addEventListener("pointerdown", (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });

  canvas.addEventListener("pointermove", (e) => {
    picker.updatePointer(e.clientX, e.clientY);
    reticle.updateCursor(e.clientX, e.clientY);
  });

  canvas.addEventListener("pointerup", (e) => {
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (dx * dx + dy * dy > 36) return;

    picker.updatePointer(e.clientX, e.clientY);
    const result = picker.pick();
    if (result) {
      // Capture the viewport state at click time so the orchestrator payload
      // can pick feed resolution / radius from the zoom tier.
      const dist = navigation.getDistance();
      const ctx = {
        lat: result.lat,
        lon: result.lon,
        radiusKm: result.radiusKm,
        altitudeKm: (dist - GLOBE_RADIUS) * EARTH_RADIUS_KM,
        viewportSpanKm: screenSpanKm(dist, camera.fov),
      };
      workbench.open(ctx);
      agentPanel.open(ctx);
    } else if (workbench.isOpen) {
      workbench.close();
    }
  });

  function onResize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  }
  window.addEventListener("resize", onResize);

  const _invQ = new Quaternion();
  const _focus = new Vector3();
  let lastTime = performance.now();

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    navigation.update(dt);

    const dist = navigation.getDistance();
    const altitude = dist - GLOBE_RADIUS;
    // Near/far scale with altitude so the close surface is never clipped at
    // deep zoom (which previously blanked the view).
    camera.near = Math.max(altitude * 0.25, 1e-6);
    camera.far = dist + GLOBE_RADIUS + 0.5;
    camera.updateProjectionMatrix();

    _invQ.copy(globe.quaternion).invert();
    _focus.set(0, 0, 1).applyQuaternion(_invQ);
    const focusLL = vector3ToLatLon(_focus);
    const spanKm = screenSpanKm(dist, camera.fov);

    const result = picker.pick();
    if (result) {
      reticle.update(result.lat, result.lon, result.radiusKm);
      reticle.setReadout(result.lat, result.lon);
    } else {
      reticle.hide();
      reticle.hideReadout();
    }

    detailLayers.update(
      dist,
      { lat: focusLL.lat, lon: focusLL.lon, capDeg: visibleCapDeg(dist) },
      dt,
    );
    localMap.update(
      {
        centerLat: focusLL.lat,
        centerLon: focusLL.lon,
        cursorLat: result ? result.lat : focusLL.lat,
        cursorLon: result ? result.lon : focusLL.lon,
        spanKm,
      },
      dt,
    );

    composer.render();
  }

  animate();
}

init();
