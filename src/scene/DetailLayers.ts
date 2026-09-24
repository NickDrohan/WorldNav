import { Group, LineSegments, LineBasicMaterial } from "three";
import type { FeatureCollection } from "geojson";
import {
  buildGraticule,
  buildLinesNear,
  scalerankAtMost,
} from "../geo/buildGeometry";
import { zoomFadeOpacity, smoothstep, LINE_RADIUS } from "../geo/coords";
import { BLOOM_LAYER } from "./Globe";

export interface Focus {
  lat: number;
  lon: number;
  capDeg: number;
}

/** Min ms between geometry rebuilds per layer — prevents per-frame rebuild stutter. */
const REBUILD_MIN_MS = 140;

interface LayerConfig {
  id: string;
  url: string;
  color: number;
  baseOpacity: number;
  fadeInStart: number;
  fadeInEnd: number;
  /** Optional: fade back OUT as the camera zooms in past street scale. */
  fadeOutStart?: number;
  fadeOutEnd?: number;
  bloom?: boolean;
  maxScalerank?: (distance: number) => number;
}

const LAYER_CONFIGS: LayerConfig[] = [
  {
    id: "rivers50",
    url: "/data/ne_50m_rivers_lake_centerlines.geojson",
    color: 0x005566,
    baseOpacity: 0.45,
    fadeInStart: 3.2,
    fadeInEnd: 2.4,
    bloom: true,
  },
  {
    id: "rivers10",
    url: "/data/ne_10m_rivers_lake_centerlines.geojson",
    color: 0x007799,
    baseOpacity: 0.5,
    fadeInStart: 2.4,
    fadeInEnd: 1.75,
    bloom: true,
  },
  {
    id: "railroads",
    url: "/data/ne_10m_railroads.geojson",
    color: 0x3d5c4a,
    baseOpacity: 0.42,
    fadeInStart: 1.85,
    fadeInEnd: 1.35,
    fadeOutStart: 1.02,
    fadeOutEnd: 1.006,
    maxScalerank: scalerankForTransport,
  },
  {
    id: "roads",
    url: "/data/ne_10m_roads.geojson",
    color: 0x2a3d4d,
    baseOpacity: 0.38,
    fadeInStart: 1.85,
    fadeInEnd: 1.25,
    fadeOutStart: 1.02,
    fadeOutEnd: 1.006,
    maxScalerank: scalerankForTransport,
  },
];

/** Tiers above 1.28 unchanged; ranks 9–10 only when zooming past the previous min (~1.15). */
function scalerankForTransport(distance: number): number {
  if (distance > 1.55) return 0;
  if (distance > 1.4) return 4;
  if (distance > 1.28) return 6;
  if (distance > 1.18) return 8;
  if (distance > 1.1) return 9;
  return 10;
}

/** Minimum seconds for a layer to fade out / in — lines never blink away. */
const FADE_OUT_SECONDS = 0.8;
const FADE_IN_SECONDS = 0.6;

interface LayerState {
  config: LayerConfig;
  group: Group;
  lines: LineSegments | null;
  data: FeatureCollection | null;
  loading: boolean;
  builtKey: string;
  lastDistance: number;
  lastFocus: Focus;
  dispOpacity: number;
  lastBuild: number;
}

export class DetailLayers {
  readonly group = new Group();
  private layers = new Map<string, LayerState>();
  private fineGraticule: LineSegments;
  private fineOpacity = 0;

  constructor() {
    const fineGeom = buildGraticule(LINE_RADIUS, 10);
    this.fineGraticule = new LineSegments(
      fineGeom,
      new LineBasicMaterial({
        color: 0x0d2222,
        transparent: true,
        opacity: 0.15,
        depthTest: true,
        depthWrite: true,
      }),
    );
    this.fineGraticule.renderOrder = 1;
    this.fineGraticule.visible = false;
    this.group.add(this.fineGraticule);

    for (const config of LAYER_CONFIGS) {
      const layerGroup = new Group();
      layerGroup.name = config.id;
      this.group.add(layerGroup);
      this.layers.set(config.id, {
        config,
        group: layerGroup,
        lines: null,
        data: null,
        loading: false,
        builtKey: "",
        lastDistance: 3,
        lastFocus: { lat: 0, lon: 0, capDeg: 90 },
        dispOpacity: 0,
        lastBuild: 0,
      });
    }
  }

  update(cameraDistance: number, focus: Focus, dt: number) {
    const fineTarget = zoomFadeOpacity(cameraDistance, 2.1, 1.5) * 0.15;
    this.fineOpacity = approach(this.fineOpacity, fineTarget, 0.15, dt);
    this.fineGraticule.visible = this.fineOpacity > 0.003;
    (this.fineGraticule.material as LineBasicMaterial).opacity = this.fineOpacity;

    for (const state of this.layers.values()) {
      state.lastDistance = cameraDistance;
      state.lastFocus = focus;
      this.updateLayer(state, cameraDistance, focus, dt);
    }
  }

  private updateLayer(
    state: LayerState,
    distance: number,
    focus: Focus,
    dt: number,
  ) {
    const { config, group } = state;
    let want = zoomFadeOpacity(distance, config.fadeInStart, config.fadeInEnd);
    if (config.fadeOutStart != null && config.fadeOutEnd != null) {
      // 1 while above fadeOutStart, ramps to 0 by fadeOutEnd as we zoom in.
      want *= smoothstep(config.fadeOutEnd, config.fadeOutStart, distance);
    }
    const maxRank = config.maxScalerank?.(distance) ?? Infinity;
    if (config.maxScalerank && maxRank <= 0) want = 0;
    const targetOpacity = config.baseOpacity * want;

    // Ease opacity with a guaranteed minimum fade duration in either direction.
    state.dispOpacity = approach(
      state.dispOpacity,
      targetOpacity,
      config.baseOpacity,
      dt,
    );

    const visible = state.dispOpacity > 0.003;
    group.visible = visible;
    if (!visible && want <= 0) return;

    if (want > 0 && !state.data && !state.loading) {
      void this.loadLayer(state);
    }

    if (state.data && want > 0) {
      const key = this.buildKey(maxRank, focus);
      const now = performance.now();
      if (key !== state.builtKey && now - state.lastBuild > REBUILD_MIN_MS) {
        this.rebuildLines(state, maxRank, focus, key);
        state.lastBuild = now;
      }
    }

    if (state.lines) {
      (state.lines.material as LineBasicMaterial).opacity = state.dispOpacity;
    }
  }

  /** Quantize rank + focus + cap so we only rebuild when the view region shifts. */
  private buildKey(maxRank: number, focus: Focus): string {
    const step = Math.max(focus.capDeg * 0.25, 0.4);
    const la = Math.round(focus.lat / step);
    const lo = Math.round(focus.lon / step);
    const cap = Math.round(focus.capDeg);
    return `${maxRank}:${la}:${lo}:${cap}`;
  }

  private async loadLayer(state: LayerState) {
    state.loading = true;
    try {
      const resp = await fetch(state.config.url);
      state.data = (await resp.json()) as FeatureCollection;
      const distance = state.lastDistance;
      const focus = state.lastFocus;
      const maxRank = state.config.maxScalerank?.(distance) ?? Infinity;
      if (!state.config.maxScalerank || maxRank > 0) {
        this.rebuildLines(state, maxRank, focus, this.buildKey(maxRank, focus));
      }
    } catch (err) {
      console.warn(`Failed to load ${state.config.id}:`, err);
    } finally {
      state.loading = false;
    }
  }

  private rebuildLines(
    state: LayerState,
    maxRank: number,
    focus: Focus,
    key: string,
  ) {
    if (!state.data) return;

    if (state.lines) {
      state.lines.geometry.dispose();
      (state.lines.material as LineBasicMaterial).dispose();
      state.group.remove(state.lines);
      state.lines = null;
    }

    const filter = maxRank < Infinity ? scalerankAtMost(maxRank) : undefined;
    const geom = buildLinesNear(
      state.data,
      LINE_RADIUS,
      focus.lat,
      focus.lon,
      focus.capDeg,
      filter,
    );

    state.builtKey = key;

    if (geom.attributes.position.count === 0) return;

    const mat = new LineBasicMaterial({
      color: state.config.color,
      transparent: true,
      opacity: state.config.baseOpacity,
      depthTest: true,
      depthWrite: true,
    });

    const lines = new LineSegments(geom, mat);
    lines.renderOrder = 1;
    if (state.config.bloom) lines.layers.enable(BLOOM_LAYER);

    state.lines = lines;
    state.group.add(lines);
  }
}

/**
 * Move `current` toward `target`, rate-limited so a full `range` swing takes at
 * least FADE_OUT_SECONDS (decreasing) or FADE_IN_SECONDS (increasing). This
 * guarantees lines never appear or disappear faster than the minimum duration.
 */
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
