import { Group, LineSegments, LineBasicMaterial } from "three";
import type { Feature, FeatureCollection } from "geojson";
import { buildLinesFromCollection } from "../geo/buildGeometry";
import { kmToArcDeg, LINE_RADIUS } from "../geo/coords";
import { BLOOM_LAYER } from "./Globe";

/**
 * Tile-based local OSM streets + buildings. The view is split into a fixed
 * slippy-tile grid; each tile is fetched once from Overpass and cached in
 * memory, so panning/zooming reuses tiles instead of re-querying. Tiles load
 * nearest-the-cursor first and expand outward, so detail fills in from where
 * the user is looking.
 */
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** Span (km) below which local streets are fully shown / above which they vanish. */
const FULL_KM = 14;
const OFF_KM = 42;
/** Above this span tiles would be too coarse/large to be useful — stop loading. */
const MAX_QUERY_KM = 48;

const STREET_OPACITY = 0.85;
const BUILDING_OPACITY = 0.4;
const FADE_OUT_SECONDS = 0.8;
const FADE_IN_SECONDS = 0.6;

const MIN_TZ = 11;
const MAX_TZ = 16;
const TILE_MARGIN = 1;
const MAX_VISIBLE_TILES = 120;
const MAX_CACHED_TILES = 220;
const MAX_CONCURRENT = 2;
const REQUEST_MIN_MS = 250;
/** Re-attempt a failed tile no sooner than this. */
const RETRY_MS = 5000;

const DEG = Math.PI / 180;

export interface LocalView {
  centerLat: number;
  centerLon: number;
  cursorLat: number;
  cursorLon: number;
  spanKm: number;
}

interface BBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

interface Tile {
  key: string;
  group: Group;
  materials: LineBasicMaterial[];
  z: number;
  bbox: BBox;
  lastUsed: number;
}

interface Candidate {
  key: string;
  x: number;
  y: number;
  z: number;
  centerLat: number;
  centerLon: number;
  priority: number;
}

export class LocalMap {
  readonly group = new Group();
  private tiles = new Map<string, Tile>();
  private loading = new Set<string>();
  private failed = new Map<string, number>();
  private inflight = 0;
  private lastStart = 0;
  private dispOpacity = 0;

  update(view: LocalView, dt: number) {
    const want = 1 - smoothstep(FULL_KM, OFF_KM, view.spanKm);
    this.dispOpacity = approach(this.dispOpacity, want, 1, dt);
    this.group.visible = this.dispOpacity > 0.003;

    if (want <= 0 || view.spanKm > MAX_QUERY_KM) {
      for (const t of this.tiles.values()) t.group.visible = false;
      this.applyOpacity();
      return;
    }

    const z = tileZoomForSpan(view.spanKm, view.centerLat);
    const candidates = this.visibleTiles(view, z);
    const now = performance.now();
    const viewBB = viewBBox(view);

    // Is the current zoom level fully resolved for the view yet? (loaded or
    // known-empty/failed). Until it is, we keep older-zoom tiles on screen.
    const covered = candidates.every(
      (c) => this.tiles.has(c.key) || this.failed.has(c.key),
    );

    // Show every cached tile that overlaps the view. Older-zoom tiles stay
    // visible as a buffer during zoom and are only dropped once the current
    // zoom level has loaded — so the map never blanks while fetching.
    for (const tile of this.tiles.values()) {
      const inView = bboxIntersect(tile.bbox, viewBB);
      const superseded = covered && tile.z !== z;
      const vis = inView && !superseded;
      tile.group.visible = vis;
      if (vis) tile.lastUsed = now;
    }

    // Load missing current-zoom tiles, nearest the cursor first.
    const missing = candidates
      .filter((c) => !this.tiles.has(c.key) && !this.loading.has(c.key))
      .filter((c) => {
        const f = this.failed.get(c.key);
        return f === undefined || now - f > RETRY_MS;
      })
      .sort((a, b) => a.priority - b.priority);

    this.pump(missing);
    this.applyOpacity();
    this.evict();
  }

  private pump(queue: Candidate[]) {
    let i = 0;
    while (
      this.inflight < MAX_CONCURRENT &&
      i < queue.length &&
      performance.now() - this.lastStart >= REQUEST_MIN_MS
    ) {
      const c = queue[i++];
      if (this.loading.has(c.key) || this.tiles.has(c.key)) continue;
      this.lastStart = performance.now();
      void this.fetchTile(c);
    }
  }

  private async fetchTile(c: Candidate) {
    this.loading.add(c.key);
    this.inflight++;
    try {
      const bb = tileBBox(c.x, c.y, c.z);
      const query = `[out:json][timeout:25];(way["highway"](${bb.s},${bb.w},${bb.n},${bb.e});way["building"](${bb.s},${bb.w},${bb.n},${bb.e}););out geom;`;
      const resp = await fetch(OVERPASS_URL, {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
      const osm = await resp.json();
      this.addTile(c, osmSplit(osm));
      this.failed.delete(c.key);
    } catch (err) {
      this.failed.set(c.key, performance.now());
      console.warn("LocalMap tile:", c.key, err);
    } finally {
      this.loading.delete(c.key);
      this.inflight--;
    }
  }

  private addTile(
    c: Candidate,
    split: { streets: FeatureCollection; buildings: FeatureCollection },
  ) {
    const group = new Group();
    const materials: LineBasicMaterial[] = [];

    const street = this.makeLines(split.streets, 0x33ffdd, STREET_OPACITY, true);
    if (street) {
      group.add(street.lines);
      materials.push(street.mat);
    }
    const building = this.makeLines(
      split.buildings,
      0x2f6f7a,
      BUILDING_OPACITY,
      false,
    );
    if (building) {
      group.add(building.lines);
      materials.push(building.mat);
    }

    group.visible = false;
    this.group.add(group);
    this.tiles.set(c.key, {
      key: c.key,
      group,
      materials,
      z: c.z,
      bbox: tileBBox(c.x, c.y, c.z),
      lastUsed: performance.now(),
    });
    this.applyOpacity();
  }

  private makeLines(
    collection: FeatureCollection,
    color: number,
    baseOpacity: number,
    bloom: boolean,
  ): { lines: LineSegments; mat: LineBasicMaterial } | null {
    const geom = buildLinesFromCollection(collection, LINE_RADIUS);
    if (geom.attributes.position.count === 0) return null;
    const mat = new LineBasicMaterial({
      color,
      transparent: true,
      opacity: baseOpacity * this.dispOpacity,
      depthTest: true,
      depthWrite: true,
    });
    (mat as LineBasicMaterial & { __base: number }).__base = baseOpacity;
    const lines = new LineSegments(geom, mat);
    lines.renderOrder = 2;
    if (bloom) lines.layers.enable(BLOOM_LAYER);
    return { lines, mat };
  }

  private applyOpacity() {
    for (const tile of this.tiles.values()) {
      if (!tile.group.visible) continue;
      for (const mat of tile.materials) {
        const base = (mat as LineBasicMaterial & { __base: number }).__base;
        mat.opacity = base * this.dispOpacity;
      }
    }
  }

  private evict() {
    if (this.tiles.size <= MAX_CACHED_TILES) return;
    const sorted = [...this.tiles.values()]
      .filter((t) => !t.group.visible)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let toRemove = this.tiles.size - MAX_CACHED_TILES;
    for (const tile of sorted) {
      if (toRemove <= 0) break;
      this.disposeTile(tile);
      this.tiles.delete(tile.key);
      toRemove--;
    }
  }

  private disposeTile(tile: Tile) {
    this.group.remove(tile.group);
    tile.group.traverse((obj) => {
      const ls = obj as LineSegments;
      if (ls.geometry) ls.geometry.dispose();
      const m = ls.material as LineBasicMaterial | undefined;
      if (m && typeof m.dispose === "function") m.dispose();
    });
  }

  private visibleTiles(view: LocalView, z: number): Candidate[] {
    const halfLat = kmToArcDeg(view.spanKm / 2);
    const halfLon = halfLat / Math.max(0.2, Math.cos(view.centerLat * DEG));
    const north = view.centerLat + halfLat;
    const south = view.centerLat - halfLat;
    const west = view.centerLon - halfLon;
    const east = view.centerLon + halfLon;

    const xMin = lonToX(west, z) - TILE_MARGIN;
    const xMax = lonToX(east, z) + TILE_MARGIN;
    const yMin = latToY(north, z) - TILE_MARGIN;
    const yMax = latToY(south, z) + TILE_MARGIN;

    const out: Candidate[] = [];
    const n = Math.pow(2, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        if (y < 0 || y >= n) continue;
        const wx = ((x % n) + n) % n;
        const bb = tileBBox(wx, y, z);
        const cLat = (bb.s + bb.n) / 2;
        const cLon = (bb.w + bb.e) / 2;
        const dLat = cLat - view.cursorLat;
        let dLon = cLon - view.cursorLon;
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        const cosLat = Math.cos(view.cursorLat * DEG);
        const priority = dLat * dLat + dLon * cosLat * (dLon * cosLat);
        out.push({
          key: `${z}/${wx}/${y}`,
          x: wx,
          y,
          z,
          centerLat: cLat,
          centerLon: cLon,
          priority,
        });
        if (out.length >= MAX_VISIBLE_TILES) return out;
      }
    }
    return out;
  }
}

function tileZoomForSpan(spanKm: number, lat: number): number {
  const targetTileKm = Math.max(spanKm / 2.5, 0.4);
  const circumferenceKm = 40075 * Math.cos(lat * DEG);
  const z = Math.round(
    Math.log2(Math.max(1, circumferenceKm / targetTileKm)),
  );
  return Math.max(MIN_TZ, Math.min(MAX_TZ, z));
}

function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

function latToY(lat: number, z: number): number {
  const r = lat * DEG;
  return Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) *
      Math.pow(2, z),
  );
}

function tileBBox(
  x: number,
  y: number,
  z: number,
): { s: number; w: number; n: number; e: number } {
  const n = Math.pow(2, z);
  const w = (x / n) * 360 - 180;
  const e = ((x + 1) / n) * 360 - 180;
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const south =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { s: south, w, n: north, e };
}

function viewBBox(view: LocalView): BBox {
  const halfLat = kmToArcDeg(view.spanKm / 2);
  const halfLon = halfLat / Math.max(0.2, Math.cos(view.centerLat * DEG));
  return {
    s: view.centerLat - halfLat,
    n: view.centerLat + halfLat,
    w: view.centerLon - halfLon,
    e: view.centerLon + halfLon,
  };
}

function bboxIntersect(a: BBox, b: BBox): boolean {
  return a.w <= b.e && a.e >= b.w && a.s <= b.n && a.n >= b.s;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function approach(
  current: number,
  target: number,
  range: number,
  dt: number,
): number {
  if (current === target) return target;
  const seconds = target < current ? FADE_OUT_SECONDS : FADE_IN_SECONDS;
  const maxStep = (range / seconds) * Math.min(dt, 0.05);
  const delta = target - current;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}

interface OsmElement {
  type: string;
  geometry?: { lat: number; lon: number }[];
  tags?: { highway?: string; building?: string };
}

function osmSplit(osm: { elements?: OsmElement[] }): {
  streets: FeatureCollection;
  buildings: FeatureCollection;
} {
  const streets: Feature[] = [];
  const buildings: Feature[] = [];
  for (const el of osm.elements ?? []) {
    if (el.type !== "way" || !el.geometry?.length) continue;
    const coords = el.geometry.map((g) => [g.lon, g.lat]);
    const feature: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    };
    if (el.tags?.highway) streets.push(feature);
    else if (el.tags?.building) buildings.push(feature);
  }
  return {
    streets: { type: "FeatureCollection", features: streets },
    buildings: { type: "FeatureCollection", features: buildings },
  };
}
