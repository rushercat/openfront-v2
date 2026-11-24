import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  MISSION_CORE_RADIUS,
  MISSION_CORE_SHARE,
  MISSION_HOLD_TICKS,
  type MissionGoal,
  type MissionGoalView,
  type MissionsViewState,
} from "@openfront/engine-api/game/Missions";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  type HistoricalScenario,
  missionsFor,
  scenarioForConfig,
} from "@openfront/engine-lib/game/HistoricalScenarios";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt } from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { nationHomeTile, scenarioPlayers } from "./HistoricalScenarioExecution";

/** How often missions are checked, in ticks. */
const CHECK_INTERVAL = 10;

interface Assignment {
  /** Small id of the human. */
  player: number;
  nation: string;
  goals: MissionGoal[];
  historical: boolean;
  noteKey: string | null;
  heldSince: number | null;
}

/**
 * Secret missions for historical scenarios (GameConfig.scenarioMissions):
 * every human playing a scenario nation is dealt one of that nation's
 * missions at random. Whoever fulfils theirs and holds it for
 * MISSION_HOLD_TICKS wins the game on the spot. Every client simulates all
 * missions; the HUD only ever shows a player their own.
 */
export class MissionExecution implements Execution {
  private active = true;
  private mg: Game;
  private seed = 0;
  private assignments: Assignment[] = [];
  /** Nation key → small id of the player who plays it. */
  private nationPlayers = new Map<string, number>();
  /** Nation key → tiles it started with (for elimination progress). */
  private startTiles = new Map<string, number>();
  private winner: number | null = null;
  private dealt = false;

  // Derived, rebuilt after a restore.
  private scenario: HistoricalScenario | null = null;
  private heartlands = new Map<string, TileRef[]>();
  private lastSent = "";

  constructor(private gameID: GameID) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.seed = simpleHash(this.gameID) + 15485863;
    this.scenario = scenarioForConfig(mg.config().gameConfig());
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  tick(ticks: number): void {
    const scenario = this.scenario;
    if (scenario === null) {
      this.active = false;
      return;
    }
    // The scenario's land is handed out on the first tick; deal after it.
    if (!this.dealt) {
      this.deal(scenario);
      this.dealt = true;
      this.send(ticks, true);
      return;
    }
    if (ticks % CHECK_INTERVAL !== 0) return;
    if (this.mg.inSpawnPhase()) return;
    if (this.mg.getWinner() !== null && this.winner === null) {
      // The game ended some other way.
      this.active = false;
      return;
    }

    for (const a of this.assignments) {
      const player = this.player(a.player);
      if (player === null || !player.isAlive()) {
        a.heldSince = null;
        continue;
      }
      const done = a.goals.every((g) => this.goalView(player, g).done);
      if (done) a.heldSince ??= ticks;
      else a.heldSince = null;
    }
    // Earliest fulfilled mission wins; ties go to the lower small id.
    const winners = this.assignments
      .filter((a) => a.heldSince !== null)
      .filter((a) => ticks - a.heldSince! >= MISSION_HOLD_TICKS)
      .sort((x, y) => x.heldSince! - y.heldSince! || x.player - y.player);
    if (winners.length > 0) {
      const w = this.player(winners[0].player);
      if (w !== null) {
        this.winner = w.smallID();
        this.send(ticks, true);
        this.mg.setWinner(w, this.mg.stats().stats());
        this.active = false;
        return;
      }
    }
    this.send(ticks, false);
  }

  /** Deals every human of a scenario nation one of its missions. */
  private deal(scenario: HistoricalScenario): void {
    const players = scenarioPlayers(this.mg, scenario);
    scenario.nations.forEach((nation, i) => {
      const p = players[i];
      if (p === null) return;
      this.nationPlayers.set(nation.key, p.smallID());
      this.startTiles.set(nation.key, p.numTilesOwned());
    });
    scenario.nations.forEach((nation, i) => {
      const p = players[i];
      if (p?.type() !== PlayerType.Human) return;
      const options = missionsFor(scenario, nation.key);
      if (options.length === 0) return;
      const random = new PseudoRandom(this.seed + p.smallID() * 7919 + i);
      const mission = options[random.nextInt(0, options.length)];
      this.assignments.push({
        player: p.smallID(),
        nation: nation.key,
        goals: mission.goals.map((g) => ({ ...g })),
        historical: mission.historical,
        noteKey: mission.noteKey,
        heldSince: null,
      });
    });
  }

  // ── Goals ──────────────────────────────────────────────────────────────

  private goalView(player: Player, goal: MissionGoal): MissionGoalView {
    switch (goal.kind) {
      case "conquer": {
        const shares = goal.nations.map((n) => this.heartShare(player, n));
        const progress =
          shares.reduce((s, x) => s + Math.min(1, x / MISSION_CORE_SHARE), 0) /
          Math.max(1, shares.length);
        return {
          goal,
          progress,
          done: shares.every((x) => x >= MISSION_CORE_SHARE),
        };
      }
      case "eliminate": {
        const heart = this.heartShare(player, goal.nation);
        const target = this.nationPlayerOf(goal.nation);
        const left = target === null ? 0 : target.numTilesOwned();
        const start = Math.max(1, this.startTiles.get(goal.nation) ?? 1);
        const gone = target === null || !target.isAlive() || left === 0;
        const progress =
          0.5 * Math.min(1, heart / MISSION_CORE_SHARE) +
          0.5 * (gone ? 1 : Math.max(0, 1 - left / start));
        return {
          goal,
          progress,
          done: gone && heart >= MISSION_CORE_SHARE,
        };
      }
      case "land": {
        const total = Math.max(1, this.mg.numLandTiles());
        const share = player.numTilesOwned() / total;
        return {
          goal,
          progress: Math.min(1, share / goal.share),
          done: share >= goal.share,
        };
      }
      case "cities": {
        const levels = player
          .units(UnitType.City)
          .reduce((s, u) => s + u.level(), 0);
        return {
          goal,
          progress: Math.min(1, levels / goal.levels),
          done: levels >= goal.levels,
        };
      }
    }
  }

  /** Share of a nation's heartland the player owns (1 if it has none). */
  private heartShare(player: Player, nationKey: string): number {
    const tiles = this.heartland(nationKey);
    if (tiles.length === 0) return 1;
    let owned = 0;
    for (const t of tiles) {
      if (this.mg.owner(t) === player) owned++;
    }
    return owned / tiles.length;
  }

  /** The land around a nation's capital. */
  private heartland(nationKey: string): TileRef[] {
    const cached = this.heartlands.get(nationKey);
    if (cached !== undefined) return cached;
    const tiles: TileRef[] = [];
    const nation = this.scenario?.nations.find((n) => n.key === nationKey);
    const home = nation === undefined ? null : nationHomeTile(this.mg, nation);
    if (home !== null) {
      const map = this.mg.map();
      const hx = map.x(home);
      const hy = map.y(home);
      const r = MISSION_CORE_RADIUS;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          if (!map.isValidCoord(hx + dx, hy + dy)) continue;
          const t = map.ref(hx + dx, hy + dy);
          if (map.isLand(t) && !map.isImpassable(t)) tiles.push(t);
        }
      }
    }
    this.heartlands.set(nationKey, tiles);
    return tiles;
  }

  private nationPlayerOf(nationKey: string): Player | null {
    const id = this.nationPlayers.get(nationKey);
    return id === undefined ? null : this.player(id);
  }

  private player(smallID: number): Player | null {
    const p = this.mg.playerBySmallID(smallID);
    return p.isPlayer() ? p : null;
  }

  // ── View & snapshot ────────────────────────────────────────────────────

  viewState(): MissionsViewState {
    return {
      holdTicks: MISSION_HOLD_TICKS,
      winner: this.winner,
      missions: this.assignments.map((a) => {
        const p = this.player(a.player);
        return {
          player: a.player,
          nation: a.nation,
          historical: a.historical,
          noteKey: a.noteKey,
          heldSince: a.heldSince,
          goals: a.goals.map((g) =>
            p === null
              ? { goal: g, progress: 0, done: false }
              : this.goalView(p, g),
          ),
        };
      }),
    };
  }

  private send(ticks: number, force: boolean): void {
    const state = this.viewState();
    // Progress rounded to whole percent, so tiny changes don't resend.
    const key = JSON.stringify({
      w: state.winner,
      m: state.missions.map((m) => [
        m.heldSince,
        m.goals.map((g) => [Math.round(g.progress * 100), g.done]),
      ]),
    });
    if (!force && key === this.lastSent && ticks % 100 !== 0) return;
    this.lastSent = key;
    this.mg.addUpdate({ type: GameUpdateType.Missions, state });
  }

  snapshot(_w: SnapshotWriter): ExecRecord {
    return MissionExecutionSnapshot.write({
      gameID: this.gameID,
      initialized: this.mg !== undefined,
      active: this.active,
      seed: this.seed,
      dealt: this.dealt,
      winner: this.winner,
      assignments: this.assignments.map((a) => ({
        ...a,
        goals: a.goals.map((g) => ({ ...g })),
      })),
      nationPlayers: [...this.nationPlayers],
      startTiles: [...this.startTiles],
    });
  }

  restoreSnapshot(s: MissionState, r: SnapshotReader): void {
    this.gameID = s.gameID;
    this.active = s.active;
    this.seed = s.seed;
    this.dealt = s.dealt;
    this.winner = s.winner;
    this.assignments = s.assignments.map((a) => ({
      ...a,
      goals: a.goals.map((g) => ({ ...g }) as MissionGoal),
    }));
    this.nationPlayers = new Map(s.nationPlayers);
    this.startTiles = new Map(s.startTiles);
    this.heartlands.clear();
    this.lastSent = "";
    if (s.initialized) {
      this.mg = r.game;
      this.scenario = scenarioForConfig(r.game.config().gameConfig());
    }
  }
}

const MissionGoalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conquer"), nations: z.array(z.string()) }),
  z.object({ kind: z.literal("eliminate"), nation: z.string() }),
  z.object({ kind: z.literal("land"), share: z.number() }),
  z.object({ kind: z.literal("cities"), levels: zInt() }),
]);

const MissionStateSchema = z.object({
  gameID: z.string(),
  initialized: z.boolean(),
  active: z.boolean(),
  seed: zInt(),
  dealt: z.boolean(),
  winner: zInt().nullable(),
  assignments: z.array(
    z.object({
      player: zInt(),
      nation: z.string(),
      goals: z.array(MissionGoalSchema),
      historical: z.boolean().default(false),
      noteKey: z.string().nullable().default(null),
      heldSince: zInt().nullable(),
    }),
  ),
  nationPlayers: z.array(z.tuple([z.string(), zInt()])),
  startTiles: z.array(z.tuple([z.string(), zInt()])),
});
type MissionState = z.infer<typeof MissionStateSchema>;

export const MissionExecutionSnapshot = execSnapshotType({
  name: "Missions",
  version: 1,
  schema: MissionStateSchema,
  cls: () => MissionExecution,
});
