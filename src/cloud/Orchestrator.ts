import { EARTH_RADIUS_KM } from "../geo/coords";
import { radiusToBBox, geohashEncode, precisionForRadius, zoomTierForSpan } from "./geo";
import {
  ORCHESTRATOR_PROTOCOL,
  RESPONSE_SHAPE,
  AGENT_INGEST_PROTOCOL,
  BRIEFING_SHAPE,
  type AgentIngestPayload,
  type AggregateStats,
  type BriefingChunk,
  type BriefingFormat,
  type BriefingSection,
  type Citation,
  type CloudFeature,
  type CloudStreamChunk,
  type FeedCollectionStat,
  type FeedHealthState,
  type FeedSelector,
  type GeoArea,
  type MetricChip,
  type OrchestratorRequest,
  type ReportDomain,
  type ReportWindow,
  type Severity,
  type ZoomTier,
} from "./types";

/** Catalog shape as stored in public/feed-catalog.json. */
export interface FeedEntry {
  name: string;
  provider: string;
  format: string;
  endpoint: string;
  note?: string;
}
export interface FeedCategory {
  id: string;
  name: string;
  feeds: FeedEntry[];
}
export interface FeedCatalog {
  title: string;
  doc?: string;
  polling?: { intervalSec: number; userAgent?: string };
  categories: FeedCategory[];
}

/** The viewport state captured at the moment of the click. */
export interface QueryContext {
  lat: number;
  lon: number;
  radiusKm: number;
  altitudeKm: number;
  viewportSpanKm: number;
}

export interface DispatchHandlers {
  /** Stage 1: a raw-feed chunk landed (ranked + capped for display). */
  onChunk: (chunk: CloudStreamChunk) => void;
  /** Stage 1→2 boundary: all feeds collected and aggregated into one payload. */
  onAggregate?: (payload: AgentIngestPayload) => void;
  /** Stage 2: a synthesized briefing section landed. */
  onBriefing?: (chunk: BriefingChunk) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

interface OrchestratorOptions {
  catalog: FeedCatalog;
  sessionId: string;
  appVersion: string;
  /** Real orchestrator (stage 1) endpoint. When absent, the local simulator runs. */
  endpoint?: string;
  /** Cloud agent (stage 2) ingestion endpoint. When absent, the simulator runs. */
  agentEndpoint?: string;
}

const RESOLVE_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

/* --------------------------- reliability tuning --------------------------- */

const MAX_ATTEMPTS = 3;
/** Consecutive failed cycles before the circuit opens and the feed goes offline. */
const CIRCUIT_THRESHOLD = 3;
/** How long a tripped circuit stays open before we probe the feed again. */
const CIRCUIT_COOLDOWN_MS = 45_000;

/** Per-endpoint timeout budgets — fast JSON APIs vs slow/rate-limited ones. */
const DEADLINE_FAST = 1_000;
const DEADLINE_MODERATE = 3_000;
const DEADLINE_SLOW = 10_000;

/** Providers/endpoints known to be slow or rate-limited get the generous budget. */
const SLOW_HINTS = ["tfl", "waqi", "opensky", "overpass", "sec.gov", "gdacs", "nhc"];
/** Aggregators / multi-hop services get the middle budget. */
const MODERATE_HINTS = [
  "aviationweather", "govinfo", "federalregister", "congress", "usaspending",
  "eonet", "seismicportal", "tsunami", "mbta", "gbfs",
];

/** Recency envelope per category (seconds) — civic/map age slower than sensors. */
const CADENCE_MAX_AGE_SEC: Record<string, number> = {
  environmental: 600,
  safety: 300,
  transit: 180,
  civic: 5_400,
  map: 86_400,
};

/** Graceful-degradation pairs: if the key feed fails, note the sibling cover. */
const FALLBACK_BY_NAME: Array<{ match: string; via: string }> = [
  { match: "USGS Earthquakes", via: "EMSC Seismic" },
  { match: "USGS FDSN", via: "EMSC Seismic" },
  { match: "Open-Meteo Air Quality", via: "WAQI Air Quality" },
];

interface FeedHealthEntry {
  consecutiveFailures: number;
  circuitOpenUntil: number;
}

/**
 * Relevance matrix: which feed categories matter most at each zoom tier.
 * Drives the `priority` hint so the cloud can spend its time budget wisely
 * (e.g. street-level cares about transit; orbital cares about hazards).
 */
const CATEGORY_PRIORITY: Record<ZoomTier, Record<string, FeedSelector["priority"]>> = {
  orbital: { safety: "high", environmental: "normal", civic: "low", transit: "low", map: "low" },
  regional: { safety: "high", environmental: "high", civic: "normal", transit: "low", map: "normal" },
  metro: { environmental: "high", safety: "high", transit: "normal", civic: "normal", map: "normal" },
  street: { transit: "high", environmental: "high", map: "high", safety: "normal", civic: "low" },
};

export class CloudOrchestrator {
  private opts: OrchestratorOptions;
  /** Per-feed reliability state, persisted across refresh cycles. */
  private health = new Map<string, FeedHealthEntry>();

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
  }

  private healthFor(feedId: string): FeedHealthEntry {
    let h = this.health.get(feedId);
    if (!h) {
      h = { consecutiveFailures: 0, circuitOpenUntil: 0 };
      this.health.set(feedId, h);
    }
    return h;
  }

  /** Assemble the declarative request document for a click. */
  buildRequest(ctx: QueryContext): OrchestratorRequest {
    const { lat, lon, radiusKm, altitudeKm, viewportSpanKm } = ctx;
    const zoomTier = zoomTierForSpan(viewportSpanKm);

    const area: GeoArea = {
      center: { lat, lon },
      radiusKm,
      bbox: radiusToBBox(lat, lon, radiusKm),
      geohash: geohashEncode(lat, lon, precisionForRadius(radiusKm)),
      altitudeKm,
      viewportSpanKm,
      zoomTier,
    };

    const priorities = CATEGORY_PRIORITY[zoomTier];
    const selectors: FeedSelector[] = this.opts.catalog.categories.map((cat) => ({
      categoryId: cat.id,
      feedIds: ["*"],
      priority: priorities[cat.id] ?? "normal",
    }));

    // Tighter zoom → fewer, closer, fresher results; wide zoom → more, ranked by severity.
    const maxResults = zoomTier === "street" ? 40 : zoomTier === "metro" ? 60 : 80;

    return {
      protocol: ORCHESTRATOR_PROTOCOL,
      requestId: cryptoRandomId(),
      issuedAt: new Date().toISOString(),
      client: {
        app: "WorldNav",
        version: this.opts.appVersion,
        sessionId: this.opts.sessionId,
        userAgent: navigator.userAgent,
      },
      area,
      selectors,
      response: {
        shape: RESPONSE_SHAPE,
        delivery: "stream",
        maxResults,
        maxPerCategory: 12,
        rankBy: zoomTier === "street" || zoomTier === "metro" ? "distance" : "severity",
        dedupe: true,
        groupByCategory: true,
        units: "metric",
        timeBudgetMs: 8000,
        lang: (navigator.language || "en").slice(0, 2),
      },
      poll: {
        intervalSec: this.opts.catalog.polling?.intervalSec ?? 3600,
        mode: "snapshot",
      },
    };
  }

  /**
   * Fetch the region briefing.
   *
   * LIVE (endpoint set): `POST /orchestrate` streams the 15 briefing sections
   * (3 domains × 5 windows) directly — the cloud does collection + synthesis.
   * We scaffold the grid via a lightweight `onAggregate`, then forward each
   * streamed {@link BriefingChunk} to `onBriefing`.
   *
   * OFFLINE (no endpoint): the local simulator collects mock features and
   * synthesizes an equivalent 3×5 briefing so the UX is identical.
   */
  async dispatch(req: OrchestratorRequest, handlers: DispatchHandlers): Promise<void> {
    if (this.opts.endpoint) {
      try {
        await this.dispatchLive(req, handlers);
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        handlers.onError?.(err as Error);
        // fall through to the local simulator
      }
    }

    const t0 = performance.now();
    const { collected, stats } = await this.simulateCollection(req, handlers);
    if (handlers.signal?.aborted) return;
    const payload = this.buildIngestPayload(
      req,
      collected,
      stats,
      Math.round(performance.now() - t0),
    );
    handlers.onAggregate?.(payload);
    await simulateBriefing(payload, handlers);
  }

  /** Live path: stream the 15 briefings straight from the cloud `/orchestrate`. */
  private async dispatchLive(
    req: OrchestratorRequest,
    handlers: DispatchHandlers,
  ): Promise<void> {
    // Lay out the empty 3×5 grid + left panel before the first line arrives.
    handlers.onAggregate?.(this.buildScaffoldPayload(req));

    // The cloud accepts the simple {lat,lng,zoom} shape (recommended).
    const body = {
      requestId: req.requestId,
      lat: req.area.center.lat,
      lng: req.area.center.lon,
      zoom: zoomTierToNumber(req.area.zoomTier),
    };

    const resp = await fetch(this.opts.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      signal: handlers.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`orchestrate ${resp.status}`);

    await readNdjson<BriefingChunk>(resp.body, (chunk) => {
      if (handlers.signal?.aborted) return;
      handlers.onBriefing?.(chunk);
    });
  }

  /** Minimal payload so the panel can scaffold the grid without a feed sweep. */
  private buildScaffoldPayload(req: OrchestratorRequest): AgentIngestPayload {
    const now = new Date().toISOString();
    return {
      protocol: AGENT_INGEST_PROTOCOL,
      requestId: req.requestId,
      issuedAt: now,
      area: req.area,
      collection: {
        completedAt: now,
        stats: {
          feedsTotal: 0, feedsOk: 0, feedsEmpty: 0, feedsError: 0,
          featureCount: 0, byCategory: {},
          bySeverity: { info: 0, advisory: 0, watch: 0, warning: 0, critical: 0 },
          collectionMs: 0,
        },
        feeds: [],
      },
      features: [],
      groups: {},
      briefing: buildBriefingFormat(req),
    };
  }

  private async collectHttp(
    req: OrchestratorRequest,
    handlers: DispatchHandlers,
  ): Promise<{ collected: CloudFeature[]; stats: FeedCollectionStat[] }> {
    const resp = await fetch(this.opts.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(req),
      signal: handlers.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`orchestrator ${resp.status}`);

    const byId = new Map<string, CloudFeature>();
    await readNdjson<CloudStreamChunk>(resp.body, (chunk) => {
      for (const f of chunk.features) byId.set(f.id, f);
      handlers.onChunk(chunk);
    });

    const collected = [...byId.values()];
    return { collected, stats: deriveFeedStats(this.resolveFeeds(req), collected) };
  }

  /**
   * Local stand-in for stage 1. Emits plausible features per feed on a
   * deliberately spread-out schedule so the UI fills calmly, and records a
   * per-feed collection stat so the aggregate payload reports real coverage.
   */
  private async simulateCollection(
    req: OrchestratorRequest,
    handlers: DispatchHandlers,
  ): Promise<{ collected: CloudFeature[]; stats: FeedCollectionStat[] }> {
    const feeds = this.resolveFeeds(req);
    const total = feeds.length;
    let returned = 0;
    const all: CloudFeature[] = [];
    const stats: FeedCollectionStat[] = [];

    // Spread emissions across ~70% of the budget so later feeds still land
    // before the deadline and the panel fills at a readable pace.
    const window = req.response.timeBudgetMs * 0.7;
    const step = Math.max(180, window / Math.max(total, 1));

    for (let i = 0; i < feeds.length; i++) {
      if (handlers.signal?.aborted) return { collected: all, stats };
      await delay(step + jitter(120));
      if (handlers.signal?.aborted) return { collected: all, stats };

      const { category, feed } = feeds[i];
      const stat = await this.pollFeed(category, feed, req.area, i);
      all.push(...(stat._batch ?? []));
      delete stat._batch;
      stats.push(stat);
      returned++;

      handlers.onChunk({
        meta: {
          requestId: req.requestId,
          status: i === feeds.length - 1 ? "complete" : "partial",
          feedsQueried: total,
          feedsReturned: returned,
          generatedAt: new Date().toISOString(),
        },
        features: rankAndCap(all, req),
      });
    }
    return { collected: all, stats };
  }

  /**
   * Poll a single feed with a per-endpoint deadline, bounded retries with
   * exponential backoff, and a circuit breaker. Updates persisted health so
   * a feed that fails repeatedly is marked offline and skipped (rather than
   * stalling every refresh), then probed again after a cooldown.
   */
  private async pollFeed(
    category: string,
    feed: FeedEntry,
    area: GeoArea,
    seed: number,
  ): Promise<FeedCollectionStat & { _batch?: CloudFeature[] }> {
    const health = this.healthFor(feed.name);
    const deadlineMs = deadlineFor(feed);
    const now = Date.now();

    // Circuit open → skip the call entirely so a dead feed can't block the sweep.
    if (health.circuitOpenUntil > now) {
      return {
        feedId: feed.name,
        category,
        provider: feed.provider,
        status: "offline",
        health: "offline",
        attempts: 0,
        consecutiveFailures: health.consecutiveFailures,
        deadlineMs,
        featureCount: 0,
        error: `circuit open · retry in ${Math.ceil((health.circuitOpenUntil - now) / 1000)}s`,
        fallback: fallbackFor(feed.name),
      };
    }

    let attempts = 0;
    let batch: CloudFeature[] = [];
    let failKind: "timeout" | "error" | undefined;
    let lastLatency = 0;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      lastLatency = simLatency(feed);
      failKind = undefined;

      if (lastLatency > deadlineMs) {
        failKind = "timeout";
      } else if (Math.random() < errorRate(feed)) {
        failKind = "error";
      } else {
        batch = synthFeatures(category, feed, area, seed);
        break;
      }
      // Exponential backoff between attempts (kept short so the demo stays brisk).
      if (attempts < MAX_ATTEMPTS) await delay(120 * Math.pow(2, attempts - 1));
    }

    const succeeded = !failKind;
    if (succeeded) {
      health.consecutiveFailures = 0;
      health.circuitOpenUntil = 0;
    } else {
      health.consecutiveFailures++;
      if (health.consecutiveFailures >= CIRCUIT_THRESHOLD) {
        health.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      }
    }

    const healthState: FeedHealthState = succeeded
      ? "healthy"
      : health.consecutiveFailures >= CIRCUIT_THRESHOLD
        ? "offline"
        : "degraded";

    return {
      feedId: feed.name,
      category,
      provider: feed.provider,
      status: succeeded ? (batch.length ? "ok" : "empty") : failKind!,
      health: healthState,
      attempts,
      consecutiveFailures: health.consecutiveFailures,
      deadlineMs,
      latencyMs: Math.round(lastLatency),
      featureCount: batch.length,
      observedAt: newestObserved(batch),
      error: succeeded
        ? undefined
        : failKind === "timeout"
          ? `deadline ${deadlineMs}ms exceeded (${Math.round(lastLatency)}ms)`
          : "upstream 503",
      fallback: succeeded ? undefined : fallbackFor(feed.name),
      _batch: batch,
    };
  }

  /** Roll the collected sweep into the agent ingestion payload. */
  private buildIngestPayload(
    req: OrchestratorRequest,
    collected: CloudFeature[],
    stats: FeedCollectionStat[],
    collectionMs: number,
  ): AgentIngestPayload {
    const groups: Record<string, CloudFeature[]> = {};
    const bySeverity: Record<Severity, number> = {
      info: 0, advisory: 0, watch: 0, warning: 0, critical: 0,
    };
    let newest: string | undefined;
    let oldest: string | undefined;
    let nearest: number | undefined;

    for (const f of collected) {
      (groups[f.category] ??= []).push(f);
      bySeverity[f.severity ?? "info"]++;
      if (f.observedAt) {
        if (!newest || f.observedAt > newest) newest = f.observedAt;
        if (!oldest || f.observedAt < oldest) oldest = f.observedAt;
      }
      if (f.distanceKm != null && (nearest == null || f.distanceKm < nearest)) {
        nearest = f.distanceKm;
      }
    }

    const byCategory: Record<string, number> = {};
    for (const k of Object.keys(groups)) byCategory[k] = groups[k].length;

    const aggregate: AggregateStats = {
      feedsTotal: stats.length,
      feedsOk: stats.filter((s) => s.status === "ok").length,
      feedsEmpty: stats.filter((s) => s.status === "empty").length,
      feedsError: stats.filter((s) => s.status === "error" || s.status === "timeout").length,
      featureCount: collected.length,
      byCategory,
      bySeverity,
      nearestKm: nearest != null ? Number(nearest.toFixed(2)) : undefined,
      newestObservedAt: newest,
      oldestObservedAt: oldest,
      collectionMs,
    };

    return {
      protocol: AGENT_INGEST_PROTOCOL,
      requestId: req.requestId,
      issuedAt: new Date().toISOString(),
      area: req.area,
      collection: { completedAt: new Date().toISOString(), stats: aggregate, feeds: stats },
      features: collected,
      groups,
      briefing: buildBriefingFormat(req),
    };
  }

  /** Stage 2: hand the payload to the cloud agent and stream back the briefing. */
  private async brief(payload: AgentIngestPayload, handlers: DispatchHandlers): Promise<void> {
    if (this.opts.agentEndpoint) {
      try {
        await this.briefHttp(payload, handlers);
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        handlers.onError?.(err as Error);
      }
    }
    await simulateBriefing(payload, handlers);
  }

  private async briefHttp(payload: AgentIngestPayload, handlers: DispatchHandlers): Promise<void> {
    const resp = await fetch(this.opts.agentEndpoint!, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(payload),
      signal: handlers.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`agent ${resp.status}`);
    await readNdjson<BriefingChunk>(resp.body, (chunk) => handlers.onBriefing?.(chunk));
  }

  /** Flatten selected categories into the concrete feeds to poll. */
  private resolveFeeds(req: OrchestratorRequest): { category: string; feed: FeedEntry }[] {
    const out: { category: string; feed: FeedEntry }[] = [];
    const selectors = [...req.selectors].sort(
      (a, b) => RESOLVE_ORDER[a.priority] - RESOLVE_ORDER[b.priority],
    );
    for (const sel of selectors) {
      const cat = this.opts.catalog.categories.find((c) => c.id === sel.categoryId);
      if (!cat) continue;
      const wantsAll = sel.feedIds[0] === "*";
      for (const feed of cat.feeds) {
        if (wantsAll || sel.feedIds.includes(feed.name)) {
          out.push({ category: cat.id, feed });
        }
      }
    }
    return out;
  }
}

/* --------------------------- reliability helpers -------------------------- */

/** Assign a timeout budget from the feed's endpoint/provider characteristics. */
function deadlineFor(feed: FeedEntry): number {
  const hay = `${feed.endpoint} ${feed.provider} ${feed.name}`.toLowerCase();
  if (SLOW_HINTS.some((h) => hay.includes(h))) return DEADLINE_SLOW;
  if (MODERATE_HINTS.some((h) => hay.includes(h))) return DEADLINE_MODERATE;
  return DEADLINE_FAST;
}

/** Simulated round-trip latency (ms), occasionally spiking past the deadline. */
function simLatency(feed: FeedEntry): number {
  const d = deadlineFor(feed);
  const spike = Math.random() < 0.12;
  if (d === DEADLINE_SLOW) {
    return spike ? 10_500 + Math.random() * 4_000 : 1_500 + Math.random() * 5_000;
  }
  if (d === DEADLINE_MODERATE) {
    return spike ? 3_400 + Math.random() * 2_000 : 500 + Math.random() * 1_900;
  }
  return spike ? 1_100 + Math.random() * 900 : 150 + Math.random() * 650;
}

/** Baseline transient-error (503) probability per cycle. */
function errorRate(feed: FeedEntry): number {
  const hay = `${feed.endpoint} ${feed.provider}`.toLowerCase();
  // Public/demo-token endpoints are flakier.
  return hay.includes("waqi") || hay.includes("opensky") ? 0.12 : 0.05;
}

function fallbackFor(feedName: string): string | undefined {
  return FALLBACK_BY_NAME.find((f) => feedName.includes(f.match))?.via;
}

/** Map our zoom tier to the cloud's numeric `zoom` (scales governance law tier). */
function zoomTierToNumber(tier: ZoomTier): number {
  switch (tier) {
    case "orbital": return 2;
    case "regional": return 5;
    case "metro": return 9;
    case "street": return 13;
    default: return 9;
  }
}

/* ----------------------------- simulator data ----------------------------- */

function rankAndCap(features: CloudFeature[], req: OrchestratorRequest): CloudFeature[] {
  const sevRank: Record<string, number> = {
    critical: 0, warning: 1, watch: 2, advisory: 3, info: 4,
  };
  const sorted = [...features].sort((a, b) => {
    if (req.response.rankBy === "distance") {
      return (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9);
    }
    if (req.response.rankBy === "severity") {
      return (sevRank[a.severity ?? "info"] ?? 9) - (sevRank[b.severity ?? "info"] ?? 9);
    }
    return (b.observedAt ?? "").localeCompare(a.observedAt ?? "");
  });

  if (!req.response.groupByCategory) return sorted.slice(0, req.response.maxResults);

  const perCat = new Map<string, number>();
  const capped: CloudFeature[] = [];
  for (const f of sorted) {
    const n = perCat.get(f.category) ?? 0;
    if (n >= req.response.maxPerCategory) continue;
    perCat.set(f.category, n + 1);
    capped.push(f);
    if (capped.length >= req.response.maxResults) break;
  }
  return capped;
}

const KIND_BY_CATEGORY: Record<string, string[]> = {
  environmental: ["observation", "forecast", "reading"],
  safety: ["alert", "quake", "advisory"],
  civic: ["filing", "notice", "bill"],
  transit: ["vehicle", "status", "delay"],
  map: ["feature", "way", "node"],
};

const SEVERITIES: CloudFeature["severity"][] = [
  "info", "advisory", "watch", "warning", "critical",
];

/** Draw a record age (seconds), skewed toward fresh, capped by category cadence. */
function observedAgeSec(category: string): number {
  const maxAge = CADENCE_MAX_AGE_SEC[category] ?? 600;
  return Math.random() * Math.random() * maxAge;
}

function synthFeatures(
  category: string,
  feed: FeedEntry,
  area: GeoArea,
  seed: number,
): CloudFeature[] {
  const count = 1 + (Math.abs(hash(feed.name + seed)) % 3);
  const kinds = KIND_BY_CATEGORY[category] ?? ["feature"];
  const out: CloudFeature[] = [];
  for (let i = 0; i < count; i++) {
    const h = hash(feed.name + seed + ":" + i);
    const distanceKm = (Math.abs(h) % 1000) / 1000 * area.radiusKm;
    const bearing = (Math.abs(h >> 3) % 360) * (Math.PI / 180);
    const dLat = (distanceKm / EARTH_RADIUS_KM) * (180 / Math.PI) * Math.cos(bearing);
    const dLon = (distanceKm / EARTH_RADIUS_KM) * (180 / Math.PI) * Math.sin(bearing);
    out.push({
      id: `${feed.name}:${seed}:${i}`,
      category,
      source: feed.provider,
      kind: kinds[Math.abs(h) % kinds.length],
      title: `${feed.name} #${(Math.abs(h) % 900) + 100}`,
      summary: `Aggregated from ${feed.provider} (${feed.format}).`,
      lat: area.center.lat + dLat,
      lon: area.center.lon + dLon,
      distanceKm: Number(distanceKm.toFixed(2)),
      severity: category === "safety" ? SEVERITIES[Math.abs(h) % SEVERITIES.length] : "info",
      // Recency is re-drawn every cycle (skewed fresh) within the category's
      // cadence envelope, so freshness ticks on refresh instead of sticking.
      observedAt: new Date(
        Date.now() - Math.floor(observedAgeSec(category) * 1000),
      ).toISOString(),
      link: feed.endpoint,
    });
  }
  return out;
}

/* --------------------------- briefing simulator --------------------------- */

const DOMAINS3: ReportDomain[] = ["science", "governance", "social"];
const WINDOWS5: ReportWindow[] = ["hour", "day", "week", "month", "year"];

const DOMAIN_LABEL: Record<ReportDomain, string> = {
  science: "Science & Sky",
  governance: "Governance",
  social: "Social & News",
};

const DOMAIN_ACCENT: Record<ReportDomain, string> = {
  science: "#38bdf8",
  governance: "#a78bfa",
  social: "#fb7185",
};

const WINDOW_LABEL: Record<ReportWindow, string> = {
  hour: "Past hour",
  day: "Past day",
  week: "Past week",
  month: "Past month",
  year: "Past year",
};

/** Which simulated catalog categories feed each domain (offline only). */
const CATEGORIES_FOR_DOMAIN: Record<ReportDomain, string[]> = {
  science: ["environmental", "safety", "map"],
  governance: ["civic"],
  social: ["transit"],
};

/** The 3×5 briefing the orchestrator requests back (mirrors the live cloud). */
function buildBriefingFormat(req: OrchestratorRequest): BriefingFormat {
  return {
    shape: BRIEFING_SHAPE,
    delivery: "stream",
    domains: DOMAINS3,
    windows: WINDOWS5,
    section: {
      maxSummaryWords: 60,
      maxBullets: 4,
      includeMetrics: true,
      requireCitations: true,
      tone: "briefing",
      readingLevel: "general",
    },
    units: req.response.units,
    lang: req.response.lang,
    timeBudgetMs: 6000,
  };
}

/**
 * Offline stand-in for the cloud: synthesizes 3 domains × 5 windows = 15
 * sections and streams them domain-major, window-minor with a `report` header
 * on the first cell of each domain (matching the live cloud's ordering).
 */
async function simulateBriefing(
  payload: AgentIngestPayload,
  handlers: DispatchHandlers,
): Promise<void> {
  const domains = payload.briefing.domains.length ? payload.briefing.domains : DOMAINS3;
  const windows = payload.briefing.windows.length ? payload.briefing.windows : WINDOWS5;
  const expected = domains.length * windows.length;
  let returned = 0;

  const budget = payload.briefing.timeBudgetMs * 0.7;
  const step = Math.max(140, budget / expected);

  for (const domain of domains) {
    const feats = featuresForDomain(domain, payload.groups);
    let first = true;
    for (const window of windows) {
      if (handlers.signal?.aborted) return;
      await delay(step + jitter(90));
      if (handlers.signal?.aborted) return;

      const section = synthSection(domain, window, feats, payload);
      returned++;
      handlers.onBriefing?.({
        meta: {
          requestId: payload.requestId,
          status: returned === expected ? "complete" : "partial",
          generatedAt: new Date().toISOString(),
          agent: { name: "worldnav-synthesizer", model: "aggregator-sim-v1" },
          sectionsExpected: expected,
          sectionsReturned: returned,
        },
        section,
        report: first
          ? { domain, label: DOMAIN_LABEL[domain], accent: DOMAIN_ACCENT[domain] }
          : undefined,
      });
      first = false;
    }
  }
}

function featuresForDomain(
  domain: ReportDomain,
  groups: Record<string, CloudFeature[]>,
): CloudFeature[] {
  const out: CloudFeature[] = [];
  for (const c of CATEGORIES_FOR_DOMAIN[domain] ?? []) out.push(...(groups[c] ?? []));
  return out;
}

/** Synthesize one of the 15 cells for a (domain, window) pair. */
function synthSection(
  domain: ReportDomain,
  window: ReportWindow,
  feats: CloudFeature[],
  payload: AgentIngestPayload,
): BriefingSection {
  const label = DOMAIN_LABEL[domain];
  const base = {
    id: `${domain}.${window}`,
    domain,
    window,
    lens: window,
    label: WINDOW_LABEL[window],
  };

  if (feats.length === 0) {
    return {
      ...base,
      headline: `0 ${label} signals · ${WINDOW_LABEL[window]}`,
      summary: `No ${label} signals were found near ${payload.area.center.lat.toFixed(2)}°, ${payload.area.center.lon.toFixed(2)}° in the ${window} window.`,
      severity: "info",
      confidence: 0.3,
      freshness: { observedAt: new Date().toISOString(), sourceCount: 0 },
      citations: [],
      state: "no-data",
      generatedVia: "empty",
    };
  }

  const sources = new Set(feats.map((f) => f.source));
  const confidence = Math.min(0.9, 0.45 + sources.size * 0.08);
  const frame =
    window === "hour" ? "In the last hour" :
    window === "day" ? "Over the past day" :
    window === "week" ? "Across the past week" :
    window === "month" ? "Over the past month" : "Across the past year";

  const bullets =
    window === "hour"
      ? feats
          .slice()
          .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))
          .slice(0, payload.briefing.section.maxBullets)
          .map((f) => `${f.title}${f.distanceKm != null ? ` · ${f.distanceKm.toFixed(0)} km` : ""}`)
      : undefined;

  return {
    ...base,
    headline: `${feats.length} ${label} signals · ${WINDOW_LABEL[window]}`,
    summary: `${frame}, ${feats.length} ${label} signals from ${sources.size} sources near ${payload.area.center.lat.toFixed(2)}°, ${payload.area.center.lon.toFixed(2)}°.`,
    bullets,
    metrics: payload.briefing.section.includeMetrics
      ? [{ label: "Sources", value: sources.size }]
      : undefined,
    severity: "info",
    confidence: Number(confidence.toFixed(2)),
    freshness: { observedAt: newestObserved(feats) ?? new Date().toISOString(), sourceCount: sources.size },
    citations: buildCitations(feats),
    state: "ok",
    generatedVia: "deterministic",
  };
}

function buildCitations(feats: CloudFeature[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const f of feats) {
    if (seen.has(f.source)) continue;
    seen.add(f.source);
    out.push({
      source: f.source,
      feedId: f.title.split(" #")[0],
      title: f.title,
      link: f.link,
      observedAt: f.observedAt,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/* -------------------------------- helpers --------------------------------- */

/** Coarse per-feed stats for the HTTP path (sim path builds them precisely). */
function deriveFeedStats(
  resolved: { category: string; feed: FeedEntry }[],
  collected: CloudFeature[],
): FeedCollectionStat[] {
  return resolved.map(({ category, feed }) => {
    const mine = collected.filter((f) => f.id.startsWith(feed.name + ":"));
    return {
      feedId: feed.name,
      category,
      provider: feed.provider,
      status: mine.length ? "ok" : "empty",
      featureCount: mine.length,
      observedAt: newestObserved(mine),
    };
  });
}

function newestObserved(feats: CloudFeature[]): string | undefined {
  let newest: string | undefined;
  for (const f of feats) {
    if (f.observedAt && (!newest || f.observedAt > newest)) newest = f.observedAt;
  }
  return newest;
}

/** Read an NDJSON stream, invoking `onLine` per parsed object. */
async function readNdjson<T>(
  body: ReadableStream<Uint8Array>,
  onLine: (obj: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(JSON.parse(line) as T);
    }
  }
  if (buf.trim()) onLine(JSON.parse(buf.trim()) as T);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(max: number): number {
  return Math.random() * max;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "req-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
