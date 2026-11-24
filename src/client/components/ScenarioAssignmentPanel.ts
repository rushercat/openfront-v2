import { HistoricalScenarioId } from "@openfront/engine-api/game/GameTypes";
import {
  assignScenarioNations,
  historicalScenario,
} from "@openfront/engine-lib/game/HistoricalScenarios";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";

export interface ScenarioPlayer {
  clientID: string;
  username: string;
}

/**
 * Which nation every player of a historical scenario lobby plays (openfront
 * v2). The host picks one per player; anyone left gets the next free great
 * power, which the panel shows as it will be (assignScenarioNations).
 * Emits `scenario-assignment` ({clientID, nation | null}) when the host
 * changes one.
 */
@customElement("scenario-assignment-panel")
export class ScenarioAssignmentPanel extends LitElement {
  @property({ type: String }) scenarioId: HistoricalScenarioId =
    HistoricalScenarioId.Europe1939;
  @property({ attribute: false }) players: ScenarioPlayer[] = [];
  @property({ attribute: false }) assignments: Record<string, string> = {};
  @property({ type: Boolean }) editable = false;
  /** The viewing player, highlighted. */
  @property({ type: String }) myClientID: string | null = null;

  createRenderRoot() {
    return this;
  }

  private choose(clientID: string, nation: string | null) {
    this.dispatchEvent(
      new CustomEvent("scenario-assignment", {
        detail: { clientID, nation },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const scenario = historicalScenario(this.scenarioId);
    const resolved = assignScenarioNations(
      scenario,
      this.players.map((p) => p.clientID),
      Object.entries(this.assignments).map(([clientID, nation]) => ({
        clientID,
        nation,
      })),
    );
    const blocName = (bloc: string | null) =>
      translateText(
        scenario.blocs.find((b) => b.key === bloc)?.nameKey ??
          "historical_scenario.bloc.neutral",
      );
    const takenBy = new Map<string, string>();
    for (const [clientID, nation] of resolved) {
      takenBy.set(nation.key, clientID);
    }
    return html`
      <section
        class="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3"
      >
        <h3 class="text-xs font-bold text-white/60 uppercase tracking-widest">
          ${translateText("historical_scenario.assignments_title")}
        </h3>
        <p class="text-xs text-white/50">
          ${translateText("historical_scenario.assignments_hint")}
        </p>
        ${
          this.players.length === 0
            ? html`<p class="text-sm text-white/50">
                ${translateText("historical_scenario.no_players")}
              </p>`
            : nothing
        }
        <ul class="space-y-2">
          ${this.players.map((p) => {
            const nation = resolved.get(p.clientID) ?? null;
            const chosen = this.assignments[p.clientID] ?? null;
            const mine = p.clientID === this.myClientID;
            return html`<li
              class="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 ${
                mine ? "bg-malibu-blue/20" : "bg-black/20"
              }"
            >
              ${
                nation
                  ? html`<img
                      class="w-6 h-4 object-cover rounded-sm"
                      src=${assetUrl(`flags/${nation.flag}.svg`)}
                      alt=""
                    />`
                  : nothing
              }
              <span class="font-bold text-white text-sm min-w-0 truncate"
                >${p.username}</span
              >
              ${
                this.editable
                  ? html`<select
                      class="ml-auto rounded bg-zinc-800 px-2 py-1 text-sm text-white"
                      @change=${(e: Event) => {
                        const value = (e.target as HTMLSelectElement).value;
                        this.choose(p.clientID, value === "" ? null : value);
                      }}
                    >
                      <option value="" .selected=${chosen === null}>
                        ${translateText("historical_scenario.automatic", {
                          nation: chosen === null && nation ? nation.name : "-",
                        })}
                      </option>
                      ${scenario.nations.map((n) => {
                        const other = takenBy.get(n.key);
                        const taken =
                          other !== undefined && other !== p.clientID;
                        return html`<option
                          value=${n.key}
                          .selected=${chosen === n.key}
                          ?disabled=${taken}
                        >
                          ${n.name}
                          (${blocName(n.bloc)})${
                            taken
                              ? ` – ${translateText("historical_scenario.taken")}`
                              : ""
                          }
                        </option>`;
                      })}
                    </select>`
                  : html`<span class="ml-auto text-sm text-white/80">
                      ${
                        nation
                          ? `${nation.name} (${blocName(nation.bloc)})`
                          : translateText("historical_scenario.no_nation")
                      }
                    </span>`
              }
            </li>`;
          })}
        </ul>
      </section>
    `;
  }
}
