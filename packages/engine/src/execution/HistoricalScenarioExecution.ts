import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GameType,
  HistoricalScenarioId,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  assignScenarioNations,
  historicalScenario,
  type HistoricalScenario,
  scenarioForConfig,
  scenarioNationByFlag,
  type ScenarioNation,
} from "@openfront/engine-lib/game/HistoricalScenarios";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { PlayerExecution } from "./PlayerExecution";

/**
 * Sets up a historical scenario (engine-lib/game/HistoricalScenarios.ts) on
 * the game's first tick: every scenario nation, AI or human, gets its
 * starting land (grown from its seeds), its spawn, a share of its troop cap,
 * and its bloc's alliances. Runs once.
 */
export class HistoricalScenarioExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(private scenarioId: HistoricalScenarioId) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    this.active = false;
    const scenario = scenarioForConfig(this.mg.config().gameConfig());
    if (scenario === null || scenario.id !== this.scenarioId) return;
    const players = scenarioPlayers(this.mg, scenario);
    const owners = growTerritories(this.mg, scenario);

    // Hand out the land.
    for (let tile = 0; tile < owners.length; tile++) {
      const slot = owners[tile];
      if (slot === 0) continue;
      const player = players[slot - 1];
      if (player !== null) player.conquer(tile);
    }

    scenario.nations.forEach((nation, i) => {
      const player = players[i];
      if (player === null || player.numTilesOwned() === 0) return;
      if (!player.hasSpawned()) {
        this.mg.addExecution(new PlayerExecution(player));
      }
      const home = nationHomeTile(this.mg, nation);
      const spawn =
        home !== null && this.mg.owner(home) === player
          ? home
          : Array.from(player.tiles())[0];
      player.setSpawnTile(spawn);
      this.mg.stats().recordSpawnTile(player, spawn);
      // A nation that owns a country starts with an army to match.
      const troops = Math.floor(
        this.mg.config().maxTroops(player) * scenario.startingTroopShare,
      );
      if (troops > player.troops()) player.setTroops(troops);
    });

    // Singleplayer starts once the player has a place, as when they spawn.
    if (
      this.mg.config().gameConfig().gameType === GameType.Singleplayer &&
      players.some((p) => p !== null && p.type() === PlayerType.Human)
    ) {
      this.mg.endSpawnPhase();
    }

    // The blocs' alliances: they never expire and can't be broken
    // (isFixedScenarioAlliance).
    for (let i = 0; i < scenario.nations.length; i++) {
      for (let j = i + 1; j < scenario.nations.length; j++) {
        const a = players[i];
        const b = players[j];
        const bloc = scenario.nations[i].bloc;
        if (
          a === null ||
          b === null ||
          bloc === null ||
          scenario.nations[j].bloc !== bloc ||
          a.isAlliedWith(b)
        ) {
          continue;
        }
        a.createAllianceRequest(b);
        // The matching request accepts the first one.
        b.createAllianceRequest(a);
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return HistoricalScenarioExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      scenarioId: this.scenarioId,
    });
  }

  restoreSnapshot(s: HistoricalScenarioState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.scenarioId = s.scenarioId;
  }
}

/**
 * The player of each scenario nation, by the nation's index: the human the
 * nation was assigned to, else the AI nation of that name. Null where
 * neither exists.
 */
export function scenarioPlayers(
  game: Game,
  scenario: HistoricalScenario,
): (Player | null)[] {
  const config = game.config().gameConfig();
  const humans = game
    .allPlayers()
    .filter((p) => p.type() === PlayerType.Human && p.clientID() !== null)
    .map((p) => p.clientID()!);
  const assigned = assignScenarioNations(
    scenario,
    humans,
    config.scenarioAssignments,
  );
  const byNation = new Map<string, Player>();
  for (const [clientID, nation] of assigned) {
    const p = game.playerByClientID(clientID);
    if (p !== null) byNation.set(nation.key, p);
  }
  for (const p of game.allPlayers()) {
    if (p.type() !== PlayerType.Nation) continue;
    const nation = scenarioNationByFlag(scenario, p.info().nationFlag);
    if (nation !== null && !byNation.has(nation.key)) {
      byNation.set(nation.key, p);
    }
  }
  return scenario.nations.map((n) => byNation.get(n.key) ?? null);
}

/**
 * Grows every nation's land from its seeds over the map: a breadth-first
 * fill at the same speed for every seed, so neighbours meet halfway. Land
 * goes to whoever reaches it first; lakes and rivers are crossed freely,
 * open sea only for `oceanHop` tiles; a seed stops `radius` steps out.
 * Returns, per tile, 0 for nobody or the nation's index + 1.
 */
export function growTerritories(
  game: Game,
  scenario: HistoricalScenario,
): Uint16Array {
  const map = game.map();
  const width = map.width();
  const height = map.height();
  const size = width * height;
  const owners = new Uint16Array(size);
  const waterSeen = new Uint8Array(size);

  // Queue of [tile, steps, radius, nation index + 1, open sea crossed].
  const capacity = size + 64;
  const qTile = new Int32Array(capacity);
  const qSteps = new Int32Array(capacity);
  const qRadius = new Int32Array(capacity);
  const qOwner = new Uint16Array(capacity);
  const qWet = new Uint8Array(capacity);
  let head = 0;
  let tail = 0;
  const push = (
    tile: TileRef,
    steps: number,
    radius: number,
    owner: number,
    wet: number,
  ) => {
    if (tail >= capacity) return;
    qTile[tail] = tile;
    qSteps[tail] = steps;
    qRadius[tail] = radius;
    qOwner[tail] = owner;
    qWet[tail] = wet;
    tail++;
  };

  scenario.nations.forEach((nation: ScenarioNation, i) => {
    for (const s of nation.seeds) {
      const tile = seedTile(game, s.x, s.y);
      if (tile === null || owners[tile] !== 0) continue;
      owners[tile] = i + 1;
      push(tile, 0, s.radius, i + 1, 0);
    }
  });

  while (head < tail) {
    const tile = qTile[head];
    const steps = qSteps[head];
    const radius = qRadius[head];
    const owner = qOwner[head];
    const wet = qWet[head];
    head++;
    if (steps >= radius) continue;
    const x = tile % width;
    const y = (tile - x) / width;
    for (let k = 0; k < 4; k++) {
      let n: number;
      if (k === 0) {
        if (x === 0) continue;
        n = tile - 1;
      } else if (k === 1) {
        if (x === width - 1) continue;
        n = tile + 1;
      } else if (k === 2) {
        if (y === 0) continue;
        n = tile - width;
      } else {
        if (y === height - 1) continue;
        n = tile + width;
      }
      if (map.isLand(n)) {
        if (map.isImpassable(n) || owners[n] !== 0) continue;
        owners[n] = owner;
        push(n, steps + 1, radius, owner, 0);
      } else {
        const crossed = map.isOcean(n) ? wet + 1 : 0;
        if (crossed > scenario.oceanHop || waterSeen[n] !== 0) continue;
        waterSeen[n] = 1;
        push(n, steps + 1, radius, owner, crossed);
      }
    }
  }
  return owners;
}

/** How far a seed on water or a mountain looks for land to start from. */
const SEED_SNAP = 40;

/**
 * The land tile a seed starts from: the seed's own tile, else the closest
 * claimable land within SEED_SNAP tiles (so a seed a few tiles off the
 * coast still works on every map version). Null if there is none.
 */
export function seedTile(game: Game, x: number, y: number): TileRef | null {
  const map = game.map();
  const ok = (tx: number, ty: number) => {
    if (!map.isValidCoord(tx, ty)) return false;
    const t = map.ref(tx, ty);
    return map.isLand(t) && !map.isImpassable(t);
  };
  if (ok(x, y)) return map.ref(x, y);
  for (let r = 1; r <= SEED_SNAP; r++) {
    let best: TileRef | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!ok(x + dx, y + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = map.ref(x + dx, y + dy);
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** Where a scenario nation's capital (its first seed) lies, if anywhere. */
export function nationHomeTile(
  game: Game,
  nation: ScenarioNation,
): TileRef | null {
  for (const s of nation.seeds) {
    const t = seedTile(game, s.x, s.y);
    if (t !== null) return t;
  }
  return null;
}

/**
 * Whether two players' alliance is one of their scenario bloc's: those
 * never expire and can't be broken. A player is a scenario nation by the
 * flag it plays under (unique within a scenario).
 */
export function isFixedScenarioAlliance(
  game: Game,
  a: Player,
  b: Player,
): boolean {
  const scenario = scenarioForConfig(game.config().gameConfig());
  if (scenario === null) return false;
  const na = scenarioNationByFlag(scenario, a.info().nationFlag);
  const nb = scenarioNationByFlag(scenario, b.info().nationFlag);
  return (
    na !== null &&
    nb !== null &&
    na !== nb &&
    na.bloc !== null &&
    na.bloc === nb.bloc
  );
}

/** Whether the game plays a historical scenario at all. */
export function playsHistoricalScenario(game: Game): boolean {
  return scenarioForConfig(game.config().gameConfig()) !== null;
}

/** The scenario a game plays, for code that needs its data. */
export function gameScenario(game: Game): HistoricalScenario | null {
  return scenarioForConfig(game.config().gameConfig());
}

export { historicalScenario };

const HistoricalScenarioStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  scenarioId: z.enum(HistoricalScenarioId),
});
type HistoricalScenarioState = z.infer<typeof HistoricalScenarioStateSchema>;

export const HistoricalScenarioExecutionSnapshot = execSnapshotType({
  name: "HistoricalScenario",
  version: 1,
  schema: HistoricalScenarioStateSchema,
  cls: () => HistoricalScenarioExecution,
});

/** Whether the player plays one of the game's scenario nations. */
export function isScenarioNationPlayer(game: Game, player: Player): boolean {
  const scenario = scenarioForConfig(game.config().gameConfig());
  return (
    scenario !== null &&
    scenarioNationByFlag(scenario, player.info().nationFlag) !== null
  );
}
