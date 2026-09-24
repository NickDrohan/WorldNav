# WorldNav — Backend Handoff

This document is the implementation contract for the cloud services that sit
behind the orchestration gateway. The frontend is **fully decoupled and
declarative**: it never calls upstream feeds di+-rectly and does no
post-processing. It POSTs a self-describing request, then renders whatever the
backend streams back.

**Source of truth for all types:** [`src/cloud/types.ts`](src/cloud/types.ts).
Every payload below is an instance of an exported interface from that file.

---

## 1. Topology

There are two logical services. A single gateway may implement both routes.

```
                 ┌──────────────────────── orchestration gateway ───────────────────────┐
 click ──▶ (A) POST /orchestrate ──▶ fan-out to 33 catalog feeds ──▶ normalize ──▶ stream │
                 │                                                                         │
            33 feeds collected + aggregated into one AgentIngestPayload                    │
                 │                                                                         │
           (B) POST /agent/ingest ──▶ summarization agent (LLM) ──▶ 15 sections ──▶ stream │
                 └─────────────────────────────────────────────────────────────────────────┘
```

| Stage | Route (env var)            | Request body            | Response (NDJSON stream of) |
|-------|----------------------------|-------------------------|-----------------------------|
| **A** | `VITE_ORCHESTRATOR_URL`    | `OrchestratorRequest`   | `CloudStreamChunk`          |
| **B** | `VITE_AGENT_URL`           | `AgentIngestPayload`    | `BriefingChunk`             |

> The aggregation between A and B (building `AgentIngestPayload` from the
> collected features) currently happens client-side. A backend is free to move
> it server-side and expose only route B — the payload shape is identical
> either way. If both routes are unset, the frontend runs a local simulator.

---

## 2. Transport (both routes)

- **Method:** `POST`
- **Request header:** `content-type: application/json`
- **Request header:** `accept: application/x-ndjson`
- **Response:** `200` with `content-type: application/x-ndjson`, body is a
  **stream of newline-delimited JSON objects** (one envelope per line). The
  frontend parses each line as it arrives so the panel fills progressively.
- **Cancellation:** the client may drop the connection at any time (it passes an
  `AbortSignal`). Stop work and release resources when the socket closes.
- **Idempotency / correlation:** every envelope must echo the originating
  `requestId`.
- **Batch alternative:** if `delivery: "batch"` is requested, return a single
  JSON document instead of a stream (`RegionBriefing` for route B).

Each NDJSON line is a complete JSON object:

```
{"meta":{...},"features":[...]}\n
{"meta":{...},"features":[...]}\n
```

---

## 3. Stage A — Feed aggregation

### 3a. Request the frontend serves you (`OrchestratorRequest`)

```json
{
  "protocol": "worldnav.orchestrate.v1",
  "requestId": "5d519f22-aa18-4d29-91da-be87426356c0",
  "issuedAt": "2026-05-31T20:49:06.001Z",
  "client": {
    "app": "WorldNav",
    "version": "0.1.0",
    "sessionId": "395a95f7-5d3f-43a8-9467-e0bd5f4d1572",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/142"
  },
  "area": {
    "center": { "lat": 3.880843, "lon": -74.383530 },
    "radiusKm": 844.47,
    "bbox": { "minLat": -3.71362, "maxLat": 11.47530, "minLon": -81.99544, "maxLon": -66.77162 },
    "geohash": "d2e",
    "altitudeKm": 12742,
    "viewportSpanKm": 10555.82,
    "zoomTier": "orbital"
  },
  "selectors": [
    { "categoryId": "safety",        "feedIds": ["*"], "priority": "high" },
    { "categoryId": "environmental", "feedIds": ["*"], "priority": "normal" },
    { "categoryId": "civic",         "feedIds": ["*"], "priority": "low" },
    { "categoryId": "transit",       "feedIds": ["*"], "priority": "low" },
    { "categoryId": "map",           "feedIds": ["*"], "priority": "low" }
  ],
  "response": {
    "shape": "worldnav.features.v1",
    "delivery": "stream",
    "maxResults": 80,
    "maxPerCategory": 12,
    "rankBy": "severity",
    "dedupe": true,
    "groupByCategory": true,
    "units": "metric",
    "timeBudgetMs": 8000,
    "lang": "en"
  },
  "poll": { "intervalSec": 3600, "mode": "snapshot" }
}
```

**Your job for stage A:**
1. Resolve `selectors` against the feed catalog (`public/feed-catalog.json`,
   33 feeds across 5 categories). `"*"` = every feed in the category.
2. Template `area` (`center` / `bbox` / `radiusKm`) into each upstream endpoint
   and fetch. Honor `priority` to spend the `timeBudgetMs` budget — do high
   first, shed/aged-cache low feeds if you run out of time.
3. Normalize every upstream record to a `CloudFeature` (assign a stable `id`,
   compute `distanceKm` from `area.center`).
4. Apply `dedupe`, `rankBy`, `maxResults`, `maxPerCategory`.
5. Stream `CloudStreamChunk` lines as feeds resolve.

### 3b. Response you stream back (`CloudStreamChunk`, one per line)

```json
{
  "meta": {
    "requestId": "5d519f22-aa18-4d29-91da-be87426356c0",
    "status": "partial",
    "feedsQueried": 33,
    "feedsReturned": 7,
    "generatedAt": "2026-05-31T20:49:08.114Z"
  },
  "features": [
    {
      "id": "USGS Earthquakes (hour):1:0",
      "category": "safety",
      "source": "USGS",
      "kind": "quake",
      "title": "USGS Earthquakes (hour) #887",
      "summary": "M2.9, depth 12 km.",
      "lat": 4.21, "lon": -74.02,
      "distanceKm": 48.6,
      "severity": "warning",
      "observedAt": "2026-05-31T20:42:01Z",
      "value": 2.9, "unit": "Mw",
      "link": "https://earthquake.usgs.gov/..."
    }
  ]
}
```

- Send `status: "partial"` for every intermediate line and `status: "complete"`
  on the **final** line. `feedsReturned` rises to `feedsQueried` (33).
- `features` may be cumulative (full ranked list so far) or incremental — the
  frontend reconciles by `feature.id`, so either works; cumulative is simplest.

---

## 4. Stage B — Synthesis agent

### 4a. Request the frontend (or gateway) serves the agent (`AgentIngestPayload`)

This is the **aggregated bundle** produced after all 33 feeds are collected.
`features` is trimmed here for brevity (real payload carries the full array).

```json
{
  "protocol": "worldnav.ingest.v1",
  "requestId": "5d519f22-aa18-4d29-91da-be87426356c0",
  "issuedAt": "2026-05-31T20:49:14.290Z",
  "area": {
    "center": { "lat": 3.880843, "lon": -74.383530 },
    "radiusKm": 844.47,
    "bbox": { "minLat": -3.71362, "maxLat": 11.47530, "minLon": -81.99544, "maxLon": -66.77162 },
    "geohash": "d2e", "altitudeKm": 12742, "viewportSpanKm": 10555.82, "zoomTier": "orbital"
  },
  "collection": {
    "completedAt": "2026-05-31T20:49:14.290Z",
    "stats": {
      "feedsTotal": 33, "feedsOk": 33, "feedsEmpty": 0, "feedsError": 0,
      "featureCount": 67,
      "byCategory": { "safety": 16, "environmental": 26, "civic": 11, "transit": 9, "map": 5 },
      "bySeverity": { "info": 55, "advisory": 1, "watch": 4, "warning": 5, "critical": 2 },
      "nearestKm": 9.29,
      "newestObservedAt": "2026-05-31T20:48:12Z",
      "oldestObservedAt": "2026-05-31T19:50:47Z",
      "collectionMs": 8234
    },
    "feeds": [
      { "feedId": "NWS Active Alerts", "category": "safety", "provider": "NOAA NWS",
        "status": "ok", "featureCount": 2, "latencyMs": 230, "observedAt": "2026-05-31T20:42:59Z" },
      { "feedId": "USGS Earthquakes (hour)", "category": "safety", "provider": "USGS",
        "status": "ok", "featureCount": 3, "latencyMs": 202, "observedAt": "2026-05-31T20:42:01Z" }
      /* ... 31 more — one entry per feed, length === feedsTotal ... */
    ]
  },
  "features": [ /* the full normalized CloudFeature[] (67 here) */ ],
  "groups": {
    "safety":        [ /* CloudFeature[] */ ],
    "environmental": [ /* CloudFeature[] */ ],
    "civic":         [ /* CloudFeature[] */ ],
    "transit":       [ /* CloudFeature[] */ ],
    "map":           [ /* CloudFeature[] */ ]
  },
  "briefing": {
    "shape": "worldnav.briefing.v1",
    "delivery": "stream",
    "domains": ["environment", "hazards", "civic", "mobility", "place"],
    "lenses": ["now", "trend", "outlook"],
    "section": {
      "maxSummaryWords": 60,
      "maxBullets": 4,
      "includeMetrics": true,
      "requireCitations": true,
      "tone": "briefing",
      "readingLevel": "general"
    },
    "units": "metric",
    "lang": "en",
    "timeBudgetMs": 6000
  }
}
```

**Your job for stage B:** produce exactly `domains.length × lenses.length` =
**5 × 3 = 15** sections. Each `domain` is backed by one catalog category:

| `domain`      | backing category | lenses (`now` / `trend` / `outlook`)                          |
|---------------|------------------|----------------------------------------------------------------|
| `environment` | `environmental`  | current conditions / recent change / short-range forecast      |
| `hazards`     | `safety`         | active alerts / activity vs baseline / watches & trajectory    |
| `civic`       | `civic`          | latest filings / recent volume / upcoming effective dates      |
| `mobility`    | `transit`        | live status / recent disruptions / planned changes             |
| `place`       | `map`            | what's here / coverage (often `stale`) / usually `no-data`     |

Respect `section.*` limits: keep `summary` ≤ `maxSummaryWords`, ≤ `maxBullets`
bullets, include `metrics` only if `includeMetrics`, and always attach
`citations` if `requireCitations` (cite by `feedId` from the catalog). When a
domain has no relevant features, still emit the section with `state: "no-data"`
(or `"stale"`) so the panel keeps all 15 cells.

### 4b. Response the agent streams back (`BriefingChunk`, one per line)

The frontend assembles these 15 lines into a `RegionBriefing`. Include the
`report` header on the **first** section of each domain.

```json
{
  "meta": {
    "requestId": "5d519f22-aa18-4d29-91da-be87426356c0",
    "status": "partial",
    "generatedAt": "2026-05-31T20:49:15.880Z",
    "agent": { "name": "worldnav-synthesizer", "model": "gpt-x" },
    "sectionsExpected": 15,
    "sectionsReturned": 4,
    "feedsIngested": 33
  },
  "report": { "domain": "hazards", "label": "Hazards & Safety", "accent": "#ff6a3c" },
  "section": {
    "id": "hazards.now",
    "domain": "hazards",
    "lens": "now",
    "label": "Current conditions",
    "headline": "16 live hazard signals · critical",
    "summary": "Aggregated 16 current records from 6 sources within 844 km. A critical volcano alert and an M-class quake dominate; nearest signal ~9 km out.",
    "bullets": [
      "USGS Volcano Alert #513 · 9 km",
      "USGS Earthquakes (hour) #887 · 49 km",
      "GDACS Disasters #219 · 120 km"
    ],
    "metrics": [
      { "label": "Signals", "value": 16 },
      { "label": "Peak", "value": "critical", "severity": "critical" },
      { "label": "Nearest", "value": "9", "unit": "km" }
    ],
    "severity": "critical",
    "confidence": 0.85,
    "freshness": { "observedAt": "2026-05-31T20:42:59Z", "sourceCount": 6 },
    "citations": [
      { "source": "USGS", "feedId": "USGS Volcano Alerts", "title": "Elevated alert", "link": "https://volcanoes.usgs.gov/...", "observedAt": "2026-05-31T20:30:14Z" },
      { "source": "NOAA NWS", "feedId": "NWS Active Alerts", "title": "Flood Watch", "link": "https://api.weather.gov/...", "observedAt": "2026-05-31T20:42:59Z" }
    ],
    "state": "ok"
  }
}
```

Final line carries `meta.status: "complete"` and `sectionsReturned: 15`.

Graceful-degradation example (`place.outlook`):

```json
{
  "meta": { "requestId": "5d519f22-...", "status": "partial", "generatedAt": "...",
            "agent": { "name": "worldnav-synthesizer" },
            "sectionsExpected": 15, "sectionsReturned": 15, "feedsIngested": 33 },
  "section": {
    "id": "place.outlook", "domain": "place", "lens": "outlook", "label": "Outlook",
    "headline": "No forward signal for terrain",
    "summary": "Terrain and place geometry have no forecast horizon. Zoom in to refine detail.",
    "severity": "info", "confidence": 0.3,
    "freshness": { "observedAt": "2026-05-31T20:49:14Z", "sourceCount": 1 },
    "citations": [], "state": "stale"
  }
}
```

---

## 5. Field reference & invariants

**Severity scale** (shared): `info < advisory < watch < warning < critical`.

**`meta.status`** (both stages): `"partial"` until the last line, then
`"complete"`. Use `"error"` + `meta.error` to report a hard failure mid-stream;
the frontend keeps whatever it already rendered.

**`section.state`:**
- `ok` — synthesized normally.
- `stale` — data exists but is old / static (e.g. base map geometry).
- `no-data` — nothing relevant in range; still emit the section.
- `error` — agent failed this cell specifically.

**Hard invariants the frontend relies on:**
- Stage B emits exactly `domains.length × lenses.length` sections (15 default).
- `section.id === \`${domain}.${lens}\`` and is unique — used as the render key.
- Every envelope echoes `requestId`.
- `collection.feeds.length === collection.stats.feedsTotal`.
- `confidence ∈ [0, 1]`.

**Units & language:** honor `briefing.units` and `briefing.lang` in all
human-readable strings and metric chips.

---

## 6. Minimal server contract (pseudocode)

```ts
// Stage A
POST /orchestrate  (body: OrchestratorRequest) -> text/x-ndjson
  feeds = resolveCatalog(req.selectors)                  // up to 33
  for each feed (priority order, within req.response.timeBudgetMs):
    records = fetchUpstream(feed, req.area)
    features.push(...normalize(records, req.area.center))
    writeLine({ meta: partial(req, feedsReturned++), features: rankAndCap(features, req.response) })
  writeLine({ meta: complete(req), features: rankAndCap(features, req.response) })

// Stage B
POST /agent/ingest (body: AgentIngestPayload) -> text/x-ndjson
  for domain in payload.briefing.domains:        // 5
    feats = payload.groups[categoryFor(domain)]
    for lens in payload.briefing.lenses:         // 3
      section = agent.summarize(domain, lens, feats, payload.briefing.section)
      writeLine({ meta: meta(payload, sectionsReturned++), section, report: firstOfDomain ? header(domain) : undefined })
  // last writeLine has meta.status = "complete", sectionsReturned = 15
```

---

## 7. Errors & timeouts

- **HTTP non-2xx or unreadable body:** the frontend logs a degraded state and
  falls back to its local simulator. Prefer streaming a partial result with
  `meta.status: "error"` over returning a bare 5xx.
- **Per-feed failure (stage A):** don't fail the whole stream — mark that feed
  `status: "error" | "timeout"` in the eventual `collection.feeds[]` entry and
  continue.
- **Budget exceeded:** return best-effort partials by `timeBudgetMs`; the
  frontend renders whatever arrived.
