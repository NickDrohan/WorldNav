import type { QueryContext } from "../cloud/Orchestrator";
import type { BriefingChunk, ReportDomain } from "../cloud/types";
import "./agent-panel.css";

const DOMAIN_LABEL: Record<string, string> = {
  science: "Science & Sky",
  governance: "Governance",
  social: "Social & News",
};

const DOMAIN_ACCENT: Record<string, string> = {
  science: "#38bdf8",
  governance: "#a78bfa",
  social: "#fb7185",
};

type PanelState = "idle" | "analyzing" | "streaming" | "ready" | "degraded";

const STATE_LABEL: Record<PanelState, string> = {
  idle: "IDLE",
  analyzing: "CONTACTING CLOUD",
  streaming: "STREAMING",
  ready: "READY",
  degraded: "DEGRADED",
};

interface DomainBlock {
  cellsEl: HTMLDivElement;
  cells: Map<string, HTMLDivElement>;
}

/**
 * Left-side panel: the cloud agent's human-readable briefings for the clicked
 * area. It consumes the same streamed {@link BriefingChunk} sequence the right
 * panel renders as a grid, but presents it as prose grouped by domain
 * (3 domains × 5 time windows).
 */
export class AgentPanel {
  private el: HTMLDivElement;
  private statusEl: HTMLSpanElement;
  private metaEl: HTMLSpanElement;
  private headerEl: HTMLDivElement;
  private bodyEl: HTMLDivElement;

  private blocks = new Map<string, DomainBlock>();
  private _open = false;

  onClose?: () => void;

  constructor(container: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "agent-panel";

    this.el.addEventListener("pointerenter", () =>
      document.body.classList.add("ui-hover"),
    );
    this.el.addEventListener("pointerleave", () =>
      document.body.classList.remove("ui-hover"),
    );

    const closeBtn = document.createElement("button");
    closeBtn.className = "agent-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());
    this.el.appendChild(closeBtn);

    const title = document.createElement("div");
    title.className = "agent-title";
    title.textContent = "CLOUD AGENT · AREA BRIEFING";
    this.el.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "agent-meta";
    this.statusEl = document.createElement("span");
    this.statusEl.className = "agent-status";
    this.metaEl = document.createElement("span");
    this.metaEl.className = "agent-metatext";
    meta.appendChild(this.statusEl);
    meta.appendChild(this.metaEl);
    this.el.appendChild(meta);
    this.setState("idle");

    this.headerEl = document.createElement("div");
    this.headerEl.className = "agent-header";
    this.el.appendChild(this.headerEl);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "agent-topics";
    this.el.appendChild(this.bodyEl);

    container.appendChild(this.el);
  }

  get isOpen() {
    return this._open;
  }

  /** Reveal the panel and show a pre-briefing header for the click context. */
  open(ctx: QueryContext) {
    this._open = true;
    this.el.classList.add("open");
    this.reset();
    this.setState("analyzing");
    this.headerEl.innerHTML = `
      ${field("CENTER", `${ctx.lat.toFixed(4)}°, ${ctx.lon.toFixed(4)}°`)}
      ${field("RADIUS", `${ctx.radiusKm.toFixed(1)} km`)}
    `;
    this.bodyEl.innerHTML = `<div class="agent-pending"><span class="agent-spinner"></span> Awaiting cloud briefings…</div>`;
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this.el.classList.remove("open");
    document.body.classList.remove("ui-hover");
    this.onClose?.();
  }

  /** Fold one streamed briefing cell into the per-domain prose digest. */
  ingestSection(chunk: BriefingChunk) {
    if (!this._open) return;
    const { section, meta, report } = chunk;

    if (this.bodyEl.querySelector(".agent-pending")) this.bodyEl.innerHTML = "";
    if (this.statusEl.dataset.state !== "ready") this.setState("streaming");

    const block = this.ensureBlock(section.domain, report?.label, report?.accent);

    // Upsert the cell prose, keyed by section.id, so refresh updates in place.
    let cell = block.cells.get(section.id);
    if (!cell) {
      cell = document.createElement("div");
      cell.className = "agent-cell";
      block.cellsEl.appendChild(cell);
      block.cells.set(section.id, cell);
    }
    const muted = section.state === "no-data" ? " muted" : "";
    cell.innerHTML = `
      <span class="agent-cell-win">${escape(section.label || section.window)}</span>
      <span class="agent-cell-text${muted}">${escape(section.summary)}</span>
    `;

    if (meta.status === "complete") {
      this.setState("ready");
      this.metaEl.textContent = `${meta.sectionsReturned} briefings`;
    } else {
      this.metaEl.textContent = `${meta.sectionsReturned}/${meta.sectionsExpected}`;
    }
  }

  private ensureBlock(
    domain: ReportDomain,
    label?: string,
    accent?: string,
  ): DomainBlock {
    const existing = this.blocks.get(domain);
    if (existing) {
      if (accent) existing.cellsEl.parentElement?.style.setProperty("--accent", accent);
      return existing;
    }
    const wrap = document.createElement("div");
    wrap.className = "agent-topic";
    wrap.style.setProperty("--accent", accent ?? DOMAIN_ACCENT[domain] ?? "#38bdf8");

    const head = document.createElement("div");
    head.className = "agent-topic-head";
    head.innerHTML = `<span>${escape(label ?? DOMAIN_LABEL[domain] ?? domain)}</span>`;
    wrap.appendChild(head);

    const cellsEl = document.createElement("div");
    cellsEl.className = "agent-cells";
    wrap.appendChild(cellsEl);

    this.bodyEl.appendChild(wrap);
    const block: DomainBlock = { cellsEl, cells: new Map() };
    this.blocks.set(domain, block);
    return block;
  }

  private setState(state: PanelState) {
    this.statusEl.textContent = STATE_LABEL[state];
    this.statusEl.dataset.state = state;
  }

  private reset() {
    this.blocks.clear();
    this.bodyEl.innerHTML = "";
    this.metaEl.textContent = "";
  }
}

function field(label: string, value: string): string {
  return `
    <div class="agent-field">
      <span class="agent-flabel">${label}</span>
      <span class="agent-fvalue">${value}</span>
    </div>`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
