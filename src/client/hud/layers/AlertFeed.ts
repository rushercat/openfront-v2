import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  DisplayMessageUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { renderTroops } from "@openfront/engine-lib/Format";
import { structureHealthFraction } from "@openfront/engine-lib/game/UnitHealth";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Controller } from "../../Controller";
import { GoToPlayerEvent, GoToPositionEvent } from "../../TransformHandler";
import { translateText } from "../../Utils";
import { GameView, PlayerView, UnitView } from "../../view";

/**
 * openfront v2: one place for everything that needs the player's attention
 * right now: nukes, cruise missiles, paratroopers, bombers and boats on
 * their way, a surfaced enemy submarine, big land attacks, a secession
 * warning, a fallen capital, the world congress, damaged buildings and high
 * unrest. Sorted by urgency, colour-coded; a click jumps to the spot.
 * Categories can be muted (right-click), and "only urgent" hides the rest.
 */

type Severity = "critical" | "high" | "medium" | "info";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  info: 3,
};

/** Alert kinds; each can be muted on its own. */
type AlertKind =
  | "nuke"
  | "cruise"
  | "paratroopers"
  | "bombers"
  | "boats"
  | "submarine"
  | "attack"
  | "secession"
  | "capital"
  | "congress"
  | "decree"
  | "damage"
  | "unrest";

interface Alert {
  key: string;
  kind: AlertKind;
  severity: Severity;
  icon: string;
  text: string;
  /** Where a click jumps to. */
  tile?: TileRef;
  player?: PlayerView;
  /** Event alerts vanish at this tick; state alerts while their cause lasts. */
  expiresAt?: number;
}

const STORAGE_KEY = "openfront.alertFeed.v1";
/** Event alerts (congress, decrees, secession warning …) stay this long. */
const EVENT_TICKS = 150;
/** How many alerts show at once (the rest are counted). */
const MAX_SHOWN = 5;

interface Prefs {
  muted: AlertKind[];
  urgentOnly: boolean;
  collapsed: boolean;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      return {
        muted: Array.isArray(p.muted) ? p.muted : [],
        urgentOnly: p.urgentOnly === true,
        collapsed: p.collapsed === true,
      };
    }
  } catch {
    // Storage can be unavailable; defaults then.
  }
  return { muted: [], urgentOnly: false, collapsed: false };
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Not fatal: the settings just don't stick.
  }
}

@customElement("alert-feed")
export class AlertFeed extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  @state() private alerts: Alert[] = [];
  @state() private prefs: Prefs = loadPrefs();

  /** Event alerts collected from updates, merged into `alerts` each scan. */
  private eventAlerts = new Map<string, Alert>();
  /** Dismissed state alerts: key → tick, they come back after a while. */
  private dismissed = new Map<string, number>();
  private lastPoliticsPhase = "idle";
  private lastResultsTick = -1;
  private counter = 0;

  createRenderRoot() {
    return this;
  }

  init() {
    this.alerts = [];
    this.eventAlerts.clear();
    this.dismissed.clear();
    this.lastPoliticsPhase = "idle";
    this.lastResultsTick = -1;
  }

  tick() {
    const me = this.game?.myPlayer();
    if (!me || !me.isAlive() || this.game.inSpawnPhase()) {
      if (this.alerts.length > 0) this.alerts = [];
      return;
    }
    this.collectEvents(me);
    this.collectPolitics(me);
    // The unit scan is the expensive part: twice a second is plenty.
    if (this.counter++ % 5 !== 0) return;
    this.rebuild(me);
  }

  // ── Sources ────────────────────────────────────────────────────────────

  private pushEvent(a: Omit<Alert, "expiresAt">): void {
    this.eventAlerts.set(a.key, {
      ...a,
      expiresAt: this.game.ticks() + EVENT_TICKS,
    });
  }

  private collectEvents(me: PlayerView): void {
    const updates = this.game.updatesSinceLastTick();
    const events = (updates?.[GameUpdateType.DisplayEvent] ??
      []) as DisplayMessageUpdate[];
    for (const e of events) {
      if (e.playerID !== me.smallID()) continue;
      if (e.message === "events_display.secession_warning") {
        this.pushEvent({
          key: "secession",
          kind: "secession",
          severity: "critical",
          icon: "💥",
          text: translateText("alerts.secession_warning"),
          player: me,
        });
      } else if (e.message === "events_display.capital_lost") {
        this.pushEvent({
          key: "capital",
          kind: "capital",
          severity: "high",
          icon: "👑",
          text: translateText("alerts.capital_lost"),
          player: me,
        });
      }
    }
  }

  private collectPolitics(me: PlayerView): void {
    const p = this.game.politics();
    if (p === null) return;
    if (p.phase !== this.lastPoliticsPhase) {
      this.lastPoliticsPhase = p.phase;
      if (p.phase === "proposing") {
        this.pushEvent({
          key: "congress",
          kind: "congress",
          severity: "info",
          icon: "🏛️",
          text: translateText("alerts.congress_proposing"),
        });
      } else if (p.phase === "voting") {
        this.pushEvent({
          key: "congress",
          kind: "congress",
          severity: "info",
          icon: "🗳️",
          text: translateText("alerts.congress_voting"),
        });
      }
    }
    if (p.resultsTick !== this.lastResultsTick) {
      this.lastResultsTick = p.resultsTick;
      for (const r of p.results) {
        if (r.outcome !== "passed") continue;
        const name = translateText(`politics.decree.${r.decree}`);
        const againstMe = r.target === me.smallID();
        this.pushEvent({
          key: `decree:${r.proposalId}`,
          kind: "decree",
          severity: againstMe ? "high" : "info",
          icon: "📜",
          text: translateText(
            againstMe ? "alerts.decree_against_you" : "alerts.decree_passed",
            { decree: name },
          ),
        });
      }
    }
  }

  /** Enemy units whose target lies on my land, grouped by kind. */
  private threatsAgainst(
    me: PlayerView,
    types: UnitType[],
  ): { count: number; first: UnitView | null } {
    let count = 0;
    let first: UnitView | null = null;
    for (const u of this.game.units(...types)) {
      if (!u.isActive()) continue;
      const owner = u.owner();
      if (owner === me || me.isFriendly(owner)) continue;
      if (this.game.isHiddenFromMe(u)) continue;
      const target = u.targetTile();
      if (target === undefined || this.game.owner(target) !== me) continue;
      count++;
      first ??= u;
    }
    return { count, first };
  }

  private rebuild(me: PlayerView): void {
    const out: Alert[] = [];
    const add = (a: Alert) => out.push(a);

    const nukes = this.threatsAgainst(me, [
      UnitType.AtomBomb,
      UnitType.HydrogenBomb,
      UnitType.MIRV,
      UnitType.MIRVWarhead,
    ]);
    if (nukes.count > 0) {
      add({
        key: "nuke",
        kind: "nuke",
        severity: "critical",
        icon: "☢️",
        text: translateText("alerts.nukes", { count: nukes.count }),
        tile: nukes.first?.targetTile(),
      });
    }
    const cruise = this.threatsAgainst(me, [UnitType.CruiseMissile]);
    if (cruise.count > 0) {
      add({
        key: "cruise",
        kind: "cruise",
        severity: "high",
        icon: "🚀",
        text: translateText("alerts.cruise", { count: cruise.count }),
        tile: cruise.first?.targetTile(),
      });
    }
    const para = this.threatsAgainst(me, [UnitType.TransportPlane]);
    if (para.count > 0) {
      add({
        key: "paratroopers",
        kind: "paratroopers",
        severity: "high",
        icon: "🪂",
        text: translateText("alerts.paratroopers", { count: para.count }),
        tile: para.first?.targetTile(),
      });
    }
    const bombers = this.threatsAgainst(me, [UnitType.Bomber]);
    if (bombers.count > 0) {
      add({
        key: "bombers",
        kind: "bombers",
        severity: "high",
        icon: "✈️",
        text: translateText("alerts.bombers", { count: bombers.count }),
        tile: bombers.first?.tile(),
      });
    }
    const boats = this.threatsAgainst(me, [UnitType.TransportShip]);
    if (boats.count > 0) {
      add({
        key: "boats",
        kind: "boats",
        severity: "medium",
        icon: "⛵",
        text: translateText("alerts.boats", { count: boats.count }),
        tile: boats.first?.targetTile(),
      });
    }
    // A surfaced (so visible) enemy submarine is about to fire nukes.
    for (const sub of this.game.units(UnitType.NuclearSubmarine)) {
      const owner = sub.owner();
      if (!sub.isActive() || owner === me || me.isFriendly(owner)) continue;
      if (this.game.isHiddenFromMe(sub)) continue;
      add({
        key: "submarine",
        kind: "submarine",
        severity: "high",
        icon: "🛳️",
        text: translateText("alerts.submarine", { name: owner.displayName() }),
        tile: sub.tile(),
      });
      break;
    }
    // Big land attacks: a third of my troops or more.
    const myTroops = Math.max(1, me.troops());
    for (const a of me.incomingAttacks()) {
      if (a.retreating || a.troops < myTroops / 3) continue;
      const attacker = this.game.playerBySmallID(a.attackerID);
      if (!attacker.isPlayer()) continue;
      add({
        key: `attack:${a.attackerID}`,
        kind: "attack",
        severity: a.troops >= myTroops ? "critical" : "high",
        icon: "⚔️",
        text: translateText("alerts.attack", {
          name: (attacker as PlayerView).displayName(),
          troops: renderTroops(a.troops),
        }),
        player: attacker as PlayerView,
      });
    }
    // Damaged buildings without a repair station: nothing mends them.
    if (me.units(UnitType.RepairStation).length === 0) {
      let damaged = 0;
      let where: TileRef | undefined;
      for (const u of me.units()) {
        if (!Structures.has(u.type()) || u.isUnderConstruction()) continue;
        if (!u.hasHealth() || structureHealthFraction(u) >= 0.6) continue;
        damaged++;
        where ??= u.tile();
      }
      if (damaged > 0) {
        add({
          key: "damage",
          kind: "damage",
          severity: "medium",
          icon: "🏚️",
          text: translateText("alerts.damaged", { count: damaged }),
          tile: where,
        });
      }
    }
    const unrest = Math.round(me.unrestShare() * 100);
    if (unrest >= 40) {
      add({
        key: "unrest",
        kind: "unrest",
        severity: "medium",
        icon: "🔥",
        text: translateText("alerts.unrest", { percent: unrest }),
        player: me,
      });
    }

    const now = this.game.ticks();
    for (const [key, a] of this.eventAlerts) {
      if ((a.expiresAt ?? 0) <= now) this.eventAlerts.delete(key);
      else add(a);
    }
    // Dismissed alerts come back after a minute if their cause is still there.
    for (const [key, tick] of this.dismissed) {
      if (now - tick > 600) this.dismissed.delete(key);
    }

    out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    this.alerts = out;
  }

  // ── UI ─────────────────────────────────────────────────────────────────

  private visible(): Alert[] {
    return this.alerts.filter(
      (a) =>
        !this.dismissed.has(a.key) &&
        !this.prefs.muted.includes(a.kind) &&
        (!this.prefs.urgentOnly ||
          a.severity === "critical" ||
          a.severity === "high"),
    );
  }

  private setPrefs(p: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...p };
    savePrefs(this.prefs);
  }

  private jump(a: Alert) {
    if (a.tile !== undefined) {
      this.eventBus.emit(
        new GoToPositionEvent(this.game.x(a.tile), this.game.y(a.tile)),
      );
    } else if (a.player !== undefined) {
      this.eventBus.emit(new GoToPlayerEvent(a.player));
    }
  }

  private dismiss(a: Alert) {
    this.dismissed.set(a.key, this.game.ticks());
    this.eventAlerts.delete(a.key);
    this.requestUpdate();
  }

  private mute(kind: AlertKind) {
    if (!this.prefs.muted.includes(kind)) {
      this.setPrefs({ muted: [...this.prefs.muted, kind] });
    }
  }

  private severityClass(s: Severity): string {
    switch (s) {
      case "critical":
        return "border-red-500 bg-red-900/70 animate-pulse";
      case "high":
        return "border-orange-400 bg-orange-900/60";
      case "medium":
        return "border-yellow-400/70 bg-yellow-900/40";
      case "info":
        return "border-sky-400/60 bg-sky-900/40";
    }
  }

  render() {
    if (!this.game?.myPlayer()) return nothing;
    const shown = this.visible();
    const mutedCount = this.prefs.muted.length;
    if (shown.length === 0 && mutedCount === 0 && !this.prefs.urgentOnly) {
      return nothing;
    }
    const rest = shown.length - MAX_SHOWN;
    return html`
      <div
        class="fixed right-2 side-bar:right-16 bottom-[calc(65%+0.25rem)] z-[250] w-72 max-w-[60vw] flex flex-col-reverse items-end gap-1 pointer-events-none text-xs text-white"
      >
        <div class="flex items-center gap-1 pointer-events-auto self-end">
          <button
            class="rounded bg-gray-900/80 border border-white/15 px-1.5 py-0.5 hover:bg-gray-700"
            title=${translateText("alerts.toggle_hint")}
            @click=${() => this.setPrefs({ collapsed: !this.prefs.collapsed })}
          >
            ${this.prefs.collapsed ? "🔔" : "🔔▾"}
            ${shown.length > 0 ? html`<b>${shown.length}</b>` : nothing}
          </button>
          ${
            this.prefs.collapsed
              ? nothing
              : html`
                  <button
                    class="rounded border px-1.5 py-0.5 ${
                      this.prefs.urgentOnly
                        ? "bg-orange-600/70 border-orange-400"
                        : "bg-gray-900/80 border-white/15 hover:bg-gray-700"
                    }"
                    title=${translateText("alerts.urgent_only_hint")}
                    @click=${() =>
                      this.setPrefs({ urgentOnly: !this.prefs.urgentOnly })}
                  >
                    ${translateText("alerts.urgent_only")}
                  </button>
                  ${
                    mutedCount > 0
                      ? html`<button
                          class="rounded bg-gray-900/80 border border-white/15 px-1.5 py-0.5 hover:bg-gray-700"
                          title=${translateText("alerts.unmute_hint")}
                          @click=${() => this.setPrefs({ muted: [] })}
                        >
                          🔕 ${mutedCount}
                        </button>`
                      : nothing
                  }
                `
          }
        </div>
        ${
          this.prefs.collapsed
            ? nothing
            : shown.slice(0, MAX_SHOWN).map(
                (a) => html`
                  <div
                    class="pointer-events-auto self-stretch flex items-center gap-1.5 rounded-md border-l-4 border ${this.severityClass(
                      a.severity,
                    )} px-2 py-1 shadow-lg cursor-pointer hover:brightness-125"
                    title=${translateText("alerts.entry_hint")}
                    @click=${() => this.jump(a)}
                    @contextmenu=${(e: Event) => {
                      e.preventDefault();
                      this.mute(a.kind);
                    }}
                  >
                    <span class="text-base leading-none">${a.icon}</span>
                    <span class="flex-1 leading-tight">${a.text}</span>
                    <button
                      class="text-white/50 hover:text-white px-1"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this.dismiss(a);
                      }}
                    >
                      ×
                    </button>
                  </div>
                `,
              )
        }
        ${
          !this.prefs.collapsed && rest > 0
            ? html`<div class="text-white/60 pl-1">
                ${translateText("alerts.more", { count: rest })}
              </div>`
            : nothing
        }
      </div>
    `;
  }
}
