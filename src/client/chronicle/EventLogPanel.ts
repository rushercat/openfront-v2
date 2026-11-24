import { EventBus, GameEvent } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { GoToPlayerEvent } from "../TransformHandler";
import { translateText } from "../Utils";
import { GameView, PlayerView } from "../view";
import {
  describeEvent,
  EVENT_ICONS,
  formatMatchTime,
  involvesMe,
} from "./ChronicleText";
import type { ChronicleEvent, MatchChronicle } from "./MatchChronicle";

/** Opens or closes the event log (the button in the right sidebar). */
export class ToggleEventLogEvent implements GameEvent {}

type LogFilter = "all" | "mine" | "diplomacy" | "war";

const DIPLOMACY: ReadonlySet<string> = new Set([
  "alliance",
  "alliance_expired",
  "betrayal",
  "embargo",
  "embargo_end",
]);
const WAR: ReadonlySet<string> = new Set(["war", "nuke", "eliminated", "win"]);

/**
 * <event-log-panel>: every war declaration, alliance, betrayal, embargo,
 * elimination and nuke of the match in one scrollable list, newest first,
 * with the game time. Clicking an entry moves the camera to the other
 * player. It reads the match chronicle (MatchChronicle) and opens from the
 * right sidebar.
 */
@customElement("event-log-panel")
export class EventLogPanel extends LitElement {
  game: GameView | undefined;
  private chronicle: MatchChronicle | null = null;
  private eventBus: EventBus | null = null;
  private unsubscribe: (() => void) | null = null;
  private offToggle: (() => void) | null = null;

  @state() private open = false;
  @state() private filter: LogFilter = "all";
  @state() private version = 0;

  createRenderRoot() {
    return this;
  }

  setup(game: GameView, eventBus: EventBus, chronicle: MatchChronicle): void {
    this.game = game;
    this.chronicle = chronicle;
    this.unsubscribe?.();
    this.unsubscribe = chronicle.onEvent(() => {
      if (this.open) this.version++;
    });
    if (this.eventBus !== eventBus) {
      this.offToggle?.();
      this.eventBus = eventBus;
      const toggle = () => this.toggle();
      eventBus.on(ToggleEventLogEvent, toggle);
      this.offToggle = () => eventBus.off(ToggleEventLogEvent, toggle);
    }
    this.requestUpdate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.offToggle?.();
    this.unsubscribe = null;
    this.offToggle = null;
    this.eventBus = null;
  }

  toggle(): void {
    this.open = !this.open;
  }

  isOpen(): boolean {
    return this.open;
  }

  private visibleEvents(): ChronicleEvent[] {
    const chronicle = this.chronicle;
    if (chronicle === null) return [];
    const me = chronicle.me();
    return chronicle
      .events()
      .filter((e) => {
        switch (this.filter) {
          case "all":
            return true;
          case "mine":
            return involvesMe(e, me) || e.kind === "win";
          case "diplomacy":
            return DIPLOMACY.has(e.kind);
          case "war":
            return WAR.has(e.kind);
        }
      })
      .slice()
      .reverse();
  }

  private goTo(event: ChronicleEvent): void {
    const game = this.game;
    const chronicle = this.chronicle;
    if (game === undefined || chronicle === null || this.eventBus === null) {
      return;
    }
    const me = chronicle.me();
    const target = event.a === me && event.b !== undefined ? event.b : event.a;
    if (target < 0) return;
    const player = game.playerBySmallID(target);
    if (!player.isPlayer() || !player.isAlive()) return;
    this.eventBus.emit(new GoToPlayerEvent(player as PlayerView));
  }

  private filterButton(filter: LogFilter, label: string) {
    const active = this.filter === filter;
    return html`<button
      type="button"
      class="px-2 py-0.5 rounded text-xs ${
        active
          ? "bg-blue-600 text-white"
          : "bg-white/10 text-white/80 hover:bg-white/20"
      }"
      @click=${() => (this.filter = filter)}
    >
      ${label}
    </button>`;
  }

  render() {
    void this.version;
    if (!this.open || this.chronicle === null) return nothing;
    const chronicle = this.chronicle;
    const me = chronicle.me();
    const events = this.visibleEvents();
    return html`
      <div
        class="pointer-events-auto w-[min(92vw,340px)] max-h-[50vh] flex flex-col bg-gray-800/92 backdrop-blur-sm text-white rounded-bl-lg shadow-lg"
        data-event-log
        @contextmenu=${(e: Event) => e.preventDefault()}
      >
        <div class="flex items-center justify-between px-3 pt-2 pb-1">
          <span class="font-semibold text-sm"
            >${translateText("match_log.title")}</span
          >
          <button
            type="button"
            class="text-white/70 hover:text-white text-lg leading-none"
            aria-label=${translateText("match_log.close")}
            @click=${() => (this.open = false)}
          >
            ×
          </button>
        </div>
        <div class="flex flex-wrap gap-1 px-3 pb-2">
          ${this.filterButton("all", translateText("match_log.filter_all"))}
          ${
            me === null
              ? nothing
              : this.filterButton(
                  "mine",
                  translateText("match_log.filter_mine"),
                )
          }
          ${this.filterButton(
            "diplomacy",
            translateText("match_log.filter_diplomacy"),
          )}
          ${this.filterButton("war", translateText("match_log.filter_war"))}
        </div>
        <ul class="overflow-y-auto px-2 pb-2 text-xs flex flex-col gap-0.5">
          ${
            events.length === 0
              ? html`<li class="px-1 py-2 text-white/60">
                  ${translateText("match_log.empty")}
                </li>`
              : events.map(
                  (e) =>
                    html`<li
                      class="flex gap-2 items-start px-1 py-1 rounded cursor-pointer hover:bg-white/10 ${
                        involvesMe(e, me) ? "bg-white/5" : ""
                      } ${e.kind === "betrayal" ? "text-red-300" : ""}"
                      @click=${() => this.goTo(e)}
                    >
                      <span class="tabular-nums text-white/50 shrink-0 w-11"
                        >${formatMatchTime(e.tick, chronicle.startTick())}</span
                      >
                      <span class="shrink-0">${EVENT_ICONS[e.kind]}</span>
                      <span class="min-w-0 break-words"
                        >${describeEvent(e, chronicle)}</span
                      >
                    </li>`,
                )
          }
        </ul>
      </div>
    `;
  }
}
