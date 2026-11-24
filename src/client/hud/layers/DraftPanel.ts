import {
  DRAFT_CARDS,
  DRAFT_MAX_LEVEL,
  DRAFT_WAR_CHEST_GOLD,
  DraftCardId,
  DraftCategory,
  draftDeckOf,
  DraftPerk,
  draftPool,
  DraftRarity,
  draftResearchCost,
  DraftSettings,
  DraftViewState,
} from "@openfront/engine-api/game/Draft";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { renderNumber } from "@openfront/engine-lib/Format";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import {
  DraftPickIntentEvent,
  DraftResearchIntentEvent,
} from "../../Transport";
import { translateText } from "../../Utils";
import { GameView, PlayerView } from "../../view";

const CATEGORY_STYLE: Record<DraftCategory, { icon: string; color: string }> = {
  [DraftCategory.Base]: { icon: "🏙", color: "from-slate-600 to-slate-800" },
  [DraftCategory.Economy]: {
    icon: "💰",
    color: "from-amber-600 to-amber-900",
  },
  [DraftCategory.Defense]: { icon: "🛡", color: "from-sky-600 to-sky-900" },
  [DraftCategory.Air]: { icon: "✈", color: "from-indigo-600 to-indigo-900" },
  [DraftCategory.Navy]: { icon: "⚓", color: "from-cyan-600 to-cyan-900" },
  [DraftCategory.Army]: { icon: "🪖", color: "from-lime-700 to-lime-950" },
  [DraftCategory.Nuclear]: { icon: "☢", color: "from-red-600 to-red-900" },
};

const RARITY_STYLE: Record<DraftRarity, string> = {
  [DraftRarity.Common]: "border-gray-300 text-gray-200",
  [DraftRarity.Rare]: "border-blue-400 text-blue-300",
  [DraftRarity.Epic]: "border-purple-400 text-purple-300",
  [DraftRarity.Legendary]: "border-amber-400 text-amber-300",
};

/** What a perk does per level, for the card text. */
const PERK_PER_LEVEL: Record<DraftPerk, number> = {
  [DraftPerk.Gold]: 10,
  [DraftPerk.Trade]: 25,
  [DraftPerk.Troops]: 10,
  [DraftPerk.WarChest]: DRAFT_WAR_CHEST_GOLD,
  [DraftPerk.Builders]: 10,
  [DraftPerk.Fortress]: 10,
  [DraftPerk.Elite]: 8,
};

/**
 * The draft on screen (GameConfig.draft): the two cards on offer while a
 * round runs (full screen while the game is frozen, a small box during the
 * game), a deck button, and the deck / tech tree with research and the
 * other players' decks.
 */
@customElement("draft-panel")
export class DraftPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private renderTick = 0;
  @state() private open = false;
  @state() private tab: "mine" | "others" = "mine";
  /** Round (roundStart) the player minimized during the game. */
  @state() private minimizedRound = -1;

  createRenderRoot() {
    return this;
  }

  init() {
    this.open = false;
    this.minimizedRound = -1;
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

  private nameOf(smallID: number): string {
    const p = this.game.playerBySmallID(smallID);
    return p.isPlayer() ? (p as PlayerView).displayName() : "?";
  }

  private cardName(c: DraftCardId): string {
    return translateText(`draft.card.${c}`);
  }

  private unitName(type: UnitType): string {
    if (type === UnitType.TransportShip) return translateText("unit_type.boat");
    return translateText(`unit_type.${type.toLowerCase().replace(/ /g, "_")}`);
  }

  private perkText(perk: DraftPerk, level: number): string {
    // The war chest pays a fixed sum per level gained; the rest add up.
    const value =
      perk === DraftPerk.WarChest
        ? PERK_PER_LEVEL[perk]
        : PERK_PER_LEVEL[perk] * Math.max(1, level);
    return translateText(`draft.perk.${perk}`, {
      value: perk === DraftPerk.WarChest ? renderNumber(value) : value,
    });
  }

  private myDeck(s: DraftViewState): Map<DraftCardId, number> {
    const me = this.game.myPlayer();
    if (me === null) return new Map();
    return draftDeckOf(s, me.smallID()) ?? new Map();
  }

  // ── Actions ────────────────────────────────────────────────────────────

  private pick(c: DraftCardId) {
    this.eventBus.emit(new DraftPickIntentEvent(c));
  }

  private research(c: DraftCardId) {
    this.eventBus.emit(new DraftResearchIntentEvent(c));
  }

  // ── Render ─────────────────────────────────────────────────────────────

  render() {
    void this.renderTick;
    if (!this.game) return nothing;
    const settings = this.game.draftSettings();
    const s = this.game.draft();
    if (settings === null || s === null) return nothing;
    const ticks = this.game.ticks();
    return html`
      ${this.renderButton(settings, s, ticks)}
      ${s.phase === "picking" ? this.renderPicking(settings, s, ticks) : nothing}
      ${this.open ? this.renderDeckPanel(settings, s, ticks) : nothing}
    `;
  }

  /** Epochs mode: "Epoch II · World Wars". */
  private epochTitle(epoch: number): string {
    return translateText("draft.epoch_title", {
      number: ["I", "II", "III"][epoch] ?? String(epoch + 1),
      name: translateText(`draft.epoch_name.${Math.min(epoch, 2)}`),
    });
  }

  /** Always there: opens the deck / tech tree, shows the next round. */
  private renderButton(
    settings: DraftSettings,
    s: DraftViewState,
    ticks: number,
  ): TemplateResult {
    let status = "";
    const epochs = settings.tech === "epochs";
    if (s.phase === "picking") {
      status = epochs
        ? this.epochTitle(s.round)
        : translateText("draft.status_picking", {
            round: s.round + 1,
            rounds: s.rounds,
          });
    } else if (s.phase === "waiting" && s.round < s.rounds) {
      status = epochs
        ? translateText("draft.epoch_next", {
            epoch: this.epochTitle(s.round),
            time: this.clock(s.nextRoundTick - ticks),
          })
        : translateText("draft.status_next", {
            time: this.clock(s.nextRoundTick - ticks),
          });
    } else if (epochs && s.phase === "done") {
      status = this.epochTitle(s.rounds - 1);
    }
    const me = this.game.myPlayer();
    const research =
      me === null
        ? undefined
        : s.research.find((r) => r.player === me.smallID());
    const top = this.game.politics() !== null ? "top-[4.5rem]" : "top-10";
    return html`
      <div
        class="fixed ${top} left-1/2 -translate-x-1/2 z-[1000] pointer-events-auto flex items-center gap-2 rounded-lg bg-gray-900/80 px-3 py-1 text-xs text-white shadow-lg backdrop-blur"
      >
        <button
          class="rounded bg-indigo-700 px-2 py-0.5 font-semibold hover:bg-indigo-600"
          @click=${() => (this.open = !this.open)}
        >
          🃏 ${translateText("draft.deck_button")} (${this.myDeck(s).size})
        </button>
        ${status !== "" ? html`<span class="text-gray-300">${status}</span>` : nothing}
        ${
          research !== undefined
            ? html`<span class="text-emerald-300"
                >🔬 ${this.cardName(research.card)}
                ${this.clock(research.endTick - ticks)}</span
              >`
            : nothing
        }
        ${
          settings.tech !== "none"
            ? html`<span class="text-gray-400"
                >${translateText(`draft.tech_${settings.tech}`)}</span
              >`
            : nothing
        }
      </div>
    `;
  }

  private renderPicking(
    settings: DraftSettings,
    s: DraftViewState,
    ticks: number,
  ): TemplateResult | typeof nothing {
    const me = this.game.myPlayer();
    if (me === null) return nothing;
    const offer = s.offers.find(([id]) => id === me.smallID())?.[1];
    if (offer === undefined || offer.length === 0) return nothing;
    const picked = s.picked.find(([id]) => id === me.smallID())?.[1];
    const epochs = settings.tech === "epochs";
    const frozen = settings.timing === "before" || epochs;
    if (!frozen && this.minimizedRound === s.roundStart) return nothing;
    const deck = this.myDeck(s);
    const received = s.received.filter(([to]) => to === me.smallID());

    const body = html`
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="text-lg font-bold">
          ${
            epochs
              ? html`⏳ ${this.epochTitle(s.round)}`
              : html`🃏
                ${translateText("draft.title", {
                  round: s.round + 1,
                  rounds: s.rounds,
                })}`
          }
          <span class="ml-2 text-sm font-normal text-gray-300"
            >${this.seconds(s.roundEnd - ticks)}s</span
          >
        </div>
        ${
          frozen
            ? nothing
            : html`<button
                class="rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
                @click=${() => (this.minimizedRound = s.roundStart)}
              >
                ${translateText("draft.later")}
              </button>`
        }
      </div>
      <div class="mb-3 text-sm text-gray-300">
        ${
          picked !== undefined
            ? translateText("draft.waiting", { card: this.cardName(picked) })
            : epochs
              ? translateText(`draft.epoch_hint.${Math.min(s.round, 2)}`)
              : settings.declinedToOpponent
                ? translateText("draft.hint_gift")
                : translateText("draft.hint")
        }
      </div>
      ${
        received.length > 0
          ? html`<div class="mb-3 text-sm text-amber-300">
              ${received.map(
                ([, card, from]) =>
                  html`<div>
                    🎁
                    ${translateText("draft.received", {
                      card: this.cardName(card),
                      name: this.nameOf(from),
                    })}
                  </div>`,
              )}
            </div>`
          : nothing
      }
      <div
        class="grid grid-cols-1 gap-4 ${
          offer.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"
        }"
      >
        ${offer.map((c) =>
          this.renderCard(settings, c, deck, {
            picked: picked === c,
            dimmed: picked !== undefined && picked !== c,
            onClick: picked === undefined ? () => this.pick(c) : undefined,
          }),
        )}
      </div>
      ${this.renderDeckStrip(deck)}
    `;

    if (frozen) {
      return html`
        <div
          class="fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 pointer-events-auto"
        >
          <div
            class="w-[min(46rem,94vw)] max-h-[90vh] overflow-y-auto rounded-xl bg-gray-900/95 p-5 text-white shadow-2xl"
          >
            ${body}
          </div>
        </div>
      `;
    }
    return html`
      <div
        class="fixed top-28 left-1/2 -translate-x-1/2 z-[1100] pointer-events-auto w-[min(40rem,94vw)] rounded-xl bg-gray-900/95 p-4 text-white shadow-2xl"
      >
        ${body}
      </div>
    `;
  }

  private renderCard(
    settings: DraftSettings,
    c: DraftCardId,
    deck: ReadonlyMap<DraftCardId, number>,
    opts: { picked?: boolean; dimmed?: boolean; onClick?: () => void },
  ): TemplateResult {
    const info = DRAFT_CARDS[c];
    const style = CATEGORY_STYLE[info.category];
    const owned = deck.get(c);
    const level =
      owned === undefined ? 1 : Math.min(DRAFT_MAX_LEVEL, owned + 1);
    const pool = draftPool(settings);
    const missing = info.requires.filter(
      (r) => pool.includes(r) && !deck.has(r),
    );
    const tiers = info.units.filter((t) => t.length > 0);
    return html`
      <button
        class="relative flex flex-col gap-2 rounded-xl border-2 ${RARITY_STYLE[info.rarity]} bg-gradient-to-b ${style.color} p-4 text-left shadow-lg transition ${
          opts.onClick
            ? "hover:scale-[1.03] hover:brightness-110 cursor-pointer"
            : "cursor-default"
        } ${opts.picked ? "ring-4 ring-green-400" : ""} ${opts.dimmed ? "opacity-40" : ""}"
        ?disabled=${opts.onClick === undefined}
        @click=${opts.onClick ?? (() => {})}
      >
        <div class="flex items-center justify-between">
          <span class="text-3xl">${style.icon}</span>
          <span
            class="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${RARITY_STYLE[info.rarity]}"
            >${translateText(`draft.rarity.${info.rarity}`)}</span
          >
        </div>
        <div class="text-xl font-bold text-white">${this.cardName(c)}</div>
        <div class="text-xs text-gray-200">
          ${translateText(`draft.category.${info.category}`)}
          ${
            owned !== undefined
              ? html` ·
                  <span class="text-emerald-300"
                    >${translateText("draft.level_up", { level })}</span
                  >`
              : nothing
          }
        </div>
        <div class="text-sm text-white/90">
          ${translateText(`draft.card_desc.${c}`)}
        </div>
        ${
          tiers.length > 0
            ? html`<div class="flex flex-col gap-0.5 text-xs text-gray-100">
                ${info.units.map((tier, i) =>
                  tier.length === 0
                    ? nothing
                    : html`<div>
                        ${info.doctrine ? html`<b>T${i + 1}:</b> ` : nothing}
                        ${tier.map((u) => this.unitName(u)).join(", ")}
                      </div>`,
                )}
              </div>`
            : nothing
        }
        ${
          info.perk !== null
            ? html`<div class="text-xs text-amber-200">
                ★ ${this.perkText(info.perk, owned === undefined ? 1 : level)}
              </div>`
            : nothing
        }
        ${
          missing.length > 0
            ? html`<div class="text-xs text-yellow-200">
                ${translateText("draft.comes_with", {
                  cards: missing.map((m) => this.cardName(m)).join(", "),
                })}
              </div>`
            : nothing
        }
      </button>
    `;
  }

  private renderDeckStrip(
    deck: ReadonlyMap<DraftCardId, number>,
  ): TemplateResult | typeof nothing {
    if (deck.size === 0) return nothing;
    return html`
      <div class="mt-4 text-xs text-gray-300">
        ${translateText("draft.your_deck")}
        <div class="mt-1 flex flex-wrap gap-1">
          ${[...deck].map(([c, level]) => this.renderChip(c, level))}
        </div>
      </div>
    `;
  }

  private renderChip(c: DraftCardId, level: number): TemplateResult {
    const info = DRAFT_CARDS[c];
    return html`<span
      class="rounded border ${RARITY_STYLE[info.rarity]} bg-gray-800 px-2 py-0.5"
      title=${translateText(`draft.card_desc.${c}`)}
      >${CATEGORY_STYLE[info.category].icon}
      ${this.cardName(c)}${
        level > 1
          ? html` <b class="text-emerald-300">${"★".repeat(level)}</b>`
          : nothing
      }</span
    >`;
  }

  // ── Deck & tech tree ───────────────────────────────────────────────────

  private renderDeckPanel(
    settings: DraftSettings,
    s: DraftViewState,
    ticks: number,
  ): TemplateResult {
    return html`
      <div
        class="fixed top-28 left-1/2 -translate-x-1/2 z-[1150] pointer-events-auto w-[min(52rem,96vw)] max-h-[75vh] overflow-y-auto rounded-xl bg-gray-900/95 p-4 text-white shadow-2xl"
      >
        <div class="mb-3 flex items-center justify-between gap-2">
          <div class="flex gap-2">
            <button
              class="rounded px-3 py-1 text-sm ${this.tab === "mine" ? "bg-indigo-700" : "bg-gray-700 hover:bg-gray-600"}"
              @click=${() => (this.tab = "mine")}
            >
              ${
                settings.tech === "none"
                  ? translateText("draft.your_deck")
                  : translateText("draft.tech_tree")
              }
            </button>
            <button
              class="rounded px-3 py-1 text-sm ${this.tab === "others" ? "bg-indigo-700" : "bg-gray-700 hover:bg-gray-600"}"
              @click=${() => (this.tab = "others")}
            >
              ${translateText("draft.others")}
            </button>
          </div>
          <button
            class="rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
            @click=${() => (this.open = false)}
          >
            ✕
          </button>
        </div>
        ${
          this.tab === "mine"
            ? this.renderMine(settings, s, ticks)
            : this.renderOthers(settings, s)
        }
      </div>
    `;
  }

  private renderMine(
    settings: DraftSettings,
    s: DraftViewState,
    ticks: number,
  ): TemplateResult {
    const me = this.game.myPlayer();
    const deck = this.myDeck(s);
    if (me === null || deck.size === 0) {
      return html`<div class="text-sm text-gray-300">
        ${translateText("draft.empty_deck")}
      </div>`;
    }
    const research = s.research.find((r) => r.player === me.smallID());
    const gold = me.gold();
    return html`
      ${
        settings.baseSet
          ? html`<div class="mb-3 text-xs text-gray-400">
              ${translateText("draft.base_set_hint")}
            </div>`
          : nothing
      }
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        ${[...deck].map(([c, level]) => {
          const info = DRAFT_CARDS[c];
          const style = CATEGORY_STYLE[info.category];
          // Epochs: levels come from the next epochs, not from research.
          const canLevel =
            settings.tech !== "none" &&
            settings.tech !== "epochs" &&
            level < DRAFT_MAX_LEVEL;
          const cost = canLevel ? draftResearchCost(settings, level + 1) : null;
          const running = research?.card === c;
          const busy = research !== undefined;
          const affordable = cost !== null && gold >= BigInt(cost.gold);
          return html`
            <div
              class="flex flex-col gap-1 rounded-lg border ${RARITY_STYLE[info.rarity]} bg-gradient-to-b ${style.color} p-3"
            >
              <div class="flex items-center justify-between">
                <span class="font-bold">${style.icon} ${this.cardName(c)}</span>
                ${
                  settings.tech !== "none"
                    ? html`<span class="text-xs text-emerald-300"
                        >${translateText("draft.level", { level })}</span
                      >`
                    : nothing
                }
              </div>
              ${
                info.units.some((t) => t.length > 0)
                  ? html`<div class="flex flex-col gap-0.5 text-xs">
                      ${info.units.map((tier, i) =>
                        tier.length === 0
                          ? nothing
                          : html`<div
                              class=${i < level ? "text-white" : "text-gray-400 line-through decoration-gray-500"}
                            >
                              ${info.doctrine ? html`<b>T${i + 1}:</b> ` : nothing}
                              ${tier.map((u) => this.unitName(u)).join(", ")}
                              ${i >= level ? "🔒" : ""}
                            </div>`,
                      )}
                    </div>`
                  : nothing
              }
              ${
                info.perk !== null
                  ? html`<div class="text-xs text-amber-200">
                      ★ ${this.perkText(info.perk, level)}
                    </div>`
                  : nothing
              }
              ${
                settings.tech === "levels" &&
                !info.doctrine &&
                info.units.length > 0 &&
                level > 1
                  ? html`<div class="text-xs text-emerald-200">
                      ${translateText("draft.discount", {
                        value: 15 * (level - 1),
                      })}
                    </div>`
                  : nothing
              }
              ${
                running
                  ? html`<div class="mt-1">
                      <div class="h-1.5 w-full rounded bg-gray-700">
                        <div
                          class="h-1.5 rounded bg-emerald-400"
                          style="width:${Math.min(
                            100,
                            ((ticks - research!.startTick) /
                              Math.max(
                                1,
                                research!.endTick - research!.startTick,
                              )) *
                              100,
                          )}%"
                        ></div>
                      </div>
                      <div class="text-[11px] text-emerald-300">
                        🔬 ${this.clock(research!.endTick - ticks)}
                      </div>
                    </div>`
                  : cost !== null
                    ? html`<button
                        class="mt-1 rounded px-2 py-1 text-xs ${
                          !busy && affordable
                            ? "bg-emerald-700 hover:bg-emerald-600"
                            : "bg-gray-700 text-gray-400 cursor-not-allowed"
                        }"
                        ?disabled=${busy || !affordable}
                        @click=${() => this.research(c)}
                      >
                        🔬
                        ${translateText("draft.research", {
                          level: level + 1,
                          gold: renderNumber(cost.gold),
                          seconds: cost.ticks / 10,
                        })}
                      </button>`
                    : nothing
              }
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderOthers(
    settings: DraftSettings,
    s: DraftViewState,
  ): TemplateResult {
    if (!settings.visibleDecks) {
      return html`<div class="text-sm text-gray-300">
        ${translateText("draft.hidden_decks")}
      </div>`;
    }
    const me = this.game.myPlayer();
    const rows = s.decks
      .filter(([id]) => id !== me?.smallID())
      .map(([id, deck]) => {
        const p = this.game.playerBySmallID(id);
        return {
          id,
          deck,
          player: p.isPlayer() ? (p as PlayerView) : null,
        };
      })
      .filter((r) => r.player !== null && r.player.isAlive())
      .sort(
        (a, b) =>
          Number(b.player!.type() === PlayerType.Human) -
            Number(a.player!.type() === PlayerType.Human) ||
          b.player!.numTilesOwned() - a.player!.numTilesOwned(),
      );
    return html`
      <div class="flex flex-col gap-2">
        ${rows.map(
          (r) =>
            html`<div class="rounded bg-gray-800/80 p-2">
              <div class="mb-1 text-sm font-semibold">
                ${r.player!.displayName()}
              </div>
              <div class="flex flex-wrap gap-1 text-xs">
                ${r.deck.map(([c, level]) => this.renderChip(c, level))}
              </div>
            </div>`,
        )}
      </div>
    `;
  }
}
