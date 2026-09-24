import { BufferGeometry, Float32BufferAttribute } from "three";
import { feature } from "topojson-client";
import { geoGraticule, geoGraticule10 } from "d3-geo";
import type { Topology, GeometryCollection } from "topojson-specification";
import type {
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  Position,
} from "geojson";
import { latLonToVector3, GLOBE_RADIUS } from "./coords";

function pushRing(verts: number[], ring: Position[], r: number) {
  for (let i = 0; i < ring.length - 1; i++) {
    const a = latLonToVector3(ring[i][1], ring[i][0], r);
    const b = latLonToVector3(ring[i + 1][1], ring[i + 1][0], r);
    verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

function pushGeometry(verts: number[], geom: Geometry, r: number) {
  switch (geom.type) {
    case "Polygon":
      for (const ring of geom.coordinates) pushRing(verts, ring, r);
      break;
    case "MultiPolygon":
      for (const poly of geom.coordinates)
        for (const ring of poly) pushRing(verts, ring, r);
      break;
    case "LineString":
      pushRing(verts, geom.coordinates, r);
      break;
    case "MultiLineString":
      for (const line of geom.coordinates) pushRing(verts, line, r);
      break;
    default:
      break;
  }
}

export function buildCountryLines(
  topo: Topology,
  objectName: string = "countries",
  radius: number = GLOBE_RADIUS,
): BufferGeometry {
  const collection = feature(
    topo,
    topo.objects[objectName] as GeometryCollection,
  ) as FeatureCollection;

  const verts: number[] = [];
  for (const feat of collection.features) {
    pushGeometry(verts, feat.geometry, radius);
  }

  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(verts, 3));
  return geom;
}

export function buildGraticule(
  radius: number = GLOBE_RADIUS,
  stepDeg?: number,
): BufferGeometry {
  const graticule = stepDeg
    ? geoGraticule().step([stepDeg, stepDeg])()
    : geoGraticule10();
  const verts: number[] = [];
  pushGeometry(verts, graticule, radius);
  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(verts, 3));
  return geom;
}

export function buildLinesFromCollection(
  collection: FeatureCollection,
  radius: number,
  filter?: (props: GeoJsonProperties) => boolean,
): BufferGeometry {
  const verts: number[] = [];
  for (const feat of collection.features) {
    if (filter && !filter(feat.properties)) continue;
    if (!feat.geometry) continue;
    pushGeometry(verts, feat.geometry, radius);
  }
  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(verts, 3));
  return geom;
}

export function scalerankAtMost(maxRank: number) {
  return (props: GeoJsonProperties) => {
    const rank = props?.scalerank;
    return typeof rank === "number" && rank <= maxRank;
  };
}

const DEG = Math.PI / 180;

/** Unit direction matching latLonToVector3 (radius 1). */
function unitDir(lat: number, lon: number): [number, number, number] {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  const s = Math.sin(phi);
  return [-s * Math.cos(theta), Math.cos(phi), s * Math.sin(theta)];
}

/** Fast equirectangular reject: is a feature bbox entirely outside the focus cap? */
function bboxOutsideCap(
  bbox: number[],
  focusLat: number,
  focusLon: number,
  capDeg: number,
): boolean {
  const [w, s, e, n] = bbox;
  const clampLat = Math.max(s, Math.min(n, focusLat));
  const clampLon = Math.max(w, Math.min(e, focusLon));
  let dLon = Math.abs(focusLon - clampLon);
  if (dLon > 180) dLon = 360 - dLon;
  const dLat = focusLat - clampLat;
  const cosLat = Math.cos(focusLat * DEG);
  const dist = Math.sqrt(dLat * dLat + dLon * cosLat * (dLon * cosLat));
  return dist > capDeg;
}

function pushRingNear(
  verts: number[],
  ring: Position[],
  r: number,
  fx: number,
  fy: number,
  fz: number,
  cosCap: number,
) {
  let px = 0,
    py = 0,
    pz = 0,
    prevIn = false;
  for (let i = 0; i < ring.length; i++) {
    const [ux, uy, uz] = unitDir(ring[i][1], ring[i][0]);
    const inside = ux * fx + uy * fy + uz * fz > cosCap;
    if (i > 0 && (inside || prevIn)) {
      verts.push(px * r, py * r, pz * r, ux * r, uy * r, uz * r);
    }
    px = ux;
    py = uy;
    pz = uz;
    prevIn = inside;
  }
}

function pushGeometryNear(
  verts: number[],
  geom: Geometry,
  r: number,
  fx: number,
  fy: number,
  fz: number,
  cosCap: number,
) {
  switch (geom.type) {
    case "Polygon":
      for (const ring of geom.coordinates)
        pushRingNear(verts, ring, r, fx, fy, fz, cosCap);
      break;
    case "MultiPolygon":
      for (const poly of geom.coordinates)
        for (const ring of poly)
          pushRingNear(verts, ring, r, fx, fy, fz, cosCap);
      break;
    case "LineString":
      pushRingNear(verts, geom.coordinates, r, fx, fy, fz, cosCap);
      break;
    case "MultiLineString":
      for (const line of geom.coordinates)
        pushRingNear(verts, line, r, fx, fy, fz, cosCap);
      break;
    default:
      break;
  }
}

/**
 * Builds line geometry only for features within `capDeg` of the focus point.
 * Far features are skipped via bbox, and segments outside the cap are dropped,
 * so we never build the whole world — only what's under/around the view.
 */
export function buildLinesNear(
  collection: FeatureCollection,
  radius: number,
  focusLat: number,
  focusLon: number,
  capDeg: number,
  filter?: (props: GeoJsonProperties) => boolean,
): BufferGeometry {
  const verts: number[] = [];
  const cosCap = Math.cos(Math.min(capDeg, 179.5) * DEG);
  const [fx, fy, fz] = unitDir(focusLat, focusLon);

  for (const feat of collection.features) {
    if (filter && !filter(feat.properties)) continue;
    if (!feat.geometry) continue;
    const bbox = feat.bbox as number[] | undefined;
    if (bbox && bbox.length >= 4 && bboxOutsideCap(bbox, focusLat, focusLon, capDeg))
      continue;
    pushGeometryNear(verts, feat.geometry, radius, fx, fy, fz, cosCap);
  }

  const geom = new BufferGeometry();
  geom.setAttribute("position", new Float32BufferAttribute(verts, 3));
  return geom;
}
