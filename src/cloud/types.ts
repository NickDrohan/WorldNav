/**
 * Cloud orchestrator wire contracts.
 *
 * A click on the globe produces an {@link OrchestratorRequest}: a single,
 * self-describing document that tells the cloud agent three things —
 *   1. WHERE to look      → {@link GeoArea}
 *   2. WHAT to aggregate   → {@link FeedSelector}[] (references the feed catalog)
 *   3. HOW to answer       → {@link ResponseContract}
 *
 * The orchestrator owns all knowledge of how to actually call each upstream
 * feed (templating lat/lon/bbox into the endpoints in feed-catalog.json). The
 * frontend stays purely declarative so the contract survives feed changes.
 */

export const ORCHESTRATOR_PROTOCOL = "worldnav.orchestrate.v1" as const;
export const RESPONSE_SHAPE = "worldnav.features.v1" as const;

/** How zoomed-in the click was. Lets the cloud pick feed resolution + radius. */
export type ZoomTier = "orbital" | "regional" | "metro" | "street";

/** Shared severity scale used by raw features and synthesized sections. */
export type Severity = "info" | "advisory" | "watch" | "warning" | "critical";

/** Coarse axis-aligned bounding box for server-side pre-filtering. */
export interface BoundingBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** The geospatial region of interest the cloud should poll + aggregate. */
export interface GeoArea {
  /** Surface point under the reticle when the user clicked. */
  center: { lat: number; lon: number };
  /** Reticle ring radius — the nominal area of interest. */
  radiusKm: number;
  /** Derived box (center ± radius) for feeds that filter by bbox. */
  bbox: BoundingBox;
  /** Geohash of the center — stable cache/tile key for the orchestrator. */
  geohash: string;
  /** Camera height above the surface, for context/telemetry. */
  altitudeKm: number;
  /** Vertical ground span of the viewport — how much the user can see. */
  viewportSpanKm: number;
  /** Bucketed zoom level derived from the span. */
  zoomTier: ZoomTier;
}

/**
 * Declares which catalog feeds to poll. The orchestrator resolves `feedIds`
 * against feed-catalog.json; "*" means "every feed in this category".
 */
export interface FeedSelector {
  categoryId: string;
  /** Specific catalog feed names, or a single "*" entry meaning "all in category". */
  feedIds: string[];
  /**
   * Relevance hint so the orchestrator can prioritise / shed load under a
   * time budget. Derived from zoom tier (street-level cares about transit;
   * orbital cares about hazards).
   */
  priority: "high" | "normal" | "low";
}

/** Normalised, frontend-ready feature the cloud should emit per result. */
export interface CloudFeature {
  /** Stable id (orchestrator-assigned) for dedupe + animation keying. */
  id: string;
  /** Catalog category this came from. */
  category: string;
  /** Upstream provider (e.g. "NOAA NWS"). */
  source: string;
  /** Semantic kind: "alert" | "observation" | "quake" | "vehicle" | ... */
  kind: string;
  title: string;
  summary?: string;
  /** Point location, when the feature is geolocated. */
  lat?: number;
  lon?: number;
  /** Great-circle distance from the click center, km (orchestrator-computed). */
  distanceKm?: number;
  severity?: Severity;
  /** ISO-8601 observation/issue time. */
  observedAt?: string;
  /** Scalar reading + unit, for sensor-style feeds. */
  value?: number;
  unit?: string;
  /** Canonical link back to the source record. */
  link?: string;
}

/**
 * Instructs the cloud how to package the answer so the frontend can render it
 * with zero post-processing.
 */
export interface ResponseContract {
  shape: typeof RESPONSE_SHAPE;
  /**
   * `stream` → emit NDJSON envelopes as each feed resolves (lets the UI
   * populate progressively); `batch` → a single aggregated document.
   */
  delivery: "stream" | "batch";
  /** Hard cap on returned features. */
  maxResults: number;
  /** Per-category cap so one chatty feed can't crowd out the rest. */
  maxPerCategory: number;
  /** Server-side ordering before truncation. */
  rankBy: "distance" | "severity" | "recency";
  /** Collapse near-duplicate features across overlapping feeds. */
  dedupe: boolean;
  /** Group features by catalog category in the payload. */
  groupByCategory: boolean;
  units: "metric" | "imperial";
  /** Soft wall-clock budget; the cloud returns whatever it has by then. */
  timeBudgetMs: number;
  /** ISO-639-1 language for human-readable strings. */
  lang: string;
}

/** Polling behaviour for the area, seeded from the catalog cadence. */
export interface PollSpec {
  intervalSec: number;
  /** `snapshot` = one-shot; `subscribe` = keep streaming refreshes. */
  mode: "snapshot" | "subscribe";
}

/** The complete document POSTed to the orchestrator on click. */
export interface OrchestratorRequest {
  protocol: typeof ORCHESTRATOR_PROTOCOL;
  /** Idempotency / correlation key. */
  requestId: string;
  /** ISO-8601 issue time. */
  issuedAt: string;
  client: {
    app: string;
    version: string;
    sessionId: string;
    userAgent: string;
  };
  area: GeoArea;
  selectors: FeedSelector[];
  response: ResponseContract;
  poll: PollSpec;
}

/** Metadata envelope the cloud returns alongside features. */
export interface CloudResponseMeta {
  requestId: string;
  status: "partial" | "complete" | "error";
  feedsQueried: number;
  feedsReturned: number;
  generatedAt: string;
  error?: string;
}

/** One streamed chunk (NDJSON line) from a `delivery: "stream"` response. */
export interface CloudStreamChunk {
  meta: CloudResponseMeta;
  features: CloudFeature[];
}

/* ===========================================================================
 * STAGE 2 — Agent ingestion contract (worldnav.ingest.v1)
 *
 * Once all 33 catalog feeds are collected (stage 1, above), the orchestrator
 * rolls the raw {@link CloudFeature}[] into a single {@link AgentIngestPayload}
 * and POSTs it to the cloud summarization agent behind the gateway. The agent
 * ingests this bundle and returns a {@link RegionBriefing}: 5 reports × 3
 * lenses = 15 synthesized content pieces for the info panel.
 * ===========================================================================
 */

export const AGENT_INGEST_PROTOCOL = "worldnav.ingest.v1" as const;
export const BRIEFING_PROTOCOL = "worldnav.briefing.v1" as const;
export const BRIEFING_SHAPE = "worldnav.briefing.v1" as const;

/** The 3 reports — the EarthRelay cloud's top-level domains. */
export type ReportDomain = "science" | "governance" | "social";

/** The 5 time windows each domain spans → 3 × 5 = 15 content pieces. */
export type ReportWindow = "hour" | "day" | "week" | "month" | "year";

/** Back-compat alias: the cloud uses time windows as the per-cell "lens". */
export type ReportLens = ReportWindow;

/** Reliability rollup for a feed across recent cycles. */
export type FeedHealthState = "healthy" | "degraded" | "offline";

/** Per-feed collection outcome, so the agent can weight trust + report coverage. */
export interface FeedCollectionStat {
  /** Catalog feed name. */
  feedId: string;
  /** Catalog category id. */
  category: string;
  provider: string;
  /** Outcome of this cycle. `offline` = circuit breaker open, feed was skipped. */
  status: "ok" | "empty" | "error" | "timeout" | "offline";
  featureCount: number;
  latencyMs?: number;
  /** Freshest record observed from this feed (ISO-8601). */
  observedAt?: string;
  error?: string;
  /**
   * Reliability classification. `healthy` = succeeding; `degraded` = retrying
   * after recent failures; `offline` = circuit open after repeated failures.
   */
  health?: FeedHealthState;
  /** Attempts spent this cycle (1 = first-try success). */
  attempts?: number;
  /** Consecutive failed cycles (drives flaky→offline escalation). */
  consecutiveFailures?: number;
  /** Per-endpoint timeout budget applied this cycle. */
  deadlineMs?: number;
  /** Sibling feed used to cover for this one when it failed. */
  fallback?: string;
}

/** Compact roll-up so the agent doesn't have to recompute the basics. */
export interface AggregateStats {
  /** Always 33 for a full catalog sweep. */
  feedsTotal: number;
  feedsOk: number;
  feedsEmpty: number;
  feedsError: number;
  featureCount: number;
  /** Features per catalog category. */
  byCategory: Record<string, number>;
  /** Feature counts bucketed by severity. */
  bySeverity: Record<Severity, number>;
  nearestKm?: number;
  newestObservedAt?: string;
  oldestObservedAt?: string;
  /** Wall-clock to collect all feeds, ms. */
  collectionMs: number;
}

/**
 * What the agent should write, and how (pure presentation contract). Travels
 * inside the ingest payload so the agent knows the exact shape to emit.
 */
export interface BriefingFormat {
  shape: typeof BRIEFING_SHAPE;
  /** `stream` → the 15 sections arrive independently; `batch` → one document. */
  delivery: "stream" | "batch";
  /** Which domains to produce (default: all 3). */
  domains: ReportDomain[];
  /** Which time windows per domain (default: all 5). */
  windows: ReportWindow[];
  section: {
    /** Hard cap on synthesized prose, in words. */
    maxSummaryWords: number;
    maxBullets: number;
    /** Emit metric chips when numeric data exists. */
    includeMetrics: boolean;
    /** Every section must attribute its sources. */
    requireCitations: boolean;
    tone: "neutral" | "briefing" | "technical";
    readingLevel: "general" | "expert";
  };
  units: "metric" | "imperial";
  /** ISO-639-1. */
  lang: string;
  /** Soft budget; agent returns best-effort partials by then. */
  timeBudgetMs: number;
}

/** The aggregated bundle the orchestrator hands to the cloud agent. */
export interface AgentIngestPayload {
  protocol: typeof AGENT_INGEST_PROTOCOL;
  /** Correlates with the originating OrchestratorRequest. */
  requestId: string;
  issuedAt: string;
  area: GeoArea;
  /** Coverage report across the full feed sweep. */
  collection: {
    completedAt: string;
    stats: AggregateStats;
    /** One entry per polled feed (length === feedsTotal). */
    feeds: FeedCollectionStat[];
  };
  /** The raw aggregated content the agent summarizes. */
  features: CloudFeature[];
  /** Pre-grouped by catalog category for convenience (agent may ignore). */
  groups: Record<string, CloudFeature[]>;
  /** The briefing the orchestrator wants back. */
  briefing: BriefingFormat;
}

/* --- Agent response: the region briefing the panel renders ---------------- */

export type SectionState = "ok" | "no-data" | "stale" | "error";

/** A source the agent used — surfaced for trust + click-through. */
export interface Citation {
  source: string;
  /** Catalog feed name. */
  feedId: string;
  title: string;
  /** May be null for search-derived (grounded) items. */
  link?: string | null;
  observedAt?: string;
  /** Optional grouping hint, e.g. "forecast" | "news". */
  category?: string;
}

/** A compact numeric callout rendered as a chip. */
export interface MetricChip {
  label: string;
  value: string | number;
  unit?: string;
  /** Signed change vs the trailing window, when meaningful. */
  delta?: number;
  severity?: Severity;
}

/** One of the 15 content pieces. */
export interface BriefingSection {
  /** Stable render key: `${domain}.${window}` (e.g. "science.hour"). */
  id: string;
  domain: ReportDomain;
  /** Time window this cell covers. */
  window: ReportWindow;
  /** Same as `window`; kept for the cloud's wire shape. */
  lens: ReportLens;
  label: string;
  /** One-line takeaway. */
  headline: string;
  /** Agent-written prose. */
  summary: string;
  bullets?: string[];
  metrics?: MetricChip[];
  /** Currently always "info" from the cloud (no hazard scoring yet). */
  severity?: Severity;
  /** Agent self-rated 0..1. */
  confidence: number;
  freshness: { observedAt: string; sourceCount: number };
  citations: Citation[];
  /** `ok` | `no-data` (still emitted) | `stale` | `error`. */
  state: SectionState;
  /** How the cell was produced: "qubrid" (LLM) | "deterministic" | "empty". */
  generatedVia?: string;
}

/** One report = one domain spanning its lenses. */
export interface BriefingReport {
  domain: ReportDomain;
  label: string;
  /** Hex accent hint for the panel. */
  accent?: string;
  status: "ok" | "partial" | "empty" | "error";
  /** length === briefing.lenses.length (3). */
  sections: BriefingSection[];
}

/** Metadata envelope returned with the briefing. */
export interface BriefingMeta {
  requestId: string;
  status: "partial" | "complete" | "error";
  generatedAt: string;
  /** Attribution for the synthesis layer. */
  agent: { name: string; model?: string };
  /** 15 for a full briefing. */
  sectionsExpected: number;
  sectionsReturned: number;
  /** Feeds the agent ingested (omitted by the live cloud). */
  feedsIngested?: number;
  error?: string;
}

/** The fully aggregated answer (delivery: "batch"). */
export interface RegionBriefing {
  shape: typeof BRIEFING_SHAPE;
  meta: BriefingMeta;
  area: GeoArea;
  /** length === briefing.domains.length (5). */
  reports: BriefingReport[];
}

/** One streamed envelope (delivery: "stream"): a single section as it lands. */
export interface BriefingChunk {
  meta: BriefingMeta;
  /** The section that just completed, keyed by `${domain}.${lens}`. */
  section: BriefingSection;
  /** Domain header, sent with the first section of each report. */
  report?: Pick<BriefingReport, "domain" | "label" | "accent">;
}

/* ===========================================================================
 * STAGE 2b — Region summary (worldnav.summary.v1)
 *
 * A second, narrative-oriented response from the cloud agent for the LEFT
 * panel. It ingests the same {@link AgentIngestPayload} (all collected feeds +
 * geo metadata) and returns plain-language prose: a headline, an overview
 * paragraph, and one short paragraph per topic — "what's happening here" in
 * human-readable form, as opposed to the structured 5×3 briefing.
 * ===========================================================================
 */

export const SUMMARY_PROTOCOL = "worldnav.summary.v1" as const;

/** A human-readable paragraph about one aspect of the area. */
export interface SummaryTopic {
  /** Stable key, e.g. "environment" | "hazards" | "civic" | "mobility" | "place". */
  id: string;
  label: string;
  /** Plain-language prose. */
  text: string;
  severity?: Severity;
  /** Distinct upstream sources behind this paragraph. */
  sources: string[];
}

/** The fully assembled narrative (delivery: "batch"). */
export interface RegionSummary {
  protocol: typeof SUMMARY_PROTOCOL;
  requestId: string;
  generatedAt: string;
  area: GeoArea;
  /** One-line takeaway. */
  headline: string;
  /** Lead paragraph synthesizing the whole area. */
  overview: string;
  topics: SummaryTopic[];
  /** Worst signal across the area; drives the panel accent. */
  severity: Severity;
  confidence: number;
  citations: Citation[];
  agent: { name: string; model?: string };
}

/**
 * One streamed envelope. The overview streams token-by-token via
 * `overviewDelta` (typewriter), then each topic lands as a `topic` chunk.
 */
export interface SummaryChunk {
  meta: {
    requestId: string;
    status: "partial" | "complete";
    generatedAt: string;
    agent: { name: string; model?: string };
  };
  kind: "headline" | "overview" | "topic" | "final";
  headline?: string;
  /** Appended to the running overview as it streams. */
  overviewDelta?: string;
  topic?: SummaryTopic;
  /** Sent with the `final` chunk. */
  severity?: Severity;
  confidence?: number;
  citations?: Citation[];
}
