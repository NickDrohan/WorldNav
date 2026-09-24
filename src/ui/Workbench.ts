import {
  CloudOrchestrator,
  type FeedCatalog,
  type QueryContext,
} from "../cloud/Orchestrator";
import type {
  AgentIngestPayload,
  BriefingChunk,
  BriefingSection,
  Citation,
  CloudFeature,
  FeedCollectionStat,
  FeedHealthState,
  OrchestratorRequest,
  ReportDomain,
  ReportWindow,
} from "../cloud/types";
import "./workbench.css";

/** Fixed row height used by the feed-status virtualizer (must match CSS). */
const FEED_ROW_H = 30;

const CATEGORY_LABELS: Record<string, string> = {
  environmental: "ENVIRONMENTAL",
  safety: "SAFETY & ALERTS",
  civic: "GOVERNMENT & CIVIC",
  transit: "TRANSIT & INFRA",
  map: "MAP GEOMETRY",
};

const DOMAINS: ReportDomain[] = ["science", "governance", "social"];
const WINDOWS: ReportWindow[] = ["hour", "day", "week", "month", "year"];

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
  hour: "PAST HOUR",
  day: "PAST DAY",
  week: "PAST WEEK",
  month: "PAST MONTH",
  year: "PAST YEAR",
};

/**
 * Base re-poll cadence; backed off adaptively when feeds stay healthy. Sized
 * generously because the live cloud runs LLM agents (~30-60s per sweep) and is
 * costly — re-polling too often would hammer production.
 */
const REFRESH_INTERVAL_MS = 300_000;
const REFRESH_INTERVAL_RELAXED_MS = 600_000;
/** Healthy cycles in a row before we relax to the slower cadence. */
const HEALTHY_CYCLES_TO_RELAX = 2;
/** Age past which the snapshot is flagged stale. */
const STALE_AFTER_MS = 360_000;
/** Center moves beyond this (km) trigger a "location changed" banner. */
const LOCATION_JUMP_KM = 50;
/** Domains whose upstreams cycle slowly — surface an explicit next-refresh clock. */
const SLOW_DOMAINS = new Set<string>(["governance"]);

type PollState =
  | "idle"
  | "querying"
  | "synthesizing"
  | "live"
  | "fetching"
  | "stale"
  | "degraded";

const POLL_LABEL: Record<PollState, string> = {
  idle: "IDLE",
  querying: "QUERYING",
  synthesizing: "SYNTHESIZING",
  live: "LIVE",
  fetching: "REFRESHING",
  stale: "STALE",
  degraded: "DEGRADED",
};

/** Per-category result group: a header + the feature rows rendered into it. */
interface ResultGroup {
  section: HTMLDivElement;
  list: HTMLDivElement;
  ids: Set<string>;
}

export class Workbench {
  private el: HTMLDivElement;
  private bannerEl: HTMLDivElement;
  private statusEl: HTMLSpanElement;
  private freshEl: HTMLSpanElement;
  private headerEl: HTMLDivElement;
  private progressEl: HTMLDivElement;
  private progressBar: HTMLDivElement;
  private progressLabel: HTMLSpanElement;
  private briefingEl: HTMLDivElement;
  private feedsHealthEl: HTMLDivElement;
  private feedsEl: HTMLDivElement;
  private feedsInner: HTMLDivElement;
  private listEl: HTMLDivElement;
  private payloadEl: HTMLPreElement;
  private ingestEl: HTMLPreElement;
  private sourcesEl: HTMLDivElement;
  private sourcesDetails: HTMLDetailsElement;

  private catalog: FeedCatalog | null = null;
  private orchestrator: CloudOrchestrator | null = null;
  private sessionId = makeSessionId();

  private groups = new Map<string, ResultGroup>();
  private seen = new Set<string>();
  private briefingCards = new Map<string, HTMLDivElement>();
  private abort: AbortController | null = null;
  private _open = false;

  private lastCtx: QueryContext | null = null;
  private lastUpdatedAt: number | null = null;
  private nextRefreshAt: number | null = null;
  private pollState: PollState = "idle";
  private heartbeat: number | null = null;
  private refreshTimer: number | null = null;
  private sourcesRendered = false;

  private feedStats: FeedCollectionStat[] = [];
  private lastCenter: { lat: number; lon: number } | null = null;
  private healthyCycles = 0;
  private refreshIntervalMs = REFRESH_INTERVAL_MS;
  /** Per-report deduped citation footers, so source links render once per domain. */
  private reportCites = new Map<string, { el: HTMLDivElement; sources: Map<string, Citation> }>();
  /** Per-report "next refresh at HH:MM" hints for slow-cycling domains. */
  private reportHints = new Map<string, HTMLSpanElement>();

  onClose?: () => void;
  /** Emitted whenever a full sweep is aggregated (initial + each refresh). */
  onPayload?: (payload: AgentIngestPayload) => void;
  /** Emitted for each streamed briefing cell (drives the left Cloud Agent panel). */
  onSection?: (chunk: BriefingChunk) => void;

  constructor(container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "workbench";

    // Over the panel, swap the sci-fi globe reticle for a clean native cursor.
    this.el.addEventListener("pointerenter", () =>
      document.body.classList.add("ui-hover"),
    );
    this.el.addEventListener("pointerleave", () =>
      document.body.classList.remove("ui-hover"),
    );

    const closeBtn = document.createElement("button");
    closeBtn.className = "workbench-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());
    this.el.appendChild(closeBtn);

    const title = document.createElement("div");
    title.className = "workbench-title";
    title.textContent = "ORCHESTRATOR QUERY";
    this.el.appendChild(title);

    // Transient "location changed" banner for large jumps between queries.
    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "workbench-banner";
    this.el.appendChild(this.bannerEl);

    // Live status + freshness bar.
    const meta = document.createElement("div");
    meta.className = "workbench-meta";
    this.statusEl = document.createElement("span");
    this.statusEl.className = "workbench-status";
    this.freshEl = document.createElement("span");
    this.freshEl.className = "workbench-fresh";
    meta.appendChild(this.statusEl);
    meta.appendChild(this.freshEl);
    this.el.appendChild(meta);
    this.setPollState("idle");

    this.headerEl = document.createElement("div");
    this.headerEl.className = "workbench-header";
    this.el.appendChild(this.headerEl);

    // Phase-aware progress bar: collect → aggregate → synthesize.
    this.progressEl = document.createElement("div");
    this.progressEl.className = "workbench-progress";
    const track = document.createElement("div");
    track.className = "workbench-progress-track";
    this.progressBar = document.createElement("div");
    this.progressBar.className = "workbench-progress-bar";
    track.appendChild(this.progressBar);
    this.progressLabel = document.createElement("span");
    this.progressLabel.className = "workbench-progress-label";
    this.progressEl.appendChild(track);
    this.progressEl.appendChild(this.progressLabel);
    this.el.appendChild(this.progressEl);

    this.el.appendChild(sep());

    const briefingTitle = document.createElement("div");
    briefingTitle.className = "workbench-results-title";
    briefingTitle.textContent = "REGION BRIEFING · 3 DOMAINS × 5 WINDOWS";
    this.el.appendChild(briefingTitle);

    this.briefingEl = document.createElement("div");
    this.briefingEl.className = "workbench-briefing";
    this.el.appendChild(this.briefingEl);

    this.el.appendChild(sep());

    // Collapsible payload views.
    this.ingestEl = this.makeCollapsible("INGEST PAYLOAD → AGENT");
    this.payloadEl = this.makeCollapsible("REQUEST PAYLOAD");

    this.el.appendChild(sep());

    // Per-feed coverage / error panel (collapsed, virtualized).
    const feedsDetails = document.createElement("details");
    feedsDetails.className = "workbench-collapsible";
    const feedsSummary = document.createElement("summary");
    feedsSummary.innerHTML = `FEED STATUS <span class="workbench-summary-meta" data-feeds-meta></span>`;
    feedsDetails.appendChild(feedsSummary);

    this.feedsHealthEl = document.createElement("div");
    this.feedsHealthEl.className = "workbench-health";
    feedsDetails.appendChild(this.feedsHealthEl);

    this.feedsEl = document.createElement("div");
    this.feedsEl.className = "workbench-feeds";
    this.feedsInner = document.createElement("div");
    this.feedsInner.className = "workbench-feeds-inner";
    this.feedsEl.appendChild(this.feedsInner);
    feedsDetails.appendChild(this.feedsEl);

    // Virtualization: re-window on scroll and when the panel first opens.
    this.feedsEl.addEventListener("scroll", () => this.renderFeedWindow());
    feedsDetails.addEventListener("toggle", () => {
      if (feedsDetails.open) this.renderFeedWindow();
    });
    // Delegated retry (rows are recycled by the virtualizer).
    this.feedsInner.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-retry]");
      if (!btn) return;
      e.preventDefault();
      this.refresh();
    });

    this.el.appendChild(feedsDetails);

    this.el.appendChild(sep());

    // COLLECTED FEEDS — collapsed by default to shrink always-rendered DOM.
    const feedsRawDetails = document.createElement("details");
    feedsRawDetails.className = "workbench-collapsible";
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "COLLECTED FEEDS (RAW)";
    feedsRawDetails.appendChild(rawSummary);
    this.listEl = document.createElement("div");
    this.listEl.className = "workbench-list";
    feedsRawDetails.appendChild(this.listEl);
    this.el.appendChild(feedsRawDetails);

    this.el.appendChild(sep());

    // CATALOG SOURCES — collapsed + lazily rendered on first open.
    this.sourcesDetails = document.createElement("details");
    this.sourcesDetails.className = "workbench-collapsible";
    const sourcesSummary = document.createElement("summary");
    sourcesSummary.textContent = "CATALOG SOURCES";
    this.sourcesDetails.appendChild(sourcesSummary);
    this.sourcesEl = document.createElement("div");
    this.sourcesEl.className = "workbench-sources";
    this.sourcesDetails.appendChild(this.sourcesEl);
    this.sourcesDetails.addEventListener("toggle", () => {
      if (this.sourcesDetails.open && !this.sourcesRendered) this.renderSources();
    });
    this.el.appendChild(this.sourcesDetails);

    container.appendChild(this.el);
  }

  private makeCollapsible(label: string): HTMLPreElement {
    const wrap = document.createElement("details");
    wrap.className = "workbench-payload";
    const summary = document.createElement("summary");
    summary.textContent = label;
    wrap.appendChild(summary);
    const body = document.createElement("pre");
    body.className = "workbench-payload-body";
    wrap.appendChild(body);
    this.el.appendChild(wrap);
    return body;
  }

  get isOpen() {
    return this._open;
  }

  async loadFeedCatalog() {
    try {
      const resp = await fetch("/feed-catalog.json");
      this.catalog = (await resp.json()) as FeedCatalog;
      this.orchestrator = new CloudOrchestrator({
        catalog: this.catalog,
        sessionId: this.sessionId,
        appVersion: "0.1.0",
        endpoint: import.meta.env.VITE_ORCHESTRATOR_URL,
        agentEndpoint: import.meta.env.VITE_AGENT_URL,
      });
    } catch {
      this.sourcesEl.innerHTML =
        '<div class="workbench-placeholder">Catalog unavailable</div>';
    }
  }

  /** Build the payload for this click, render it, and run the full pipeline. */
  open(ctx: QueryContext) {
    this.abort?.abort();
    this.resetResults();

    // Warn on large jumps so the operator notices a context switch.
    if (this.lastCenter) {
      const jump = haversineKm(this.lastCenter, ctx);
      if (jump >= LOCATION_JUMP_KM) this.showBanner(jump);
    }
    this.lastCenter = { lat: ctx.lat, lon: ctx.lon };

    this.lastCtx = ctx;
    this.healthyCycles = 0;
    this.refreshIntervalMs = REFRESH_INTERVAL_MS;

    this._open = true;
    this.el.classList.add("open");
    this.startHeartbeat();

    if (!this.orchestrator) {
      this.renderHeaderFallback(ctx);
      return;
    }

    const req = this.orchestrator.buildRequest(ctx);
    this.renderHeader(req);
    this.payloadEl.textContent = JSON.stringify(req, null, 2);
    this.beginPipeline(req, false);
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove("open");
    document.body.classList.remove("ui-hover");
    this.abort?.abort();
    this.abort = null;
    this.stopTimers();
    this.setPollState("idle");
    this.onClose?.();
  }

  private beginPipeline(req: OrchestratorRequest, isRefresh: boolean) {
    // Initial collection animates assertively; background refreshes stay subtle.
    this.progressEl.classList.toggle("refresh", isRefresh);
    if (isRefresh) {
      this.resetFeedsOnly();
      this.setPollState("fetching");
    } else {
      this.setPollState("querying");
    }

    const feedCount = req.selectors.reduce((n, s) => {
      const cat = this.catalog?.categories.find((c) => c.id === s.categoryId);
      return n + (cat?.feeds.length ?? 0);
    }, 0);

    this.setProgress(2, `collecting · 0/${feedCount} feeds`, "querying");
    if (!isRefresh) {
      this.briefingEl.innerHTML = `
        <div class="workbench-placeholder">
          <div class="workbench-spinner"></div>
          <span>Collecting ${feedCount} feeds, then summarizing&hellip;</span>
          <span class="workbench-hint">${req.area.zoomTier.toUpperCase()} tile · geohash ${req.area.geohash}</span>
        </div>
      `;
    }

    const controller = new AbortController();
    this.abort = controller;

    void this.orchestrator!.dispatch(req, {
      signal: controller.signal,
      onChunk: (chunk) => {
        if (controller.signal.aborted) return;
        this.ingestFeatures(chunk.features);
        const { feedsReturned, feedsQueried } = chunk.meta;
        const pct = feedsQueried ? (feedsReturned / feedsQueried) * 50 : 0;
        this.setProgress(
          pct,
          `collecting · ${feedsReturned}/${feedsQueried} feeds`,
          "streaming",
        );
      },
      onAggregate: (payload) => {
        if (controller.signal.aborted) return;
        this.onAggregate(payload, isRefresh);
      },
      onBriefing: (chunk) => {
        if (controller.signal.aborted) return;
        this.onBriefing(chunk);
      },
      onError: () => {
        this.setPollState("degraded");
        this.progressLabel.textContent = "degraded · using cached simulation";
      },
    });
  }

  /** Stage-1 boundary: show the aggregated payload + scaffold the 15-cell grid. */
  private onAggregate(payload: AgentIngestPayload, isRefresh: boolean) {
    const s = payload.collection.stats;
    this.ingestEl.textContent = JSON.stringify(redactFeatures(payload), null, 2);
    this.renderFeedStatus(payload.collection.feeds);
    // Hand the same aggregated payload to the left-panel cloud agent.
    this.onPayload?.(payload);
    this.setPollState("synthesizing");
    // Live cloud reports no per-feed sweep (feedsTotal 0); show a cloud-centric
    // message instead of "aggregating 0 feeds".
    this.setProgress(
      52,
      s.feedsTotal > 0
        ? `aggregating ${s.feedsTotal} feeds (${s.featureCount} records) → agent`
        : "querying cloud · awaiting briefings",
      "streaming",
    );
    this.renderBriefingScaffold(payload, isRefresh);
  }

  /** Scaffold all 3×5 cells as pending. On refresh, existing cards are kept. */
  private renderBriefingScaffold(payload: AgentIngestPayload, isRefresh: boolean) {
    if (isRefresh && this.briefingCards.size > 0) return;

    this.briefingEl.innerHTML = "";
    this.briefingCards.clear();

    const domains = payload.briefing.domains.length ? payload.briefing.domains : DOMAINS;
    const windows = payload.briefing.windows.length ? payload.briefing.windows : WINDOWS;

    for (const domain of domains) {
      const block = document.createElement("div");
      block.className = "workbench-report";
      block.style.setProperty("--accent", DOMAIN_ACCENT[domain] ?? "#38bdf8");

      const head = document.createElement("div");
      head.className = "workbench-report-head";
      head.innerHTML = `<span class="workbench-report-dot"></span><span>${DOMAIN_LABEL[domain] ?? domain}</span>`;
      if (SLOW_DOMAINS.has(domain)) {
        const hint = document.createElement("span");
        hint.className = "workbench-report-hint";
        head.appendChild(hint);
        this.reportHints.set(domain, hint);
      }
      block.appendChild(head);

      for (const window of windows) {
        const card = document.createElement("div");
        card.className = "workbench-card workbench-card-pending";
        card.innerHTML = `
          <div class="workbench-card-lens">${WINDOW_LABEL[window] ?? window}</div>
          <div class="workbench-card-head"><div class="workbench-spinner"></div></div>
        `;
        block.appendChild(card);
        this.briefingCards.set(`${domain}.${window}`, card);
      }

      // One deduped source-link row per domain (shared across its 5 windows).
      const cites = document.createElement("div");
      cites.className = "workbench-report-cites";
      block.appendChild(cites);
      this.reportCites.set(domain, { el: cites, sources: new Map() });

      this.briefingEl.appendChild(block);
    }
  }

  /** A streamed briefing cell landed — update its card + domain header. */
  private onBriefing(chunk: BriefingChunk) {
    const { section, meta, report } = chunk;
    if (report) this.applyReportHeader(report);
    const card = this.briefingCards.get(section.id);
    if (card) this.fillCard(card, section);

    // Mirror the cloud's prose into the left Cloud Agent panel.
    this.onSection?.(chunk);

    const pct = 50 + (meta.sectionsExpected ? (meta.sectionsReturned / meta.sectionsExpected) * 50 : 0);
    if (meta.status === "complete") {
      this.setProgress(100, `briefing ready · ${meta.sectionsReturned} sections`, "complete");
      this.markUpdated();
    } else {
      this.setProgress(pct, `streaming · ${meta.sectionsReturned}/${meta.sectionsExpected} sections`, "streaming");
    }
  }

  /** Apply the cloud's per-domain label + accent to the scaffolded block. */
  private applyReportHeader(report: NonNullable<BriefingChunk["report"]>) {
    const block = this.briefingCards.get(`${report.domain}.hour`)?.parentElement;
    if (!block) return;
    if (report.accent) block.style.setProperty("--accent", report.accent);
    const labelEl = block.querySelector(".workbench-report-head span:nth-child(2)");
    if (labelEl && report.label) labelEl.textContent = report.label;
  }

  private fillCard(card: HTMLDivElement, s: BriefingSection) {
    card.classList.remove("workbench-card-pending");
    card.classList.add("workbench-card-enter", `state-${s.state}`);
    if (s.severity && s.severity !== "info") card.classList.add(`sev-${s.severity}`);

    const metrics = (s.metrics ?? [])
      .map(
        (m) => `<span class="workbench-chip${m.severity ? ` sev-${m.severity}` : ""}">${escape(m.label)}: ${escape(String(m.value))}${m.unit ? escape(m.unit) : ""}${m.delta != null ? ` (${m.delta >= 0 ? "+" : ""}${m.delta})` : ""}</span>`,
      )
      .join("");

    const bullets = (s.bullets ?? [])
      .map((b) => `<li>${escape(b)}</li>`)
      .join("");

    const conf = Math.round(s.confidence * 100);

    // No-data cells have no meaningful age — suppress the counter to avoid a
    // "no-data · 0s ago" contradiction; otherwise show freshness.
    const fresh = s.state === "no-data" ? null : freshnessBadge(s.freshness.observedAt);
    // Window label comes from the cloud (e.g. "Past hour"); fall back to id tail.
    const windowLabel = s.label || WINDOW_LABEL[s.window] || s.window;

    card.innerHTML = `
      <div class="workbench-card-lens">${escape(windowLabel)}${fresh ? `<span class="workbench-freshtag ${fresh.cls}">${fresh.text}</span>` : ""}</div>
      <div class="workbench-card-headline">${escape(s.headline)}</div>
      <div class="workbench-card-summary">${escape(s.summary)}</div>
      ${metrics ? `<div class="workbench-chips">${metrics}</div>` : ""}
      ${bullets ? `<ul class="workbench-card-bullets">${bullets}</ul>` : ""}
      <div class="workbench-card-foot">
        <span class="workbench-card-state">${escape(s.generatedVia ?? s.state)}</span>
        <span class="workbench-conf" title="confidence">
          <span class="workbench-conf-bar" style="width:${conf}%"></span>
        </span>
      </div>
    `;

    // Source links are collected once per report, not repeated on each lens card.
    this.addReportCitations(s.domain, s.citations);
  }

  private addReportCitations(domain: string, cites: Citation[]) {
    const entry = this.reportCites.get(domain);
    if (!entry) return;
    for (const c of cites) entry.sources.set(c.source, c);
    entry.el.innerHTML = [...entry.sources.values()]
      .map((c) =>
        c.link
          ? `<a class="workbench-cite" href="${encodeURI(c.link)}" target="_blank" rel="noopener" title="${escape(c.title)}">${escape(c.source)}</a>`
          : `<span class="workbench-cite">${escape(c.source)}</span>`,
      )
      .join("");
  }

  /** Aggregate health score + a virtualized, reliability-aware feed list. */
  private renderFeedStatus(feeds: FeedCollectionStat[]) {
    const order: Record<FeedHealthState, number> = { offline: 0, degraded: 1, healthy: 2 };
    this.feedStats = [...feeds].sort(
      (a, b) => order[healthOf(a)] - order[healthOf(b)],
    );

    let healthy = 0;
    let degraded = 0;
    let offline = 0;
    for (const f of feeds) {
      const h = healthOf(f);
      if (h === "healthy") healthy++;
      else if (h === "degraded") degraded++;
      else offline++;
    }
    const total = feeds.length;
    const score = total ? Math.round((healthy / total) * 100) : 0;

    const metaSpan = this.el.querySelector("[data-feeds-meta]");
    if (metaSpan) {
      const problems = degraded + offline;
      metaSpan.textContent = problems ? `· ${problems} impaired` : `· all healthy`;
      metaSpan.className = `workbench-summary-meta${problems ? " has-error" : ""}`;
    }

    this.feedsHealthEl.innerHTML = `
      <div class="workbench-health-row">
        <span class="workbench-health-score">${healthy}/${total} healthy · ${score}%</span>
        <span class="workbench-health-pills">
          <span class="hp healthy" title="healthy">${healthy}</span>
          <span class="hp degraded" title="degraded">${degraded}</span>
          <span class="hp offline" title="offline">${offline}</span>
        </span>
      </div>
      <div class="workbench-health-track"><span style="width:${score}%"></span></div>
    `;

    this.feedsInner.style.minHeight = `${this.feedStats.length * FEED_ROW_H}px`;
    this.renderFeedWindow();
  }

  /** Render only the rows currently scrolled into view. */
  private renderFeedWindow() {
    const n = this.feedStats.length;
    if (n === 0) {
      this.feedsInner.innerHTML = "";
      this.feedsInner.style.paddingTop = "0px";
      return;
    }
    const viewH = this.feedsEl.clientHeight || 240;
    const scrollTop = this.feedsEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / FEED_ROW_H) - 4);
    const end = Math.min(n, Math.ceil((scrollTop + viewH) / FEED_ROW_H) + 4);

    this.feedsInner.style.paddingTop = `${start * FEED_ROW_H}px`;
    this.feedsInner.style.paddingBottom = `${(n - end) * FEED_ROW_H}px`;
    this.feedsInner.innerHTML = this.feedStats
      .slice(start, end)
      .map((f) => feedRowHtml(f))
      .join("");
  }

  /** Reconcile incoming raw features into category groups; only new ids animate. */
  private ingestFeatures(features: CloudFeature[]) {
    const fresh = features.filter((f) => !this.seen.has(f.id));
    if (fresh.length === 0) return;

    if (this.listEl.querySelector(".workbench-placeholder")) {
      this.listEl.innerHTML = "";
    }

    let staggerIndex = 0;
    for (const f of fresh) {
      this.seen.add(f.id);
      const group = this.ensureGroup(f.category);
      const row = this.buildRow(f);
      row.style.animationDelay = `${staggerIndex * 60}ms`;
      staggerIndex++;
      group.list.appendChild(row);
      group.ids.add(f.id);
    }
  }

  private ensureGroup(categoryId: string): ResultGroup {
    const existing = this.groups.get(categoryId);
    if (existing) return existing;

    const section = document.createElement("div");
    section.className = "workbench-group";
    const header = document.createElement("div");
    header.className = "workbench-group-title";
    header.textContent = CATEGORY_LABELS[categoryId] ?? categoryId.toUpperCase();
    const list = document.createElement("div");
    list.className = "workbench-group-list";
    section.appendChild(header);
    section.appendChild(list);
    this.listEl.appendChild(section);

    const group: ResultGroup = { section, list, ids: new Set() };
    this.groups.set(categoryId, group);
    return group;
  }

  private buildRow(f: CloudFeature): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "workbench-item workbench-item-enter";
    if (f.severity && f.severity !== "info") {
      row.classList.add(`sev-${f.severity}`);
    }
    const dist =
      f.distanceKm != null ? `<span class="workbench-item-dist">${f.distanceKm.toFixed(1)} km</span>` : "";
    row.innerHTML = `
      <span class="workbench-item-type">${escape(f.kind)}</span>
      <span class="workbench-item-body">
        <span class="workbench-item-name">${escape(f.title)}</span>
        <span class="workbench-item-source">${escape(f.source)}${dist}</span>
      </span>
    `;
    return row;
  }

  /* ----------------------------- live updates ---------------------------- */

  private markUpdated() {
    this.lastUpdatedAt = Date.now();
    this.setPollState("live");

    // Adaptive throttling: relax cadence when everything's been healthy a while,
    // snap back to the fast cadence the moment anything is impaired.
    const allHealthy = this.feedStats.every((f) => healthOf(f) === "healthy");
    if (allHealthy) this.healthyCycles++;
    else this.healthyCycles = 0;
    this.refreshIntervalMs =
      this.healthyCycles >= HEALTHY_CYCLES_TO_RELAX
        ? REFRESH_INTERVAL_RELAXED_MS
        : REFRESH_INTERVAL_MS;

    this.updateFreshness();
    this.scheduleRefresh();
  }

  private startHeartbeat() {
    if (this.heartbeat != null) return;
    this.heartbeat = window.setInterval(() => this.updateFreshness(), 1000);
  }

  private scheduleRefresh() {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.nextRefreshAt = Date.now() + this.refreshIntervalMs;
    this.refreshTimer = window.setTimeout(() => this.refresh(), this.refreshIntervalMs);
  }

  private showBanner(jumpKm: number) {
    this.bannerEl.textContent = `LOCATION CHANGED · ${Math.round(jumpKm)} km jump`;
    this.bannerEl.classList.add("show");
    window.setTimeout(() => this.bannerEl.classList.remove("show"), 4000);
  }

  /** Silently re-poll the same area, updating cards in place. */
  private refresh() {
    if (!this._open || !this.orchestrator || !this.lastCtx) return;
    this.abort?.abort();
    this.nextRefreshAt = null;
    const req = this.orchestrator.buildRequest(this.lastCtx);
    this.payloadEl.textContent = JSON.stringify(req, null, 2);
    this.beginPipeline(req, true);
  }

  private updateFreshness() {
    if (this.lastUpdatedAt == null) {
      this.freshEl.textContent = "";
      return;
    }
    const now = Date.now();
    const age = now - this.lastUpdatedAt;
    // The pill already conveys "REFRESHING"; the freshness line never repeats it.
    let txt = `updated ${formatAge(age)} ago`;
    if (
      this.pollState !== "fetching" &&
      this.nextRefreshAt &&
      this.nextRefreshAt > now
    ) {
      txt += ` · next in ${formatAge(this.nextRefreshAt - now)}`;
    }
    this.freshEl.textContent = txt;

    // Slow-cycling reports get an explicit wall-clock refresh time.
    const clock = this.nextRefreshAt ? clockTime(this.nextRefreshAt) : null;
    for (const hint of this.reportHints.values()) {
      hint.textContent = clock ? `next refresh ${clock}` : "";
    }

    if (this.pollState === "live" && age > STALE_AFTER_MS) {
      this.setPollState("stale");
    }
  }

  private setPollState(state: PollState) {
    this.pollState = state;
    this.statusEl.textContent = POLL_LABEL[state];
    this.statusEl.dataset.state = state;
  }

  private setProgress(pct: number, label: string, state: string) {
    this.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    this.progressEl.dataset.state = state;
    this.progressLabel.textContent = label;
  }

  private stopTimers() {
    if (this.heartbeat != null) window.clearInterval(this.heartbeat);
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.heartbeat = null;
    this.refreshTimer = null;
  }

  private resetResults() {
    this.groups.clear();
    this.seen.clear();
    this.briefingCards.clear();
    this.reportCites.clear();
    this.reportHints.clear();
    this.feedStats = [];
    this.listEl.innerHTML = "";
    this.briefingEl.innerHTML = "";
    this.feedsInner.innerHTML = "";
    this.feedsHealthEl.innerHTML = "";
    this.ingestEl.textContent = "";
    this.lastUpdatedAt = null;
    this.nextRefreshAt = null;
    this.freshEl.textContent = "";
  }

  /** Clear only the raw-feed list (briefing cards are updated in place). */
  private resetFeedsOnly() {
    this.groups.clear();
    this.seen.clear();
    this.listEl.innerHTML = "";
  }

  private renderHeader(req: OrchestratorRequest) {
    const a = req.area;
    this.headerEl.innerHTML = `
      ${field("CENTER", `${a.center.lat.toFixed(4)}°, ${a.center.lon.toFixed(4)}°`)}
      ${field("RADIUS", `${a.radiusKm.toFixed(1)} km`)}
      ${field("ZOOM", a.zoomTier.toUpperCase())}
      ${field("GEOHASH", a.geohash)}
      ${field("RANK BY", req.response.rankBy.toUpperCase())}
    `;
  }

  private renderHeaderFallback(ctx: QueryContext) {
    this.headerEl.innerHTML = `
      ${field("CENTER", `${ctx.lat.toFixed(4)}°, ${ctx.lon.toFixed(4)}°`)}
      ${field("RADIUS", `${ctx.radiusKm.toFixed(1)} km`)}
    `;
    this.briefingEl.innerHTML = `<div class="workbench-placeholder">Catalog not loaded</div>`;
  }

  private renderSources() {
    if (!this.catalog) return;
    this.sourcesRendered = true;
    this.sourcesEl.innerHTML = this.catalog.categories
      .map(
        (cat) => `
      <div class="workbench-source-cat">
        <div class="workbench-source-cat-name">${cat.name}</div>
        ${cat.feeds
          .map(
            (f) => `
          <div class="workbench-source-item" title="${f.endpoint}">
            <span class="workbench-source-name">${f.name}</span>
            <span class="workbench-source-meta">${f.provider} · ${f.format}</span>
          </div>
        `,
          )
          .join("")}
      </div>
    `,
      )
      .join("");
  }
}

/** Trim the bulky raw feature arrays so the payload preview stays readable. */
function redactFeatures(payload: AgentIngestPayload): unknown {
  return {
    ...payload,
    features: `[${payload.features.length} features omitted from preview]`,
    groups: Object.fromEntries(
      Object.entries(payload.groups).map(([k, v]) => [k, `[${v.length} features]`]),
    ),
  };
}

function field(label: string, value: string): string {
  return `
    <div class="workbench-field">
      <span class="workbench-label">${label}</span>
      <span class="workbench-value">${value}</span>
    </div>`;
}

function sep(): HTMLDivElement {
  const s = document.createElement("div");
  s.className = "workbench-sep";
  return s;
}

/** Great-circle distance (km) between two lat/lon points. */
function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Wall-clock like "5:32 PM". */
function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Human age like "12s", "5m", "2h". */
function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** Color-coded staleness badge from an ISO observation time. */
function freshnessBadge(iso: string): { text: string; cls: string } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { text: "", cls: "" };
  const age = Date.now() - t;
  const text = `${formatAge(age)} ago`;
  if (age < 5 * 60_000) return { text, cls: "fresh" };
  if (age < 30 * 60_000) return { text, cls: "recent" };
  return { text, cls: "stale" };
}

/** Reliability classification, falling back to status when absent. */
function healthOf(f: FeedCollectionStat): FeedHealthState {
  if (f.health) return f.health;
  if (f.status === "ok" || f.status === "empty") return "healthy";
  if (f.status === "offline") return "offline";
  return "degraded";
}

function feedRowHtml(f: FeedCollectionStat): string {
  const h = healthOf(f);
  const retry =
    h !== "healthy" ? `<button class="workbench-retry" data-retry>retry</button>` : "";
  let detail: string;
  if (h === "offline") {
    detail = escape(f.error ?? "circuit open");
  } else if (h === "degraded") {
    const via = f.fallback ? ` · via ${escape(f.fallback)}` : "";
    detail = `${escape(f.status)} · try ${f.attempts ?? 1}/3${via}`;
  } else {
    const budget = f.deadlineMs ? ` · ${f.deadlineMs}ms` : "";
    detail = `${f.featureCount} rec${f.featureCount === 1 ? "" : "s"}${budget}`;
  }
  return `
    <div class="workbench-feed-row health-${h} status-${f.status}" style="height:${FEED_ROW_H}px">
      <span class="workbench-feed-badge">${h}</span>
      <span class="workbench-feed-name">${escape(f.feedId)}</span>
      <span class="workbench-feed-detail">${detail}</span>
      ${retry}
    </div>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "sess-" + Math.random().toString(36).slice(2);
}
