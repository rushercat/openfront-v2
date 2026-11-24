import type {
  MissionGoal,
  PlayerMissionView,
} from "@openfront/engine-api/game/Missions";
import {
  type HistoricalScenario,
  scenarioForConfig,
} from "@openfront/engine-lib/game/HistoricalScenarios";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { translateText } from "../../Utils";
import { GameView } from "../../view";

/** How long the mission card stays open after it is dealt, in ticks. */
const INTRO_TICKS = 200;

const GOAL_ICONS: Record<MissionGoal["kind"], string> = {
  conquer: "⚔️",
  eliminate: "💀",
  land: "🗺️",
  cities: "🏙️",
};

/**
 * openfront v2: your secret scenario mission (GameConfig.scenarioMissions).
 * Only ever shows your own; a pill with the overall progress that opens
 * into the goals. When someone wins by mission, everyone sees which.
 */
@customElement("mission-panel")
export class MissionPanel extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private mine: PlayerMissionView | null = null;
  @state() private open = true;
  @state() private blurred = false;
  @state() private winnerText: string | null = null;
  @state() private now = 0;
  private scenario: HistoricalScenario | null = null;
  private dealtAt: number | null = null;
  private counter = 0;

  createRenderRoot() {
    return this;
  }

  init() {}

  tick() {
    if (this.game === undefined) return;
    if (this.counter++ % 5 !== 0) return;
    const missions = this.game.missions();
    if (missions === null) return;
    this.scenario ??= scenarioForConfig(this.game.config().gameConfig());
    this.now = this.game.ticks();
    const mine = this.game.myMission();
    if (mine !== null && this.mine === null) {
      this.dealtAt = this.now;
      this.open = true;
    }
    if (
      this.dealtAt !== null &&
      this.open &&
      this.now - this.dealtAt > INTRO_TICKS &&
      !this.game.inSpawnPhase() &&
      this.mine !== null &&
      this.mine.heldSince === null
    ) {
      // The intro is over: fold to the pill (the player can reopen it).
      this.dealtAt = null;
      this.open = false;
    }
    this.mine = mine;
    if (missions.winner !== null && this.winnerText === null) {
      const won = missions.missions.find((m) => m.player === missions.winner);
      const p = this.game.playerBySmallID(missions.winner);
      if (won !== undefined && p.isPlayer()) {
        this.winnerText = translateText("missions.won_by", {
          name: p.displayName(),
          mission: won.goals.map((g) => this.goalText(g.goal)).join(" + "),
        });
      }
    }
  }

  private nationName(key: string): string {
    return this.scenario?.nations.find((n) => n.key === key)?.name ?? key;
  }

  private goalText(goal: MissionGoal): string {
    switch (goal.kind) {
      case "conquer":
        return translateText("missions.goal.conquer", {
          nations: goal.nations.map((n) => this.nationName(n)).join(", "),
        });
      case "eliminate":
        return translateText("missions.goal.eliminate", {
          nation: this.nationName(goal.nation),
        });
      case "land":
        return translateText("missions.goal.land", {
          percent: Math.round(goal.share * 100),
        });
      case "cities":
        return translateText("missions.goal.cities", { levels: goal.levels });
    }
  }

  private overall(m: PlayerMissionView): number {
    if (m.goals.length === 0) return 0;
    return m.goals.reduce((s, g) => s + g.progress, 0) / m.goals.length;
  }

  private renderWinner() {
    return html`<div
      class="pointer-events-auto max-w-80 rounded-lg border border-amber-400/60 bg-black/80 px-3 py-2 text-sm text-amber-200 shadow-lg backdrop-blur-sm"
    >
      🏆 ${this.winnerText}
    </div>`;
  }

  render() {
    if (this.winnerText !== null) {
      return html`<div
        class="fixed left-2 bottom-[calc(30%+0.5rem)] z-[1000] flex flex-col items-start gap-2 pointer-events-none"
      >
        ${this.renderWinner()}
      </div>`;
    }
    const m = this.mine;
    if (m === null) return nothing;
    const pct = Math.round(this.overall(m) * 100);
    const holdLeft =
      m.heldSince === null
        ? null
        : Math.max(
            0,
            Math.ceil(
              ((this.game.missions()?.holdTicks ?? 0) -
                (this.now - m.heldSince)) /
                10,
            ),
          );
    return html`
      <div
        class="fixed left-2 bottom-[calc(30%+0.5rem)] z-[1000] flex flex-col items-start gap-2 pointer-events-none"
      >
        ${this.open ? this.renderCard(m, holdLeft) : nothing}
        <button
          class="pointer-events-auto flex items-center gap-2 rounded-full border ${
            holdLeft !== null
              ? "border-green-400 animate-pulse"
              : "border-amber-400/50"
          } bg-black/75 px-3 py-1 text-xs font-bold text-amber-200 shadow-lg backdrop-blur-sm hover:bg-black/90"
          title=${translateText("missions.toggle_hint")}
          @click=${() => (this.open = !this.open)}
        >
          <span>🎯</span>
          <span>${translateText("missions.pill")}</span>
          <span class="tabular-nums text-white"
            >${this.blurred ? "··" : `${pct}%`}</span
          >
          ${
            holdLeft !== null
              ? html`<span class="text-green-300"
                  >⏳
                  ${translateText("missions.hold_short", {
                    seconds: holdLeft,
                  })}</span
                >`
              : nothing
          }
        </button>
      </div>
    `;
  }

  private renderCard(m: PlayerMissionView, holdLeft: number | null) {
    return html`<div
      class="pointer-events-auto w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-amber-400/50 bg-black/85 p-3 text-white shadow-xl backdrop-blur-sm"
    >
      <div class="mb-1 flex items-center justify-between gap-2">
        <div class="text-sm font-bold uppercase tracking-wider text-amber-300">
          🎯 ${translateText("missions.title")}
        </div>
        <button
          class="rounded px-1.5 text-xs text-white/60 hover:bg-white/10 hover:text-white"
          title=${translateText("missions.hide_hint")}
          @click=${() => (this.blurred = !this.blurred)}
        >
          ${this.blurred ? "👁" : "🙈"}
        </button>
      </div>
      <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-white/60">
        <span
          class="rounded-full px-2 py-0.5 text-[11px] font-bold ${
            m.historical
              ? "bg-amber-500/20 text-amber-200"
              : "bg-sky-500/20 text-sky-200"
          }"
          >${translateText(
            m.historical ? "missions.historical" : "missions.whatif",
          )}</span
        >
        <span
          >${translateText("missions.subtitle", {
            nation: this.nationName(m.nation),
          })}</span
        >
      </div>
      <div
        class="flex flex-col gap-2 transition ${
          this.blurred ? "blur-sm hover:blur-none" : ""
        }"
      >
        ${m.goals.map(
          (g) =>
            html`<div class="flex flex-col gap-1">
              <div class="flex items-start gap-2 text-sm">
                <span>${g.done ? "✅" : GOAL_ICONS[g.goal.kind]}</span>
                <span class="${g.done ? "text-green-300" : ""}"
                  >${this.goalText(g.goal)}</span
                >
              </div>
              <div class="h-1.5 w-full overflow-hidden rounded bg-white/10">
                <div
                  class="h-full ${g.done ? "bg-green-400" : "bg-amber-400"}"
                  style="width:${Math.round(g.progress * 100)}%"
                ></div>
              </div>
            </div>`,
        )}
        ${
          m.noteKey !== null
            ? html`<div
                class="rounded border-l-2 border-amber-400/60 bg-white/5 px-2 py-1 text-xs italic text-white/70"
              >
                <span class="not-italic font-bold text-amber-300/90"
                  >${translateText("missions.history_label")}:</span
                >
                ${translateText(m.noteKey)}
              </div>`
            : nothing
        }
      </div>
      <div class="mt-2 text-xs text-white/50">
        ${
          holdLeft !== null
            ? html`<span class="text-green-300"
                >${translateText("missions.holding", {
                  seconds: holdLeft,
                })}</span
              >`
            : translateText("missions.rule")
        }
      </div>
    </div>`;
  }
}
