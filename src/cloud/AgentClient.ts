import type {
  AgentIngestPayload,
  Citation,
  CloudFeature,
  Severity,
  SummaryChunk,
  SummaryTopic,
} from "./types";

/** Stream handlers for a region-summary request. */
export interface SummaryHandlers {
  onChunk: (chunk: SummaryChunk) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

/**
 * Talks to the cloud summarization agent for the LEFT panel. Given the
 * aggregated {@link AgentIngestPayload} the right panel collected, it returns a
 * human-readable narrative of the area. When no endpoint is configured a local
 * simulator produces equivalent prose so the slice works offline; point
 * `VITE_AGENT_SUMMARY_URL` at a real agent to swap in live synthesis.
 */
export class AgentClient {
  constructor(private endpoint?: string) {}

  async summarize(
    payload: AgentIngestPayload,
    handlers: SummaryHandlers,
  ): Promise<void> {
    if (this.endpoint) {
      try {
        await this.summarizeHttp(payload, handlers);
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        handlers.onError?.(err as Error);
      }
    }
    await simulateSummary(payload, handlers);
  }

  private async summarizeHttp(
    payload: AgentIngestPayload,
    handlers: SummaryHandlers,
  ): Promise<void> {
    const resp = await fetch(this.endpoint!, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(payload),
      signal: handlers.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`agent ${resp.status}`);
    await readNdjson<SummaryChunk>(resp.body, (chunk) => handlers.onChunk(chunk));
  }
}

/* ------------------------------- simulator -------------------------------- */

interface TopicDef {
  id: string;
  label: string;
  category: string;
}

const TOPIC_DEFS: TopicDef[] = [
  { id: "environment", label: "Weather & Environment", category: "environmental" },
  { id: "hazards", label: "Hazards & Safety", category: "safety" },
  { id: "civic", label: "Government & Civic", category: "civic" },
  { id: "mobility", label: "Transit & Infrastructure", category: "transit" },
  { id: "place", label: "Place & Terrain", category: "map" },
];

const SEV_RANK: Record<Severity, number> = {
  critical: 0, warning: 1, watch: 2, advisory: 3, info: 4,
};

/** Local stand-in for the cloud agent: builds prose from the payload + streams it. */
async function simulateSummary(
  payload: AgentIngestPayload,
  handlers: SummaryHandlers,
): Promise<void> {
  const meta = (status: "partial" | "complete") => ({
    requestId: payload.requestId,
    status,
    generatedAt: new Date().toISOString(),
    agent: { name: "worldnav-narrator", model: "summary-sim-v1" },
  });

  const a = payload.area;
  const stats = payload.collection.stats;
  const worst = worstSeverity(payload.features);

  // Headline.
  await delay(180);
  if (handlers.signal?.aborted) return;
  handlers.onChunk({ meta: meta("partial"), kind: "headline", headline: headlineFor(payload, worst) });

  // Overview — streamed word-by-word for a typewriter feel.
  const overview =
    `Within ${a.radiusKm.toFixed(0)} km of ${a.center.lat.toFixed(3)}°, ${a.center.lon.toFixed(3)}° ` +
    `(${a.zoomTier} view), the agent reviewed ${stats.featureCount} records from ` +
    `${stats.feedsOk}/${stats.feedsTotal} responding feeds. ${toneSentence(worst, stats)} ` +
    `${nearestSentence(payload.features)}`;

  for (const token of overview.split(/(\s+)/)) {
    if (handlers.signal?.aborted) return;
    handlers.onChunk({ meta: meta("partial"), kind: "overview", overviewDelta: token });
    if (token.trim()) await delay(18);
  }

  // One prose paragraph per topic.
  for (const def of TOPIC_DEFS) {
    if (handlers.signal?.aborted) return;
    await delay(220);
    handlers.onChunk({
      meta: meta("partial"),
      kind: "topic",
      topic: topicFor(def, payload.groups[def.category] ?? []),
    });
  }

  // Final: overall severity, confidence, top citations.
  await delay(120);
  if (handlers.signal?.aborted) return;
  const sources = new Set(payload.features.map((f) => f.source));
  handlers.onChunk({
    meta: meta("complete"),
    kind: "final",
    severity: worst,
    confidence: Math.min(0.95, 0.4 + sources.size * 0.04),
    citations: topCitations(payload.features),
  });
}

function headlineFor(payload: AgentIngestPayload, worst: Severity): string {
  const n = payload.collection.stats.featureCount;
  if (worst === "critical" || worst === "warning") {
    return `Active ${worst} conditions across the area`;
  }
  if (worst === "watch" || worst === "advisory") {
    return `Some advisories in effect · ${n} signals tracked`;
  }
  return n > 0 ? `Calm conditions · ${n} signals tracked` : "No live signals in range";
}

function toneSentence(worst: Severity, stats: AgentIngestPayload["collection"]["stats"]): string {
  if (worst === "critical" || worst === "warning") {
    return "Conditions are elevated — active alerts are present and worth attention.";
  }
  if (worst === "watch" || worst === "advisory") {
    return "A handful of advisories are in effect, but nothing severe right now.";
  }
  if (stats.featureCount === 0) {
    return "No active signals were reported here during this sweep.";
  }
  return "Overall the area looks calm, with routine readings across the feeds.";
}

function nearestSentence(feats: CloudFeature[]): string {
  let nearest = Infinity;
  let which: CloudFeature | undefined;
  for (const f of feats) {
    if (f.distanceKm != null && f.distanceKm < nearest) {
      nearest = f.distanceKm;
      which = f;
    }
  }
  if (!which || !isFinite(nearest)) return "";
  return `The closest signal is ${which.source}'s "${which.title}", about ${nearest.toFixed(0)} km out.`;
}

function topicFor(def: TopicDef, feats: CloudFeature[]): SummaryTopic {
  if (feats.length === 0) {
    return { id: def.id, label: def.label, text: "No active signals reported here.", sources: [] };
  }
  const sources = [...new Set(feats.map((f) => f.source))];
  const worst = worstSeverity(feats);
  let nearest = Infinity;
  for (const f of feats) if (f.distanceKm != null) nearest = Math.min(nearest, f.distanceKm);
  const lead = feats.slice().sort((x, y) => (x.distanceKm ?? 1e9) - (y.distanceKm ?? 1e9))[0];

  const sev =
    worst !== "info" ? ` Peak severity is ${worst}.` : "";
  const near = isFinite(nearest) ? ` Nearest is ~${nearest.toFixed(0)} km away` : "";
  const eg = lead ? `${near}, e.g. ${lead.title}.` : `${near}.`;
  const text =
    `${feats.length} record${feats.length === 1 ? "" : "s"} from ` +
    `${sources.length} source${sources.length === 1 ? "" : "s"}.${sev}${eg}`;

  return { id: def.id, label: def.label, text, severity: worst, sources };
}

function worstSeverity(feats: CloudFeature[]): Severity {
  let worst: Severity = "info";
  for (const f of feats) {
    const s = f.severity ?? "info";
    if (SEV_RANK[s] < SEV_RANK[worst]) worst = s;
  }
  return worst;
}

function topCitations(feats: CloudFeature[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const f of feats) {
    if (seen.has(f.source)) continue;
    seen.add(f.source);
    out.push({ source: f.source, feedId: f.title.split(" #")[0], title: f.title, link: f.link, observedAt: f.observedAt });
    if (out.length >= 5) break;
  }
  return out;
}

/* -------------------------------- helpers --------------------------------- */

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
