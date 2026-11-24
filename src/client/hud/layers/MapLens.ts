import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { MapRenderer } from "../../render/gl";
import { translateText } from "../../Utils";
import { GameView, PlayerView, UnitView } from "../../view";

/**
 * openfront v2: map lenses. One key (L) or the eye button cycles through
 * views that show what normally only appears while building:
 * - air defense: SAM and flak coverage, own/allied vs enemy,
 * - air force: where airfields and carriers can send planes,
 * - defense: defense posts, the capital, repair stations and rail depots,
 * - unrest: rings around restless empires, redder the more unrest.
 */

export type LensMode =
  | "off"
  | "air_defense"
  | "air_force"
  | "defense"
  | "unrest";

const MODES: LensMode[] = [
  "off",
  "air_defense",
  "air_force",
  "defense",
  "unrest",
];

const ICONS: Record<LensMode, string> = {
  off: "👁",
  air_defense: "🛡️",
  air_force: "✈️",
  defense: "🏰",
  unrest: "🔥",
};

type RGB = readonly [number, number, number];
const SELF_A: RGB = [0.2, 1, 0.35];
const SELF_B: RGB = [0.2, 0.85, 1];
const ENEMY_A: RGB = [1, 0.25, 0.2];
const ENEMY_B: RGB = [1, 0.6, 0.1];

interface LensCircle {
  x: number;
  y: number;
  radius: number;
  color: RGB;
  group: number;
  alpha?: number;
}

interface LegendItem {
  color: RGB;
  key: string;
}

@customElement("map-lens")
export class MapLens extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;
  public view: MapRenderer;

  @state() private mode: LensMode = "off";
  /** In a running game with a living player (the button shows). */
  @state() private ready = false;
  private counter = 0;

  createRenderRoot() {
    return this;
  }

  init() {
    window.addEventListener("keydown", this.onKey);
    return () => window.removeEventListener("keydown", this.onKey);
  }

  dispose() {
    window.removeEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== "KeyL" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (
      t !== null &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    ) {
      return;
    }
    this.cycle(e.shiftKey ? -1 : 1);
  };

  private cycle(step: number) {
    const i = MODES.indexOf(this.mode);
    this.setMode(MODES[(i + step + MODES.length) % MODES.length]);
  }

  private setMode(mode: LensMode) {
    this.mode = mode;
    this.counter = 0;
    this.refresh();
  }

  tick() {
    const me = this.game?.myPlayer();
    const ready =
      me !== null &&
      me !== undefined &&
      me.isAlive() &&
      !this.game.inSpawnPhase();
    if (ready !== this.ready) this.ready = ready;
    if (this.mode === "off") return;
    // Ranges change slowly: once a second is enough.
    if (this.counter++ % 10 === 0) this.refresh();
  }

  private refresh() {
    if (!this.view) return;
    const me = this.game?.myPlayer() ?? null;
    if (this.mode === "off" || me === null) {
      this.view.setLensCircles(null);
      return;
    }
    this.view.setLensCircles(this.circles(me));
  }

  private friendly(me: PlayerView, owner: PlayerView): boolean {
    return owner === me || me.isFriendly(owner);
  }

  private at(u: UnitView): { x: number; y: number } {
    return { x: this.game.x(u.tile()), y: this.game.y(u.tile()) };
  }

  /**
   * Circles of one unit type, friendly in group `group`, enemy in
   * `group + 1`, so each side merges into one outline.
   */
  private ranges(
    me: PlayerView,
    types: UnitType[],
    radius: (u: UnitView) => number,
    group: number,
    friendColor: RGB,
    enemyColor: RGB,
  ): LensCircle[] {
    const out: LensCircle[] = [];
    for (const u of this.game.units(...types)) {
      if (!u.isActive() || this.game.isHiddenFromMe(u)) continue;
      if (u.isUnderConstruction()) continue;
      const friend = this.friendly(me, u.owner());
      out.push({
        ...this.at(u),
        radius: radius(u),
        color: friend ? friendColor : enemyColor,
        group: friend ? group : group + 1,
      });
    }
    return out;
  }

  private circles(me: PlayerView): LensCircle[] {
    const config = this.game.config();
    switch (this.mode) {
      case "air_defense":
        return [
          ...this.ranges(
            me,
            [UnitType.SAMLauncher],
            (u) => config.samRange(u.level()),
            0,
            SELF_A,
            ENEMY_A,
          ),
          ...this.ranges(
            me,
            [UnitType.AircraftCarrier],
            () => config.carrierSamRange(),
            0,
            SELF_A,
            ENEMY_A,
          ),
          ...this.ranges(
            me,
            [UnitType.AADefense, UnitType.AircraftCarrier],
            () => config.aaDefenseRange(),
            2,
            SELF_B,
            ENEMY_B,
          ),
        ];
      case "air_force":
        return [
          ...this.ranges(
            me,
            [UnitType.Airfield],
            (u) => config.airfieldRange(u.level()),
            0,
            SELF_A,
            ENEMY_A,
          ),
          ...this.ranges(
            me,
            [UnitType.AircraftCarrier],
            () => config.carrierAirRange(),
            0,
            SELF_A,
            ENEMY_A,
          ),
        ];
      case "defense":
        return [
          ...this.ranges(
            me,
            [UnitType.DefensePost],
            () => config.defensePostRange(),
            0,
            SELF_A,
            ENEMY_A,
          ),
          ...this.ranges(
            me,
            [UnitType.Capital],
            () => config.capitalDefenseRange(),
            0,
            SELF_A,
            ENEMY_A,
          ),
          ...this.ranges(
            me,
            [UnitType.RepairStation],
            (u) => config.repairStationRange(u.level()),
            2,
            SELF_B,
            ENEMY_B,
          ),
          ...this.ranges(
            me,
            [UnitType.RailDepot],
            () => config.railDepotRepairRange(),
            2,
            SELF_B,
            ENEMY_B,
          ),
        ];
      case "unrest":
        return this.unrestRings();
      default:
        return [];
    }
  }

  /** A ring around every restless empire, yellow (10 %) to red (60 %+). */
  private unrestRings(): LensCircle[] {
    const out: LensCircle[] = [];
    let group = 0;
    for (const p of this.game.playerViews()) {
      if (!p.isAlive()) continue;
      const share = p.unrestShare();
      if (share < 0.1) continue;
      const loc = p.nameLocation();
      if (loc === undefined) continue;
      const t = Math.min(1, (share - 0.1) / 0.5);
      const radius = Math.max(12, Math.sqrt(p.numTilesOwned()) * 0.6);
      // Three nested rings: the more unrest, the thicker it looks.
      const rings = share >= 0.5 ? 3 : share >= 0.3 ? 2 : 1;
      for (let i = 0; i < rings; i++) {
        out.push({
          x: loc.x,
          y: loc.y,
          radius: radius + i * 4,
          color: [1, 0.85 - 0.7 * t, 0.15],
          // Own group per ring: rings of one empire must not merge.
          group: group++,
        });
      }
    }
    return out;
  }

  private legend(): LegendItem[] {
    switch (this.mode) {
      case "air_defense":
        return [
          { color: SELF_A, key: "lens.legend.own_sam" },
          { color: SELF_B, key: "lens.legend.own_aa" },
          { color: ENEMY_A, key: "lens.legend.enemy_sam" },
          { color: ENEMY_B, key: "lens.legend.enemy_aa" },
        ];
      case "air_force":
        return [
          { color: SELF_A, key: "lens.legend.own_air" },
          { color: ENEMY_A, key: "lens.legend.enemy_air" },
        ];
      case "defense":
        return [
          { color: SELF_A, key: "lens.legend.own_defense" },
          { color: SELF_B, key: "lens.legend.own_repair" },
          { color: ENEMY_A, key: "lens.legend.enemy_defense" },
          { color: ENEMY_B, key: "lens.legend.enemy_repair" },
        ];
      case "unrest":
        return [
          { color: [1, 0.85, 0.15], key: "lens.legend.unrest_low" },
          { color: [1, 0.15, 0.15], key: "lens.legend.unrest_high" },
        ];
      default:
        return [];
    }
  }

  private rgb(c: RGB): string {
    return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
  }

  render() {
    if (!this.ready) return nothing;
    const active = this.mode !== "off";
    return html`
      <div
        class="fixed right-2 side-bar:right-16 top-[35%] z-[250] flex flex-row-reverse items-start gap-1 text-xs text-white pointer-events-none max-w-[min(32rem,70vw)]"
      >
        <button
          class="pointer-events-auto rounded-md border px-2 py-1 shadow ${
            active
              ? "bg-sky-700/80 border-sky-300"
              : "bg-gray-900/80 border-white/15 hover:bg-gray-700"
          }"
          title=${translateText("lens.button_hint")}
          @click=${() => this.cycle(1)}
          @contextmenu=${(e: Event) => {
            e.preventDefault();
            this.setMode("off");
          }}
        >
          ${ICONS[this.mode]}
          ${active ? html`<b>${translateText(`lens.${this.mode}`)}</b>` : nothing}
        </button>
        ${
          active
            ? html`<div
                class="pointer-events-auto rounded-md bg-gray-900/85 border border-white/15 px-2 py-1 shadow flex flex-col gap-0.5"
              >
                ${this.legend().map(
                  (l) =>
                    html`<div class="flex items-center gap-1.5">
                      <span
                        class="inline-block w-3 h-0.5 rounded"
                        style="background: ${this.rgb(l.color)}"
                      ></span>
                      ${translateText(l.key)}
                    </div>`,
                )}
                <div class="text-white/50">
                  ${translateText("lens.cycle_hint")}
                </div>
              </div>`
            : nothing
        }
      </div>
    `;
  }
}
