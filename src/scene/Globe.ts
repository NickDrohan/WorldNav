import {
  Group,
  LineSegments,
  LineBasicMaterial,
  SphereGeometry,
  Mesh,
  MeshBasicMaterial,
} from "three";
import { buildCountryLines, buildGraticule } from "../geo/buildGeometry";
import type { Topology } from "topojson-specification";
import { GLOBE_RADIUS, OCCLUDER_RADIUS, LINE_RADIUS } from "../geo/coords";

export const BLOOM_LAYER = 1;
export const SCENE_BACKGROUND = 0x020a0c;

export function createGlobe(topo: Topology): Group {
  const group = new Group();

  const occluder = new Mesh(
    new SphereGeometry(OCCLUDER_RADIUS, 64, 64),
    new MeshBasicMaterial({
      color: SCENE_BACKGROUND,
      depthWrite: true,
      depthTest: true,
    }),
  );
  occluder.renderOrder = 0;
  group.add(occluder);

  const countryGeom = buildCountryLines(topo, "countries", LINE_RADIUS);
  const countryLines = new LineSegments(
    countryGeom,
    new LineBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 0.85,
      depthTest: true,
      depthWrite: true,
    }),
  );
  countryLines.renderOrder = 1;
  countryLines.layers.enable(BLOOM_LAYER);
  group.add(countryLines);

  const gratGeom = buildGraticule(LINE_RADIUS);
  const gratLines = new LineSegments(
    gratGeom,
    new LineBasicMaterial({
      color: 0x0a2a2a,
      transparent: true,
      opacity: 0.25,
      depthTest: true,
      depthWrite: true,
    }),
  );
  gratLines.renderOrder = 1;
  group.add(gratLines);

  const hitSphere = new Mesh(
    new SphereGeometry(GLOBE_RADIUS, 64, 64),
    new MeshBasicMaterial({ visible: false }),
  );
  hitSphere.name = "hitSphere";
  hitSphere.renderOrder = 2;
  group.add(hitSphere);

  return group;
}
