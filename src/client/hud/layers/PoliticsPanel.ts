import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  DECREES,
  DecreeOutcome,
  DecreeType,
  PoliticsViewState,
  ProposalView,
  VoteChoice,
} from "@openfront/engine-api/game/Politics";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { CastVoteIntentEvent, ProposeDecreeIntentEvent } from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";
import {
  Advice,
  adviceFor,
  DECREE_ICONS,
  forecast,
} from "./politics/DecreeAdvice";

/** How long the results of a round stay on screen, in ticks. */
const RESULTS_TICKS = 100;
/** Names listed per vote in the results before "and N more". */
const MAX_NAMES = 12;

const OUTCOME_COLORS: Record<DecreeOutcome, string> = {
  passed: "text-green-400",
  failed: "text-red-400",
  vetoed: "text-orange-400",
  no_quorum: "text-gray-400",
  no_slot: "text-gray-400",
};

/**
 * The world congress on screen (GameFeature.Politics): the decrees in force
 * and the countdown to the next round, the three offers while proposing, the
 * ballot while the game is frozen for the vote, and the results.
 */
@customElement("politics-panel")
export class PoliticsPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private renderTick = 0;
  /** Round (phaseStart) the player chose not to propose in. */
  @state() private skippedRound = -1;
  /** Results (resultsTick) the player closed. */
  @state() private closedResults = -1;
  @state() private targets = new Map<DecreeType, string>();
  @state() private collapsed = false;
  /** Decree in force (id) whose details are open: hover, or tap on touch. */
  @state() private hoveredDecree: number | null = null;

  createRenderRoot() {
    return this;
  }

  init() {
    this.skippedRound = -1;
    this.closedResults = -1;
    this.targets = new Map();
    this.requestUpdate();
  }

  getTickIntervalMs(): number {
    return 200;
  }

  tick() {
    if (!this.game) return;
    this.renderTick++;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private seconds(ticks: number): number {
    return Math.max(0, Math.ceil(ticks / 10));
  }

  private clock(ticks: number): string {
    const s = this.seconds(ticks);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private player(smallID: number | null): PlayerView | null {
    if (smallID === null) return null;
    const p = this.game.playerBySmallID(smallID);
    return p.isPlayer() ? (p as PlayerView) : null;
  }

  private nameOf(smallID: number | null): string {
    return this.player(smallID)?.displayName() ?? "?";
  }

  private decreeName(d: DecreeType): string {
    return translateText(`politics.decree.${d}`);
  }

  /** Name with its icon (openfront v2: recognisable at a glance). */
  private decreeTitle(d: DecreeType): string {
    return `${DECREE_ICONS[d] ?? ""} ${this.decreeName(d)}`;
  }

  /** "Good / bad for you" and why. */
  private renderAdvice(a: Advice | null): TemplateResult | typeof nothing {
    if (a === null) return nothing;
    const good = a.score > 0.15;
    const bad = a.score < -0.15;
    const cls = good
      ? "bg-green-800/70 text-green-100"
      : bad
        ? "bg-red-800/70 text-red-100"
        : "bg-gray-700 text-gray-200";
    const label = translateText(
      good
        ? "politics_advice.good"
        : bad
          ? "politics_advice.bad"
          : "politics_advice.neutral_label",
    );
    return html`<div class="mb-2 rounded px-2 py-1 text-xs ${cls}">
      ${good ? "🟢" : bad ? "🔴" : "⚪"} <b>${label}</b> ·
      ${translateText(`politics_advice.${a.reason}`)}
    </div>`;
  }

  private decreeDesc(d: DecreeType): string {
    return translateText(`politics.decree_desc.${d}`);
  }

  private costOf(percent: number): bigint {
    const gold = this.game.myPlayer()?.gold() ?? 0n;
    return BigInt(Math.floor(Number(gold) * (percent / 100)));
  }

  private isProtected(s: PoliticsViewState, smallID: number): boolean {
    if (s.lastMalusTarget === smallID) return true;
    if (s.active.some((d) => DECREES[d.decree].malus && d.target === smallID)) {
      return true;
    }
    return s.proposals.some(
      (p) => DECREES[p.decree].malus && p.target === smallID,
    );
  }

  /** The players a decree aimed at a player can be aimed at. */
  private targetChoices(s: PoliticsViewState, d: DecreeType): PlayerView[] {
    const me = this.game.myPlayer();
    const malus = DECREES[d].malus;
    return this.game
      .players()
      .filter(
        (p) =>
          p !== me &&
          p.isAlive() &&
          p.numTilesOwned() > 0 &&
          (p.type() === PlayerType.Human || p.type() === PlayerType.Nation) &&
          (!malus || !this.isProtected(s, p.smallID())),
      )
      .sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
  }

  // ── Actions ────────────────────────────────────────────────────────────

  private propose(d: DecreeType) {
    const target =
      DECREES[d].targeting === "player" ? (this.targets.get(d) ?? null) : null;
    if (DECREES[d].targeting === "player" && target === null) return;
    this.eventBus.emit(new ProposeDecreeIntentEvent(d, target));
  }

  private vote(p: ProposalView, choice: VoteChoice) {
    this.eventBus.emit(new CastVoteIntentEvent(p.id, choice));
  }

  // ── Render ─────────────────────────────────────────────────────────────

  render() {
    void this.renderTick;
    if (!this.game) return nothing;
    const s = this.game.politics();
    if (s === null) return nothing;
    const ticks = this.game.ticks();
    return html`
      ${this.renderBar(s, ticks)}
      ${s.phase === "proposing" ? this.renderProposing(s, ticks) : nothing}
      ${s.phase === "voting" ? this.renderVoting(s, ticks) : nothing}
      ${s.phase !== "voting" ? this.renderResults(s, ticks) : nothing}
    `;
  }

  /** The congress at a glance: countdown and decrees in force. */
  private renderBar(s: PoliticsViewState, ticks: number): TemplateResult {
    let status: string;
    if (s.phase === "proposing") {
      status = translateText("politics.status_proposing", {
        seconds: this.seconds(s.phaseEnd - ticks),
      });
    } else if (s.phase === "voting") {
      status = translateText("politics.status_voting");
    } else if (s.active.length >= 2 && ticks >= s.nextRoundTick) {
      status = translateText("politics.status_waiting");
    } else {
      status = translateText("politics.status_next", {
        time: this.clock(s.nextRoundTick - ticks),
      });
    }
    return html`
      <div
        class="fixed top-10 left-1/2 -translate-x-1/2 z-[1000] pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 max-w-[90vw] rounded-lg bg-gray-900/80 px-3 py-1 text-xs text-white shadow-lg backdrop-blur"
      >
        <span class="font-semibold">🏛 ${translateText("politics.title")}</span>
        <span class="text-gray-300">${status}</span>
        ${s.active.map((d) => {
          const hidden = d.secret && ticks < d.revealTick;
          const name = hidden
            ? translateText("politics.secret_hidden")
            : this.decreeTitle(d.decree);
          const target = d.target !== null ? ` → ${this.nameOf(d.target)}` : "";
          const prices =
            !hidden && d.prices.length > 0
              ? " · " +
                d.prices
                  .map(
                    ([type, f]) =>
                      `${translateText(`unit_type.${type.toLowerCase().replace(/ /g, "_")}`)} ${f < 1 ? "−" : "+"}${Math.round(Math.abs(f - 1) * 100)}%`,
                  )
                  .join(", ")
              : "";
          const open = this.hoveredDecree === d.id;
          return html`<span
            class="relative cursor-help rounded bg-indigo-700/80 px-2 py-0.5 hover:bg-indigo-600"
            @mouseenter=${() => (this.hoveredDecree = d.id)}
            @mouseleave=${() => (this.hoveredDecree = null)}
            @click=${() => (this.hoveredDecree = open ? null : d.id)}
            >${name}${target}
            <span class="text-indigo-200">${this.clock(d.endTick - ticks)}</span
            >${
              open
                ? html`<div
                    class="absolute left-1/2 top-full z-10 mt-2 w-72 -translate-x-1/2 rounded-lg border border-indigo-500/60 bg-gray-900/95 p-3 text-left text-xs text-white shadow-2xl"
                  >
                    <div class="mb-1 text-sm font-semibold">
                      ${name}${target}
                    </div>
                    ${
                      hidden
                        ? html`<div class="text-gray-300">
                            ${translateText("politics.secret_hint")}
                          </div>`
                        : html`<div class="text-gray-200">
                              ${this.decreeDesc(d.decree)}${prices}
                            </div>
                            <div class="mt-2">
                              ${this.renderAdvice(
                                adviceFor(this.game, s, d.decree, d.target),
                              )}
                            </div>`
                    }
                    <div class="mt-1 text-indigo-200">
                      ${translateText("politics.ends_in", {
                        time: this.clock(d.endTick - ticks),
                      })}
                    </div>
                  </div>`
                : nothing
            }</span
          >`;
        })}
      </div>
    `;
  }

  private renderProposing(
    s: PoliticsViewState,
    ticks: number,
  ): TemplateResult | typeof nothing {
    const me = this.game.myPlayer();
    if (me === null || this.skippedRound === s.phaseStart) return nothing;
    const offers = s.offers.find(([id]) => id === me.smallID())?.[1] ?? [];
    if (offers.length === 0) return nothing;
    const mine = s.proposals.find((p) => p.proposer === me.smallID());
    const percent = this.game.config().politicsProposalCostPercent();
    const full =
      s.proposals.length >= this.game.config().politicsMaxProposals();
    return html`
      <div
        class="fixed top-20 left-1/2 -translate-x-1/2 z-[1100] pointer-events-auto w-[min(56rem,94vw)] rounded-xl bg-gray-900/95 p-4 text-white shadow-2xl"
      >
        <div class="mb-2 flex items-center justify-between gap-2">
          <div class="text-lg font-bold">
            ${translateText("politics.proposing_title")}
            <span class="ml-2 text-sm font-normal text-gray-300"
              >${this.seconds(s.phaseEnd - ticks)}s</span
            >
          </div>
          <button
            class="rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
            @click=${() => (this.skippedRound = s.phaseStart)}
          >
            ${mine ? translateText("politics.close") : translateText("politics.skip")}
          </button>
        </div>
        ${
          mine
            ? html`<div class="text-green-300">
                ${translateText("politics.proposed", {
                  decree: this.decreeName(mine.decree),
                })}
              </div>`
            : html`
                <div class="mb-3 text-sm text-gray-300">
                  ${translateText("politics.proposing_hint", {
                    percent,
                    gold: renderNumber(this.costOf(percent)),
                  })}
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  ${offers.map((d) => this.renderOffer(s, d, full))}
                </div>
              `
        }
      </div>
    `;
  }

  private renderOffer(
    s: PoliticsViewState,
    d: DecreeType,
    full: boolean,
  ): TemplateResult {
    const info = DECREES[d];
    const choices = info.targeting === "player" ? this.targetChoices(s, d) : [];
    const chosen = this.targets.get(d) ?? null;
    const taken = s.proposals.some((p) => p.decree === d);
    const disabled =
      full || taken || (info.targeting === "player" && chosen === null);
    return html`
      <div class="flex flex-col rounded-lg bg-gray-800 p-3">
        <div class="text-xs uppercase tracking-wide text-indigo-300">
          ${translateText(`politics.category.${info.category}`)}
        </div>
        <div class="font-semibold">${this.decreeTitle(d)}</div>
        <div class="mb-2 flex-1 text-sm text-gray-300">
          ${this.decreeDesc(d)}
        </div>
        ${this.renderAdvice(
          adviceFor(
            this.game,
            s,
            d,
            chosen !== null && this.game.hasPlayer(chosen)
              ? this.game.player(chosen).smallID()
              : null,
          ),
        )}
        ${
          info.targeting === "leader"
            ? html`<div class="mb-2 text-sm text-orange-300">
                ${translateText("politics.against_leader")}
              </div>`
            : nothing
        }
        ${
          info.targeting === "player"
            ? html`<select
                class="mb-2 rounded bg-gray-700 p-1 text-sm"
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  const next = new Map(this.targets);
                  if (value === "") next.delete(d);
                  else next.set(d, value);
                  this.targets = next;
                }}
              >
                <option value="" ?selected=${chosen === null}>
                  ${translateText("politics.choose_target")}
                </option>
                ${choices.map(
                  (p) =>
                    html`<option value=${p.id()} ?selected=${chosen === p.id()}>
                      ${p.displayName()}
                    </option>`,
                )}
              </select>`
            : nothing
        }
        <button
          class="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          ?disabled=${disabled}
          @click=${() => this.propose(d)}
        >
          ${
            taken
              ? translateText("politics.already_proposed")
              : full
                ? translateText("politics.slots_full")
                : translateText("politics.propose")
          }
        </button>
      </div>
    `;
  }

  private renderVoting(s: PoliticsViewState, ticks: number): TemplateResult {
    const me = this.game.myPlayer();
    const myId = me?.smallID() ?? -1;
    const total = s.weights.reduce((sum, [, w]) => sum + w, 0);
    const myWeight = s.weights.find(([id]) => id === myId)?.[1] ?? 0;
    const end = s.freezeEnd ?? s.phaseEnd;
    const vetoPercent = this.game.config().politicsVetoCostPercent();
    return html`
      <div
        class="fixed inset-0 z-[1090] flex items-start justify-center bg-black/50 pt-24 pointer-events-auto"
      >
        <div
          class="max-h-[75vh] w-[min(48rem,94vw)] overflow-y-auto rounded-xl bg-gray-900/95 p-4 text-white shadow-2xl"
        >
          <div class="mb-1 flex items-center justify-between">
            <div class="text-lg font-bold">
              ❄ ${translateText("politics.voting_title")}
            </div>
            <div class="text-xl font-bold tabular-nums">
              ${this.seconds(end - ticks)}s
            </div>
          </div>
          <div class="mb-3 text-sm text-gray-300">
            ${
              myWeight > 0
                ? translateText("politics.voting_hint", {
                    weight: myWeight.toFixed(1),
                    share:
                      total > 0 ? ((myWeight / total) * 100).toFixed(1) : "0",
                  })
                : translateText("politics.spectating")
            }
          </div>
          ${s.proposals.map((p) =>
            this.renderBallot(s, p, myId, myWeight > 0, vetoPercent),
          )}
          <div class="mt-2 text-xs text-gray-400">
            ${translateText("politics.veto_hint", { percent: vetoPercent })}
          </div>
        </div>
      </div>
    `;
  }

  private renderBallot(
    s: PoliticsViewState,
    p: ProposalView,
    myId: number,
    canVote: boolean,
    vetoPercent: number,
  ): TemplateResult {
    const mine = p.votes.find(([id]) => id === myId)?.[1];
    const isTarget = p.target === myId;
    const voters = s.weights.filter(([id]) => id !== p.target).length;
    const button = (choice: VoteChoice, label: string, color: string) => html`
      <button
        class="rounded px-3 py-1.5 text-sm font-semibold ${color} ${
          mine === choice ? "ring-2 ring-white" : "opacity-80 hover:opacity-100"
        } disabled:cursor-not-allowed disabled:opacity-30"
        ?disabled=${!canVote || isTarget || mine === "veto"}
        @click=${() => this.vote(p, choice)}
      >
        ${label}
      </button>
    `;
    return html`
      <div class="mb-3 rounded-lg bg-gray-800 p-3">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <div class="font-semibold">${this.decreeTitle(p.decree)}</div>
          <div class="text-xs text-gray-400">
            ${translateText("politics.proposed_by", {
              name: this.nameOf(p.proposer),
            })}
          </div>
        </div>
        ${
          p.target !== null
            ? html`<div class="text-sm text-orange-300">
                ${translateText("politics.target", {
                  name: this.nameOf(p.target),
                })}
              </div>`
            : nothing
        }
        <div class="mb-2 text-sm text-gray-300">
          ${this.decreeDesc(p.decree)}
        </div>
        ${isTarget ? nothing : this.renderAdvice(adviceFor(this.game, s, p.decree, p.target))}
        ${
          isTarget
            ? html`<div class="text-sm text-orange-300">
                ${translateText("politics.you_are_target")}
              </div>`
            : html`<div class="flex flex-wrap gap-2">
                ${button("yes", translateText("politics.vote_yes"), "bg-green-700")}
                ${button("no", translateText("politics.vote_no"), "bg-red-700")}
                ${button(
                  "abstain",
                  translateText("politics.vote_abstain"),
                  "bg-gray-600",
                )}
                ${button(
                  "veto",
                  translateText("politics.vote_veto", {
                    gold: renderNumber(this.costOf(vetoPercent)),
                  }),
                  "bg-orange-700",
                )}
              </div>`
        }
        <div class="mt-1 text-xs text-gray-400">
          ${translateText("politics.votes_cast", {
            count: p.votes.length,
            total: voters,
          })}
          ${this.renderForecast(s, p)}
        </div>
      </div>
    `;
  }

  /** Likely outcome: votes cast plus how the nations will probably vote. */
  private renderForecast(
    s: PoliticsViewState,
    p: ProposalView,
  ): TemplateResult | typeof nothing {
    const f = forecast(this.game, s, p);
    if (f.total <= 0) return nothing;
    const pct = (w: number) => Math.round((w / f.total) * 100);
    const cls =
      f.verdict === "likely"
        ? "text-green-300"
        : f.verdict === "unlikely"
          ? "text-red-300"
          : "text-yellow-200";
    return html` ·
      <span
        class=${cls}
        title=${translateText("politics_advice.forecast_hint")}
      >
        ${translateText(`politics_advice.forecast_${f.verdict}`)}
        (${translateText("politics_advice.forecast_split", {
          yes: pct(f.yes),
          no: pct(f.no),
        })})
      </span>`;
  }

  private renderResults(
    s: PoliticsViewState,
    ticks: number,
  ): TemplateResult | typeof nothing {
    if (
      s.results.length === 0 ||
      ticks - s.resultsTick > RESULTS_TICKS ||
      this.closedResults === s.resultsTick
    ) {
      return nothing;
    }
    return html`
      <div
        class="fixed top-20 left-1/2 -translate-x-1/2 z-[1100] pointer-events-auto max-h-[60vh] w-[min(40rem,94vw)] overflow-y-auto rounded-xl bg-gray-900/95 p-4 text-white shadow-2xl"
      >
        <div class="mb-2 flex items-center justify-between">
          <div class="text-lg font-bold">
            ${translateText("politics.results_title")}
          </div>
          <button
            class="rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
            @click=${() => (this.closedResults = s.resultsTick)}
          >
            ${translateText("politics.close")}
          </button>
        </div>
        ${s.results.map((r) => {
          const secret =
            r.decree === DecreeType.SecretDecree && r.outcome === "passed";
          const byVote = (choice: VoteChoice) => {
            const names = r.votes
              .filter(([, v]) => v === choice)
              .map(([id]) => this.nameOf(id));
            if (names.length <= MAX_NAMES) return names.join(", ");
            return translateText("politics.and_more", {
              names: names.slice(0, MAX_NAMES).join(", "),
              count: names.length - MAX_NAMES,
            });
          };
          return html`
            <div class="mb-2 rounded bg-gray-800 p-2 text-sm">
              <div class="flex justify-between gap-2">
                <span class="font-semibold"
                  >${this.decreeTitle(r.decree)}${
                    r.target !== null ? ` → ${this.nameOf(r.target)}` : ""
                  }</span
                >
                <span class="${OUTCOME_COLORS[r.outcome]} font-semibold"
                  >${translateText(`politics.outcome.${r.outcome}`)}</span
                >
              </div>
              <div class="text-xs text-gray-400">
                ${translateText("politics.tally", {
                  yes: r.yes.toFixed(1),
                  no: r.no.toFixed(1),
                  total: r.total.toFixed(1),
                })}
                ${secret ? html` · ${translateText("politics.secret_passed")}` : nothing}
              </div>
              ${(["yes", "no", "veto"] as VoteChoice[]).map((c) => {
                const names = byVote(c);
                return names === ""
                  ? nothing
                  : html`<div class="text-xs text-gray-300">
                      ${translateText(`politics.vote_${c}_short`)}: ${names}
                    </div>`;
              })}
            </div>
          `;
        })}
      </div>
    `;
  }
}
