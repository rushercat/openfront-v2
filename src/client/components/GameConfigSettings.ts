import {
  Difficulty,
  Duos,
  GameFeature,
  GameMapType,
  GameMode,
  HistoricalScenarioId,
  HumansVsNations,
  maps,
  Quads,
  Trios,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { MAX_BOTS, TeamCountConfig } from "@openfront/engine-api/Schemas";
import {
  DOOMSDAY_CLOCK_SPEEDS,
  DoomsdayClockSpeed,
} from "@openfront/engine-lib/game/DoomsdayClock";
import {
  HISTORICAL_SCENARIOS,
  historicalScenario,
} from "@openfront/engine-lib/game/HistoricalScenarios";
import type { CustomMapInfo } from "@openfront/shared/CustomMaps";
import {
  LitElement,
  SVGTemplateResult,
  TemplateResult,
  html,
  nothing,
  svg,
} from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  COMPLEXITY_LEVELS,
  ComplexityLevel,
  detectComplexity,
} from "../utilities/ComplexityPresets";
import { translateText } from "../Utils";
import "./Difficulties";
import "./DifficultyInfo";
import "./FluentSlider";
import "./map/MapPicker";

const ACTIVE_CARD =
  "bg-malibu-blue/20 border-malibu-blue/50 shadow-[var(--shadow-malibu-blue)]";
const INACTIVE_CARD =
  "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20";

const DISABLED_CARD =
  "w-full rounded-xl border transition-all duration-200 opacity-30 grayscale cursor-not-allowed bg-white/5 border-white/5";

function cardClass(active: boolean, extra = ""): string {
  return `w-full rounded-xl border cursor-pointer transition-all duration-200 active:scale-95 ${extra} ${active ? ACTIVE_CARD : INACTIVE_CARD}`;
}

const CARD_LABEL_CLASS =
  "text-xs uppercase font-bold tracking-wider leading-tight break-words hyphens-auto";

const DIFFICULTY_OPTIONS = Object.entries(Difficulty).filter(([key]) =>
  isNaN(Number(key)),
) as Array<[string, Difficulty]>;
const TEAM_COUNT_OPTIONS: TeamCountConfig[] = [
  2,
  3,
  4,
  5,
  6,
  7,
  Quads,
  Trios,
  Duos,
  HumansVsNations,
];

function stateTextClass(active: boolean): string {
  return active ? "text-white" : "text-white/60";
}

function renderTextCardButton(
  label: string,
  active: boolean,
  onClick: () => void,
  cardExtraClass: string,
): TemplateResult {
  return html`
    <button
      class="${cardClass(
        active,
        cardExtraClass,
      )} flex items-center justify-center"
      @click=${onClick}
    >
      <span class="${CARD_LABEL_CLASS} ${stateTextClass(active)}">
        ${label}
      </span>
    </button>
  `;
}

function renderSection(
  iconSvg: SVGTemplateResult,
  colorClass: string,
  bgClass: string,
  titleKey: string,
  content: TemplateResult | TemplateResult[],
  sectionClass = "space-y-6",
  headerAction?: TemplateResult,
): TemplateResult {
  return html`
    <section class=${sectionClass}>
      ${renderSectionHeader(
        iconSvg,
        colorClass,
        bgClass,
        titleKey,
        headerAction,
      )}
      ${content}
    </section>
  `;
}

const unitOptions: { type: UnitType; translationKey: string }[] = [
  { type: UnitType.City, translationKey: "unit_type.city" },
  { type: UnitType.DefensePost, translationKey: "unit_type.defense_post" },
  { type: UnitType.Port, translationKey: "unit_type.port" },
  { type: UnitType.Warship, translationKey: "unit_type.warship" },
  { type: UnitType.TransportShip, translationKey: "unit_type.boat" },
  { type: UnitType.MissileSilo, translationKey: "unit_type.missile_silo" },
  { type: UnitType.SAMLauncher, translationKey: "unit_type.sam_launcher" },
  { type: UnitType.AtomBomb, translationKey: "unit_type.atom_bomb" },
  { type: UnitType.HydrogenBomb, translationKey: "unit_type.hydrogen_bomb" },
  { type: UnitType.MIRV, translationKey: "unit_type.mirv" },
  { type: UnitType.Factory, translationKey: "unit_type.factory" },
  { type: UnitType.AADefense, translationKey: "unit_type.aa_defense" },
  { type: UnitType.Airfield, translationKey: "unit_type.airfield" },
  { type: UnitType.FighterJet, translationKey: "unit_type.fighter_jet" },
  { type: UnitType.Bomber, translationKey: "unit_type.bomber" },
  {
    type: UnitType.NuclearSubmarine,
    translationKey: "unit_type.nuclear_submarine",
  },
  { type: UnitType.RailDepot, translationKey: "unit_type.rail_depot" },
  { type: UnitType.Tank, translationKey: "unit_type.tank" },
  { type: UnitType.LandMine, translationKey: "unit_type.land_mine" },
  { type: UnitType.SeaMine, translationKey: "unit_type.sea_mine" },
  {
    type: UnitType.RepairStation,
    translationKey: "unit_type.repair_station",
  },
  {
    type: UnitType.AircraftCarrier,
    translationKey: "unit_type.aircraft_carrier",
  },
  { type: UnitType.CruiseMissile, translationKey: "unit_type.cruise_missile" },
  {
    type: UnitType.TransportPlane,
    translationKey: "unit_type.transport_plane",
  },
];

/** The mechanics a lobby can switch off, next to the units. */
const featureOptions: { feature: GameFeature; translationKey: string }[] = [
  { feature: GameFeature.Capital, translationKey: "game_feature.capital" },
  { feature: GameFeature.Unrest, translationKey: "game_feature.unrest" },
  { feature: GameFeature.Secession, translationKey: "game_feature.secession" },
  { feature: GameFeature.Politics, translationKey: "game_feature.politics" },
];

const MAP_ICON = svg`<path
  d="M21.731 2.269a2.625 2.625 0 00-3.712 0l-1.157 1.157 3.712 3.712 1.157-1.157a2.625 2.625 0 000-3.712zM19.513 8.199l-3.712-3.712-12.15 12.15a5.25 5.25 0 00-1.32 2.214l-.8 2.685a.75.75 0 00.933.933l2.685-.8a5.25 5.25 0 002.214-1.32L19.513 8.2z"
/>`;

const DIFFICULTY_ICON = svg`<path
  fill-rule="evenodd"
  d="M12.97 3.97a.75.75 0 011.06 0l7.5 7.5a.75.75 0 010 1.06l-7.5 7.5a.75.75 0 11-1.06-1.06l6.22-6.22H3a.75.75 0 010-1.5h16.19l-6.22-6.22a.75.75 0 010-1.06z"
  clip-rule="evenodd"
/>`;

const MODE_ICON = svg`<path
  d="M11.25 4.533A9.707 9.707 0 006 3a9.735 9.735 0 00-3.25.555.75.75 0 00-.5.707v14.25a.75.75 0 001 .707A8.237 8.237 0 016 18.75c1.995 0 3.823.707 5.25 1.886V4.533zM12.75 20.636A8.214 8.214 0 0118 18.75c.966 0 1.89.166 2.75.47a.75.75 0 001-.708V4.262a.75.75 0 00-.5-.707A9.735 9.735 0 0018 3a9.707 9.707 0 00-5.25 1.533v16.103z"
/>`;

const OPTIONS_ICON = svg`<path
  fill-rule="evenodd"
  d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 00-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 00-2.282.819l-.922 1.597a1.875 1.875 0 00.432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 000 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 00-.432 2.385l.922 1.597a1.875 1.875 0 002.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 002.28-.819l.922-1.597a1.875 1.875 0 00-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 000-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 00-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 00-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 00-1.85-1.567h-1.843zM12 15.75a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5z"
  clip-rule="evenodd"
/>`;

const HOST_CHEATS_ICON = svg`<path
  fill-rule="evenodd"
  d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z"
  clip-rule="evenodd"
/>`;

const ENABLES_ICON = svg`<path
  fill-rule="evenodd"
  d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm0 8.625a1.125 1.125 0 100 2.25 1.125 1.125 0 000-2.25zM15.375 12a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0zM7.5 10.875a1.125 1.125 0 100 2.25 1.125 1.125 0 000-2.25z"
  clip-rule="evenodd"
/>`;

function renderSectionHeader(
  iconSvg: SVGTemplateResult,
  colorClass: string,
  bgClass: string,
  titleKey: string,
  headerAction?: TemplateResult,
): TemplateResult {
  return html`
    <div class="flex items-center gap-4 pb-2 border-b border-white/10">
      <div
        class="w-8 h-8 rounded-lg flex items-center justify-center ${bgClass} ${colorClass}"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="w-5 h-5"
        >
          ${iconSvg}
        </svg>
      </div>
      <h3 class="text-lg font-bold text-white uppercase tracking-wider">
        ${translateText(titleKey)}
      </h3>
      ${headerAction ? html`<div class="ml-auto">${headerAction}</div>` : null}
    </div>
  `;
}

export interface ToggleOptionConfig {
  labelKey: string;
  checked: boolean;
  hidden?: boolean;
  // When set, this toggle's card expands to a pace dropdown while it is checked.
  doomsdayClockSpeed?: DoomsdayClockSpeed;
}

export interface GameConfigSettingsData {
  map: {
    selected: GameMapType;
    useRandom: boolean;
    randomMapDivider?: boolean;
    showMedals?: boolean;
    mapWins?: Map<GameMapType, Set<Difficulty>>;
    /** openfront v2: uploaded custom maps (null: still loading or failed). */
    customMaps?: CustomMapInfo[] | null;
    customMapsError?: boolean;
    selectedCustomMapId?: string | null;
  };
  /**
   * openfront v2: the historical scenario mode. When one is selected it
   * fixes the map, and the mode section shows the scenario instead of
   * FFA/Teams.
   */
  scenario?: {
    selected: HistoricalScenarioId | null;
    /** Secret missions (GameConfig.scenarioMissions). */
    missions?: boolean;
  };
  difficulty: {
    selected: Difficulty;
    disabled: boolean;
  };
  gameMode: {
    selected: GameMode;
  };
  teamCount: {
    selected: TeamCountConfig;
  };
  options: {
    titleKey: string;
    bots: {
      value: number;
      labelKey: string;
      disabledKey: string;
    };
    nations?: {
      value: number;
      defaultValue?: number;
      labelKey: string;
      disabledKey: string;
      hidden?: boolean;
    };
    toggles: ToggleOptionConfig[];
    inputCards: TemplateResult[];
  };
  hostCheats?: {
    titleKey: string;
    visible: boolean;
    toggles: ToggleOptionConfig[];
    inputCards: TemplateResult[];
  };
  unitTypes: {
    titleKey: string;
    disabledUnits: UnitType[];
    /** Mechanics switched off; leave out where they can't be. */
    disabledFeatures?: GameFeature[];
  };
}

@customElement("game-config-settings")
export class GameConfigSettings extends LitElement {
  @property({ attribute: false }) settings?: GameConfigSettingsData;
  @property({ attribute: false }) sectionGapClass = "space-y-6";
  @state() private mapSearchQuery = "";
  @state() private advancedUnitsOpen = false;

  createRenderRoot() {
    return this;
  }

  private emit<T>(name: string, detail: T) {
    this.dispatchEvent(
      new CustomEvent(name, {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleMapSearchInput = (event: Event) => {
    const input = event.target as HTMLInputElement;
    this.mapSearchQuery = input.value;
  };

  private clearMapSearch = () => {
    this.mapSearchQuery = "";
  };

  private handleSelectMap = (map: GameMapType) => {
    this.emit("map-selected", { map });
  };

  private handleSelectRandom = () => {
    this.emit("random-map-selected", {});
  };

  private handleSelectCustomMap = (map: CustomMapInfo) => {
    this.emit("custom-map-selected", { id: map.id });
  };

  private handleRefreshCustomMaps = () => {
    this.emit("custom-maps-refresh", {});
  };

  private handleScenarioSelect = (id: HistoricalScenarioId | null) => {
    this.emit("scenario-selected", { id });
  };

  /** Secret Risk-style missions: on or off for the scenario. */
  private renderMissionsToggle(enabled: boolean) {
    return html`
      <button
        class="${cardClass(enabled, "p-4 text-left flex items-start gap-3")}"
        @click=${() =>
          this.emit("scenario-missions-changed", { enabled: !enabled })}
      >
        <span class="text-2xl leading-none">${enabled ? "🎯" : "🗺️"}</span>
        <span class="flex flex-col gap-1">
          <span class="text-sm font-bold text-white uppercase tracking-widest">
            ${translateText("historical_scenario.missions_toggle")}
            <span
              class="ml-2 text-xs ${enabled ? "text-green-400" : "text-white/40"}"
              >${translateText(
                enabled
                  ? "historical_scenario.missions_on"
                  : "historical_scenario.missions_off",
              )}</span
            >
          </span>
          <span class="text-xs text-white/60 normal-case">
            ${translateText("historical_scenario.missions_hint")}
          </span>
        </span>
      </button>
    `;
  }

  /** The scenario mode's picker: each scenario with its blocs. */
  private renderScenarios(selected: HistoricalScenarioId | null) {
    return html`
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        ${Object.values(HISTORICAL_SCENARIOS).map((scenario) => {
          const isSelected = selected === scenario.id;
          const bloc = (key: string | null) =>
            scenario.nations.filter((n) => n.bloc === key);
          return html`
            <button
              class="${cardClass(isSelected, "p-4 text-left flex flex-col gap-2")}"
              @click=${() => this.handleScenarioSelect(scenario.id)}
            >
              <span
                class="text-sm font-bold text-white uppercase tracking-widest"
              >
                ${translateText(scenario.nameKey)}
              </span>
              <span class="text-xs text-white/60 normal-case">
                ${translateText(scenario.descriptionKey)}
              </span>
              <span class="text-xs text-amber-300/90 normal-case">
                ${translateText("historical_scenario.counts", {
                  majors: scenario.nations.filter((n) => n.major).length,
                  nations: scenario.nations.length,
                })}
              </span>
              <div class="flex flex-col gap-1 text-xs normal-case">
                ${scenario.blocs.map(
                  (b) =>
                    html`<div>
                      <span class="font-bold text-white/80"
                        >${translateText(b.nameKey)}:</span
                      >
                      <span class="text-white/60"
                        >${bloc(b.key)
                          .map((n) => n.name)
                          .join(", ")}</span
                      >
                    </div>`,
                )}
                <div>
                  <span class="font-bold text-white/80"
                    >${translateText(
                      scenario.blocs.length > 0
                        ? "historical_scenario.bloc.neutral"
                        : "historical_scenario.great_powers",
                    )}:</span
                  >
                  <span class="text-white/60"
                    >${bloc(null)
                      .filter((n) => scenario.blocs.length > 0 || n.major)
                      .map((n) => n.name)
                      .join(", ")}</span
                  >
                </div>
              </div>
            </button>
          `;
        })}
      </div>
    `;
  }

  private handleDifficultySelect = (difficulty: Difficulty) => {
    this.emit("difficulty-selected", { difficulty });
  };

  private handleDoomsdayClockSpeedChange = (e: Event) => {
    const speed = (e.target as HTMLSelectElement).value as DoomsdayClockSpeed;
    this.emit("doomsday-clock-speed-selected", { speed });
  };

  private handleGameModeSelect = (mode: GameMode) => {
    this.emit("game-mode-selected", { mode });
  };

  private handleTeamCountSelect = (count: TeamCountConfig) => {
    this.emit("team-count-selected", { count });
  };

  private handleOptionToggle = (toggle: ToggleOptionConfig) => {
    this.emit("option-toggle-changed", {
      labelKey: toggle.labelKey,
      checked: !toggle.checked,
    });
  };

  private handleBotsChanged = (event: Event) => {
    const customEvent = event as CustomEvent<{ value: number }>;
    this.emit("bots-changed", customEvent.detail);
  };

  private handleNationsChanged = (event: Event) => {
    const customEvent = event as CustomEvent<{ value: number }>;
    this.emit("nations-changed", customEvent.detail);
  };

  private handleHostCheatToggle = (toggle: ToggleOptionConfig) => {
    this.emit("host-cheat-toggle-changed", {
      labelKey: toggle.labelKey,
      checked: !toggle.checked,
    });
  };

  private handleUnitToggle = (unit: UnitType, checked: boolean) => {
    this.emit("unit-toggle-changed", { unit, checked });
  };

  private handleFeatureToggle = (feature: GameFeature, checked: boolean) => {
    this.emit("feature-toggle-changed", { feature, checked });
  };

  private renderFeatureOptions(
    disabledFeatures: GameFeature[] | undefined,
  ): TemplateResult[] {
    if (disabledFeatures === undefined) return [];
    return featureOptions.map(({ feature, translationKey }) => {
      const isEnabled = !disabledFeatures.includes(feature);
      return html`
        <button
          class="${cardClass(isEnabled, "p-4 text-center")}"
          aria-pressed=${isEnabled}
          title=${translateText(`${translationKey}_desc`)}
          @click=${() => this.handleFeatureToggle(feature, isEnabled)}
        >
          <span class="${CARD_LABEL_CLASS} ${stateTextClass(isEnabled)}">
            ${translateText(translationKey)}
          </span>
        </button>
      `;
    });
  }

  private renderOptionToggle(toggle: ToggleOptionConfig): TemplateResult {
    if (toggle.hidden) return html``;

    if (toggle.doomsdayClockSpeed !== undefined) {
      return this.renderDoomsdayClockToggle(toggle);
    }

    return renderTextCardButton(
      translateText(toggle.labelKey),
      toggle.checked,
      () => this.handleOptionToggle(toggle),
      "p-4 text-center",
    );
  }

  // Same toggle card as the others, but when on it grows to hold the pace
  // dropdown. The card toggles on click; the dropdown stops propagation so
  // changing the pace doesn't flip the toggle.
  private renderDoomsdayClockToggle(
    toggle: ToggleOptionConfig,
  ): TemplateResult {
    const selected = toggle.doomsdayClockSpeed;
    return html`
      <div
        class="${cardClass(
          toggle.checked,
          // Centered label; when checked the dropdown is added below it so the
          // label shifts up and the dropdown is reachable.
          "p-4 flex flex-col items-center justify-center gap-2 text-center",
        )}"
        @click=${() => this.handleOptionToggle(toggle)}
      >
        <span class="${CARD_LABEL_CLASS} ${stateTextClass(toggle.checked)}">
          ${translateText(toggle.labelKey)}
        </span>
        ${
          toggle.checked
            ? html`
                <select
                  class="bg-white/10 border border-white/20 rounded-lg px-2 py-1 text-white text-xs"
                  @click=${(e: Event) => e.stopPropagation()}
                  @change=${this.handleDoomsdayClockSpeedChange}
                >
                  ${DOOMSDAY_CLOCK_SPEEDS.map(
                    (speed) => html`
                      <option value=${speed} ?selected=${selected === speed}>
                        ${translateText(`doomsday_clock_speed.${speed}`)}
                      </option>
                    `,
                  )}
                </select>
              `
            : nothing
        }
      </div>
    `;
  }

  private handleComplexitySelect = (level: ComplexityLevel) => {
    this.emit("complexity-selected", { level });
  };

  /** Klassik / Modern / Total: one click instead of 20 switches. */
  private renderComplexityPicker(
    disabledUnits: UnitType[],
    disabledFeatures: GameFeature[] | undefined,
  ): TemplateResult {
    const current = detectComplexity(disabledUnits, disabledFeatures);
    return html`
      <div class="space-y-2">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          ${COMPLEXITY_LEVELS.map(
            (level) => html`
              <button
                class="${cardClass(current === level, "p-4 text-left")}"
                aria-pressed=${current === level}
                @click=${() => this.handleComplexitySelect(level)}
              >
                <div
                  class="${CARD_LABEL_CLASS} ${stateTextClass(
                    current === level,
                  )}"
                >
                  ${translateText(`complexity.${level}`)}
                </div>
                <div class="text-xs text-white/50 mt-1 normal-case">
                  ${translateText(`complexity.${level}_desc`)}
                </div>
              </button>
            `,
          )}
        </div>
        ${
          current === null
            ? html`<div class="text-xs text-white/50">
                ${translateText("complexity.custom")}
              </div>`
            : nothing
        }
      </div>
    `;
  }

  private renderUnitTypeOptions(disabledUnits: UnitType[]): TemplateResult[] {
    return unitOptions.map(({ type, translationKey }) => {
      const isEnabled = !disabledUnits.includes(type);
      return html`
        <button
          class="${cardClass(isEnabled, "p-4 text-center")}"
          aria-pressed=${isEnabled}
          @click=${() => this.handleUnitToggle(type, isEnabled)}
        >
          <span class="${CARD_LABEL_CLASS} ${stateTextClass(isEnabled)}">
            ${translateText(translationKey)}
          </span>
        </button>
      `;
    });
  }

  private renderMapSearchInput(): TemplateResult {
    return html`<div class="relative">
      <input
        type="text"
        placeholder="${translateText("map_component.search_maps")}"
        .value=${this.mapSearchQuery}
        @input=${this.handleMapSearchInput}
        class="w-48 px-3 py-1.5 pl-8 pr-7 rounded-lg text-sm bg-transparent border border-white/10 text-white placeholder-white/40 focus:outline-none focus:border-malibu-blue/50 transition-all"
      />
      <svg
        class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40"
        viewBox="0 0 20 20"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
          clip-rule="evenodd"
        />
      </svg>
      ${
        this.mapSearchQuery
          ? html`<button
              type="button"
              @click=${this.clearMapSearch}
              class="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-white/10 transition-all"
            >
              <svg class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path
                  d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                />
              </svg>
            </button>`
          : null
      }
    </div>`;
  }

  render() {
    if (!this.settings) return nothing;
    const settings = this.settings;

    return html`
      <div class=${this.sectionGapClass}>
        ${
          (settings.scenario?.selected ?? null) !== null
            ? renderSection(
                MAP_ICON,
                "text-aquarius",
                "bg-malibu-blue/20",
                "map.map",
                html`<p class="text-sm text-white/60">
                  ${translateText("historical_scenario.map_locked", {
                    map: translateText(
                      maps.find(
                        (m) =>
                          m.type ===
                          historicalScenario(settings.scenario!.selected!).map,
                      )?.translationKey ?? "map.map",
                    ),
                  })}
                </p>`,
              )
            : renderSection(
                MAP_ICON,
                "text-aquarius",
                "bg-malibu-blue/20",
                "map.map",
                html`<map-picker
                  .selectedMap=${settings.map.selected}
                  .useRandomMap=${settings.map.useRandom}
                  .randomMapDivider=${settings.map.randomMapDivider ?? false}
                  .showMedals=${settings.map.showMedals ?? false}
                  .mapWins=${settings.map.mapWins ?? new Map()}
                  .onSelectMap=${this.handleSelectMap}
                  .onSelectRandom=${this.handleSelectRandom}
                  .searchQuery=${this.mapSearchQuery}
                  .customMaps=${settings.map.customMaps ?? null}
                  .customMapsError=${settings.map.customMapsError ?? false}
                  .selectedCustomMapId=${settings.map.selectedCustomMapId ?? null}
                  .onSelectCustomMap=${this.handleSelectCustomMap}
                  .onRefreshCustomMaps=${this.handleRefreshCustomMaps}
                ></map-picker>`,
                undefined,
                this.renderMapSearchInput(),
              )
        }
        ${renderSection(
          DIFFICULTY_ICON,
          "text-green-400",
          "bg-green-500/20",
          "difficulty.difficulty",
          html`
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
              ${DIFFICULTY_OPTIONS.map(([key, value]) => {
                const isSelected = settings.difficulty.selected === value;
                const isDisabled = settings.difficulty.disabled;
                return html`
                  <div class="group/difficulty-card relative">
                    <button
                      ?disabled=${isDisabled}
                      @click=${() =>
                        !isDisabled &&
                        this.handleDifficultySelect(value as Difficulty)}
                      class="${
                        isDisabled
                          ? `${DISABLED_CARD} flex flex-col items-center p-4 gap-3 h-full`
                          : cardClass(
                              isSelected,
                              "flex flex-col items-center p-4 gap-3 h-full",
                            )
                      }"
                    >
                      <difficulty-display
                        .difficultyKey=${key}
                        class="transform scale-125 origin-center ${
                          isDisabled ? "pointer-events-none" : ""
                        }"
                      ></difficulty-display>
                      <span
                        class="${CARD_LABEL_CLASS} text-center mt-1 text-white"
                      >
                        ${translateText(`difficulty.${key.toLowerCase()}`)}
                      </span>
                    </button>
                    <difficulty-info
                      .difficultyKey=${key}
                      .disabled=${isDisabled}
                    ></difficulty-info>
                  </div>
                `;
              })}
            </div>
          `,
        )}
        ${renderSection(
          MODE_ICON,
          "text-purple-400",
          "bg-purple-500/20",
          "host_modal.mode",
          html`
            <div
              class="grid ${settings.scenario ? "grid-cols-3" : "grid-cols-2"} gap-4"
            >
              ${[GameMode.FFA, GameMode.Team].map((mode) => {
                const isSelected =
                  settings.gameMode.selected === mode &&
                  (settings.scenario?.selected ?? null) === null;
                return html`
                  <button
                    class="${cardClass(isSelected, "py-6 text-center")}"
                    @click=${() => this.handleGameModeSelect(mode)}
                  >
                    <span
                      class="text-sm font-bold text-white uppercase tracking-widest"
                    >
                      ${
                        mode === GameMode.FFA
                          ? translateText("game_mode.ffa")
                          : translateText("game_mode.teams")
                      }
                    </span>
                  </button>
                `;
              })}
              ${
                settings.scenario
                  ? html`<button
                      class="${cardClass(
                        settings.scenario.selected !== null,
                        "py-6 text-center",
                      )}"
                      @click=${() =>
                        this.handleScenarioSelect(
                          settings.scenario!.selected ??
                            HistoricalScenarioId.Europe1939,
                        )}
                    >
                      <span
                        class="text-sm font-bold text-white uppercase tracking-widest"
                      >
                        ${translateText("game_mode.scenarios")}
                      </span>
                    </button>`
                  : nothing
              }
            </div>
            ${
              (settings.scenario?.selected ?? null) !== null
                ? html`<div class="mt-4 flex flex-col gap-4">
                    ${this.renderMissionsToggle(
                      settings.scenario!.missions ?? false,
                    )}
                    ${this.renderScenarios(settings.scenario!.selected)}
                  </div>`
                : nothing
            }
          `,
        )}
        ${
          settings.gameMode.selected === GameMode.FFA ||
          (settings.scenario?.selected ?? null) !== null
            ? nothing
            : html`
                <section class="space-y-6">
                  <div
                    class="text-xs font-bold text-white/40 uppercase tracking-widest mb-4 pl-2"
                  >
                    ${translateText("host_modal.team_count")}
                  </div>
                  <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                    ${TEAM_COUNT_OPTIONS.map((o) => {
                      const isSelected = settings.teamCount.selected === o;
                      return html`
                        <button
                          class="${cardClass(
                            isSelected,
                            "px-4 py-3 text-center",
                          )}"
                          @click=${() => this.handleTeamCountSelect(o)}
                        >
                          <span class="${CARD_LABEL_CLASS} text-white">
                            ${
                              typeof o === "string"
                                ? o === HumansVsNations
                                  ? translateText("public_lobby.teams_hvn")
                                  : translateText(`host_modal.teams_${o}`)
                                : translateText("public_lobby.teams", {
                                    num: o,
                                  })
                            }
                          </span>
                        </button>
                      `;
                    })}
                  </div>
                </section>
              `
        }
        ${renderSection(
          OPTIONS_ICON,
          "text-orange-400",
          "bg-orange-500/20",
          settings.options.titleKey,
          html`
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div
                class="col-span-2 rounded-xl p-4 flex flex-col justify-center border transition-all duration-200 ${
                  settings.options.bots.value > 0 ? ACTIVE_CARD : INACTIVE_CARD
                }"
              >
                <fluent-slider
                  min="0"
                  max=${MAX_BOTS}
                  step="1"
                  .value=${settings.options.bots.value}
                  labelKey=${settings.options.bots.labelKey}
                  disabledKey=${settings.options.bots.disabledKey}
                  @value-changed=${this.handleBotsChanged}
                ></fluent-slider>
                <div role="status" aria-live="polite">
                  ${
                    settings.options.bots.value > 400
                      ? html`<p class="mt-2 text-xs text-amber-300 text-center">
                          ${translateText("game_settings.bots_high_warning")}
                        </p>`
                      : nothing
                  }
                </div>
              </div>

              ${
                settings.options.nations && !settings.options.nations.hidden
                  ? html`<div
                      class="col-span-2 rounded-xl p-4 flex flex-col justify-center border transition-all duration-200 ${
                        settings.options.nations.value > 0
                          ? ACTIVE_CARD
                          : INACTIVE_CARD
                      }"
                    >
                      <fluent-slider
                        min="0"
                        max="400"
                        step="1"
                        .value=${settings.options.nations.value}
                        .defaultValue=${settings.options.nations.defaultValue}
                        defaultLabelKey="common.map_default"
                        labelKey=${settings.options.nations.labelKey}
                        disabledKey=${settings.options.nations.disabledKey}
                        @value-changed=${this.handleNationsChanged}
                      ></fluent-slider>
                    </div>`
                  : nothing
              }
              ${settings.options.toggles.map((toggle) =>
                this.renderOptionToggle(toggle),
              )}
              ${settings.options.inputCards}
            </div>
          `,
        )}
        ${
          settings.hostCheats?.visible
            ? renderSection(
                HOST_CHEATS_ICON,
                "text-yellow-400",
                "bg-yellow-500/20",
                settings.hostCheats.titleKey,
                html`
                  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    ${settings.hostCheats.toggles.map((toggle) =>
                      renderTextCardButton(
                        translateText(toggle.labelKey),
                        toggle.checked,
                        () => this.handleHostCheatToggle(toggle),
                        "p-4 text-center",
                      ),
                    )}
                    ${settings.hostCheats.inputCards}
                  </div>
                `,
              )
            : nothing
        }
        ${renderSection(
          ENABLES_ICON,
          "text-teal-400",
          "bg-teal-500/20",
          settings.unitTypes.titleKey,
          html`
            ${this.renderComplexityPicker(
              settings.unitTypes.disabledUnits,
              settings.unitTypes.disabledFeatures,
            )}
            <details
              class="group"
              ?open=${this.advancedUnitsOpen}
              @toggle=${(e: Event) =>
                (this.advancedUnitsOpen = (
                  e.target as HTMLDetailsElement
                ).open)}
            >
              <summary
                class="cursor-pointer select-none text-sm text-white/60 hover:text-white/90 mb-4"
              >
                ${translateText("complexity.advanced")}
              </summary>
              <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                ${this.renderUnitTypeOptions(settings.unitTypes.disabledUnits)}
                ${this.renderFeatureOptions(
                  settings.unitTypes.disabledFeatures,
                )}
              </div>
            </details>
          `,
          "space-y-6 pb-6",
        )}
      </div>
    `;
  }
}
