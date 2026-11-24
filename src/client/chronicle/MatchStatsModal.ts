import { html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../Utils";
import {
  describeEvent,
  EVENT_ICONS,
  formatMatchTime,
  isKeyMoment,
} from "./ChronicleText";
import type { ChronicleEvent, MatchChronicle } from "./MatchChronicle";

type Metric = "tiles" | "gold" | "troops";
const METRIC_INDEX: Record<Metric, 0 | 1 | 2> = {
  tiles: 0,
  gold: 1,
  troops: 2,
};
/** Players shown at first besides the recording one. */
const DEFAULT_RIVALS = 5;
/** Players offered in the legend. */
const LEGEND_PLAYERS = 16;

const W = 800;
const H = 300;
const PAD_L = 56;
const PAD_R = 12;
const PAD_T = 24;
const PAD_B = 24;

/** 12_345 → "12.3K", 4_500_000 → "4.5M". */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * The players the graphs start with: the recording player, whoever betrayed
 * or eliminated them, then the biggest (by peak territory).
 */
export function defaultSelection(chronicle: MatchChronicle): number[] {
  const me = chronicle.me();
  const peak = new Map<number, number>();
  for (const s of chronicle.samples()) {
    for (const [id, v] of Object.entries(s.values)) {
      const key = Number(id);
      peak.set(key, Math.max(peak.get(key) ?? 0, v[0]));
    }
  }
  const chosen: number[] = [];
  const add = (id: number | undefined) => {
    if (id === undefined || id < 0 || chosen.includes(id)) return;
    if (!peak.has(id)) return;
    chosen.push(id);
  };
  add(me ?? undefined);
  if (me !== null) {
    for (const e of chronicle.events()) {
      if ((e.kind === "betrayal" || e.kind === "eliminated") && e.b === me) {
        add(e.a);
      }
      if (e.kind === "eliminated" && e.a === me) add(e.b);
    }
  }
  const biggest = [...peak.entries()].sort((a, b) => b[1] - a[1]);
  for (const [id] of biggest) {
    if (chosen.length >= DEFAULT_RIVALS + 1) break;
    add(id);
  }
  return chosen;
}

/**
 * <match-stats-modal>: after a game (or for a past one, from "My games"):
 * how territory, gold and troops went over time, one line per player, with
 * the key moments marked on the time axis ("here X betrayed you") and listed
 * below. Reads a MatchChronicle.
 */
@customElement("match-stats-modal")
export class MatchStatsModal extends LitElement {
  @state() private chronicle: MatchChronicle | null = null;
  @state() private metric: Metric = "tiles";
  @state() private selected: number[] = [];
  @state() private hoverIndex: number | null = null;
  @state() private heading = "";

  createRenderRoot() {
    return this;
  }

  show(chronicle: MatchChronicle, heading?: string): void {
    this.chronicle = chronicle;
    this.selected = defaultSelection(chronicle);
    this.metric = "tiles";
    this.hoverIndex = null;
    this.heading = heading ?? translateText("match_stats.title");
  }

  close(): void {
    this.chronicle = null;
  }

  isOpen(): boolean {
    return this.chronicle !== null;
  }

  private range(): { start: number; end: number } {
    const c = this.chronicle!;
    const samples = c.samples();
    const start = c.startTick() ?? samples[0]?.tick ?? 0;
    const end = Math.max(
      start + 1,
      samples[samples.length - 1]?.tick ?? start + 1,
      c.lastTick(),
    );
    return { start, end };
  }

  private x(tick: number, start: number, end: number): number {
    return PAD_L + ((tick - start) / (end - start)) * (W - PAD_L - PAD_R);
  }

  private maxValue(): number {
    const index = METRIC_INDEX[this.metric];
    let max = 1;
    for (const s of this.chronicle!.samples()) {
      for (const id of this.selected) {
        const v = s.values[id];
        if (v !== undefined) max = Math.max(max, v[index]);
      }
    }
    return max;
  }

  private renderChart(): TemplateResult {
    const c = this.chronicle!;
    const samples = c.samples();
    const { start, end } = this.range();
    const max = this.maxValue();
    const index = METRIC_INDEX[this.metric];
    const y = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);

    const lines = this.selected.map((id) => {
      const color = c.player(id)?.color ?? "#ffffff";
      const segments: string[][] = [];
      let current: string[] = [];
      for (const s of samples) {
        const v = s.values[id];
        if (v === undefined) {
          if (current.length > 0) segments.push(current);
          current = [];
          continue;
        }
        current.push(
          `${this.x(s.tick, start, end).toFixed(1)},${y(v[index]).toFixed(1)}`,
        );
      }
      if (current.length > 0) segments.push(current);
      const isMe = id === c.me();
      return segments.map(
        (points) => svg`<polyline
          points=${points.join(" ")}
          fill="none"
          stroke=${color}
          stroke-width=${isMe ? 3 : 1.8}
          stroke-linejoin="round"
          opacity=${isMe ? 1 : 0.85}
        ></polyline>`,
      );
    });

    const moments = c
      .events()
      .filter((e) => isKeyMoment(e, c.me()) && e.tick >= start);
    const markers = moments.map((e) => {
      const mx = this.x(e.tick, start, end);
      return svg`<g>
        <title>${formatMatchTime(e.tick, c.startTick())} ${describeEvent(e, c)}</title>
        <line x1=${mx} x2=${mx} y1=${PAD_T} y2=${H - PAD_B}
          stroke=${e.kind === "betrayal" ? "#f87171" : "#ffffff55"}
          stroke-dasharray="4 3"></line>
        <text x=${mx} y=${PAD_T - 6} text-anchor="middle" font-size="14">${EVENT_ICONS[e.kind]}</text>
      </g>`;
    });

    const grid = [0, 0.5, 1].map((f) => {
      const gy = y(max * f);
      return svg`<g>
        <line x1=${PAD_L} x2=${W - PAD_R} y1=${gy} y2=${gy} stroke="#ffffff22"></line>
        <text x=${PAD_L - 6} y=${gy + 4} text-anchor="end" font-size="11" fill="#ffffffaa">${compactNumber(max * f)}</text>
      </g>`;
    });
    const timeLabels = [0, 0.5, 1].map((f) => {
      const t = start + (end - start) * f;
      return svg`<text x=${this.x(t, start, end)} y=${H - 6}
        text-anchor=${f === 0 ? "start" : f === 1 ? "end" : "middle"}
        font-size="11" fill="#ffffffaa">${formatMatchTime(t, c.startTick())}</text>`;
    });

    let hover: TemplateResult | typeof nothing = nothing;
    const hi = this.hoverIndex;
    if (hi !== null && samples[hi] !== undefined) {
      const hx = this.x(samples[hi].tick, start, end);
      hover = svg`<line x1=${hx} x2=${hx} y1=${PAD_T} y2=${H - PAD_B} stroke="#ffffff88"></line>`;
    }

    return html`<svg
      viewBox="0 0 ${W} ${H}"
      class="w-full h-auto select-none"
      data-stats-chart
      @mousemove=${(e: MouseEvent) => this.onHover(e)}
      @mouseleave=${() => (this.hoverIndex = null)}
    >
      ${grid} ${timeLabels} ${lines} ${markers} ${hover}
    </svg>`;
  }

  private onHover(e: MouseEvent): void {
    const svgEl = e.currentTarget as SVGSVGElement;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const samples = this.chronicle!.samples();
    if (samples.length === 0) return;
    const { start, end } = this.range();
    let best = 0;
    let bestDist = Infinity;
    samples.forEach((s, i) => {
      const d = Math.abs(this.x(s.tick, start, end) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    this.hoverIndex = best;
  }

  private renderHoverValues(): TemplateResult | typeof nothing {
    const c = this.chronicle!;
    const hi = this.hoverIndex;
    const sample = hi === null ? undefined : c.samples()[hi];
    if (sample === undefined) return nothing;
    const index = METRIC_INDEX[this.metric];
    const rows = this.selected
      .map((id) => ({ id, v: sample.values[id]?.[index] }))
      .filter((r): r is { id: number; v: number } => r.v !== undefined)
      .sort((a, b) => b.v - a.v);
    return html`<div
      class="text-xs text-white/80 flex flex-wrap gap-x-3 gap-y-0.5 mt-1"
    >
      <span class="text-white/50"
        >${formatMatchTime(sample.tick, c.startTick())}</span
      >
      ${rows.map(
        (r) =>
          html`<span
            ><span style="color:${c.player(r.id)?.color ?? "#fff"}">●</span>
            ${c.player(r.id)?.name ?? "?"}: ${compactNumber(r.v)}</span
          >`,
      )}
    </div>`;
  }

  private legendPlayers(): number[] {
    const c = this.chronicle!;
    const peak = new Map<number, number>();
    for (const s of c.samples()) {
      for (const [id, v] of Object.entries(s.values)) {
        peak.set(Number(id), Math.max(peak.get(Number(id)) ?? 0, v[0]));
      }
    }
    const ordered = [...peak.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const shown = new Set(this.selected);
    const extra = ordered.filter((id) => !shown.has(id));
    return [...this.selected, ...extra].slice(
      0,
      Math.max(LEGEND_PLAYERS, this.selected.length),
    );
  }

  private toggle(id: number): void {
    this.selected = this.selected.includes(id)
      ? this.selected.filter((s) => s !== id)
      : [...this.selected, id];
  }

  private summary(): TemplateResult | typeof nothing {
    const c = this.chronicle!;
    const me = c.me();
    if (me === null) return nothing;
    let peakTiles = 0;
    let peakGold = 0;
    let peakTroops = 0;
    for (const s of c.samples()) {
      const v = s.values[me];
      if (v === undefined) continue;
      peakTiles = Math.max(peakTiles, v[0]);
      peakGold = Math.max(peakGold, v[1]);
      peakTroops = Math.max(peakTroops, v[2]);
    }
    const count = (
      kind: ChronicleEvent["kind"],
      mine: (e: ChronicleEvent) => boolean,
    ) => c.events().filter((e) => e.kind === kind && mine(e)).length;
    const stats: [string, string][] = [
      [translateText("match_stats.peak_tiles"), compactNumber(peakTiles)],
      [translateText("match_stats.peak_gold"), compactNumber(peakGold)],
      [translateText("match_stats.peak_troops"), compactNumber(peakTroops)],
      [
        translateText("match_stats.wars"),
        String(count("war", (e) => e.a === me || e.b === me)),
      ],
      [
        translateText("match_stats.alliances"),
        String(count("alliance", (e) => e.a === me || e.b === me)),
      ],
      [
        translateText("match_stats.betrayed_you"),
        String(count("betrayal", (e) => e.b === me)),
      ],
      [
        translateText("match_stats.eliminated_players"),
        String(count("eliminated", (e) => e.b === me)),
      ],
    ];
    return html`<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
      ${stats.map(
        ([label, value]) =>
          html`<div class="bg-white/5 rounded px-2 py-1">
            <div class="text-[11px] text-white/60">${label}</div>
            <div class="text-base font-semibold tabular-nums">${value}</div>
          </div>`,
      )}
    </div>`;
  }

  render() {
    const c = this.chronicle;
    if (c === null) return nothing;
    const moments = c.events().filter((e) => isKeyMoment(e, c.me()));
    const tab = (metric: Metric, label: string) =>
      html`<button
        type="button"
        data-metric=${metric}
        class="px-3 py-1 rounded text-sm ${
          this.metric === metric
            ? "bg-blue-600 text-white"
            : "bg-white/10 text-white/80 hover:bg-white/20"
        }"
        @click=${() => (this.metric = metric)}
      >
        ${label}
      </button>`;
    return html`
      <div
        class="fixed inset-0 z-[10020] bg-black/60 flex items-center justify-center p-3"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) this.close();
        }}
      >
        <div
          class="bg-gray-800/95 text-white rounded-lg shadow-2xl w-[min(96vw,900px)] max-h-[92dvh] overflow-y-auto p-4"
          data-match-stats
        >
          <div class="flex items-center justify-between mb-3">
            <h2 class="m-0 text-xl">${this.heading}</h2>
            <button
              type="button"
              class="text-white/70 hover:text-white text-2xl leading-none"
              aria-label=${translateText("match_stats.close")}
              @click=${() => this.close()}
            >
              ×
            </button>
          </div>
          ${
            c.samples().length === 0
              ? html`<p class="text-white/70">
                  ${translateText("match_stats.no_data")}
                </p>`
              : html`
                  ${this.summary()}
                  <div class="flex gap-2 mb-2">
                    ${tab("tiles", translateText("match_stats.tiles"))}
                    ${tab("gold", translateText("match_stats.gold"))}
                    ${tab("troops", translateText("match_stats.troops"))}
                  </div>
                  ${this.renderChart()} ${this.renderHoverValues()}
                  <div class="flex flex-wrap gap-1.5 mt-3">
                    ${this.legendPlayers().map((id) => {
                      const p = c.player(id);
                      const on = this.selected.includes(id);
                      return html`<button
                        type="button"
                        class="flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${
                          on
                            ? "border-white/40 bg-white/10"
                            : "border-white/10 text-white/50"
                        }"
                        @click=${() => this.toggle(id)}
                      >
                        <span style="color:${p?.color ?? "#fff"}">●</span>
                        ${p?.name ?? "?"}${
                          id === c.me()
                            ? html` <span class="text-white/50"
                                >(${translateText("match_stats.you")})</span
                              >`
                            : nothing
                        }
                      </button>`;
                    })}
                  </div>
                `
          }
          <h3 class="mt-4 mb-2 text-base">
            ${translateText("match_stats.moments")}
          </h3>
          ${
            moments.length === 0
              ? html`<p class="text-white/60 text-sm">
                  ${translateText("match_stats.no_moments")}
                </p>`
              : html`<ul class="text-sm flex flex-col gap-1">
                  ${moments.map(
                    (e) =>
                      html`<li
                        class="flex gap-2 ${e.kind === "betrayal" ? "text-red-300" : ""}"
                      >
                        <span class="tabular-nums text-white/50 w-14 shrink-0"
                          >${formatMatchTime(e.tick, c.startTick())}</span
                        >
                        <span>${EVENT_ICONS[e.kind]}</span>
                        <span>${describeEvent(e, c)}</span>
                      </li>`,
                  )}
                </ul>`
          }
        </div>
      </div>
    `;
  }
}

/** Shows the statistics modal for a chronicle, creating it on first use. */
export function openMatchStats(
  chronicle: MatchChronicle,
  heading?: string,
): void {
  let modal = document.querySelector<MatchStatsModal>("match-stats-modal");
  if (modal === null) {
    modal = document.createElement("match-stats-modal") as MatchStatsModal;
    document.body.appendChild(modal);
  }
  modal.show(chronicle, heading);
}
