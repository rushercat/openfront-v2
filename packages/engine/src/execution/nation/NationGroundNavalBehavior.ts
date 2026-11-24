import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { findClosestBy } from "@openfront/engine-lib/Util";
import { Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import { MoveWarshipExecution } from "../MoveWarshipExecution";
import { SurfaceSubmarineExecution } from "../NuclearSubmarineExecution";
import { findEnemy } from "./NationAircraftBehavior";
import { aiUnitDisabled } from "./NationUtils";

/** How hard a nation leans on tanks, submarines and mines, by difficulty. */
interface GroundNavalProfile {
  /** Rail depots it builds to repair its tanks (it needs a factory for them). */
  maxDepots: number;
  /** Tanks it keeps per factory level (a level holds five). */
  tanksPerFactoryLevel: number;
  /** Tanks it keeps at most. */
  maxTanks: number;
  /** Cities it wants before it builds a depot in peacetime; at war, any. */
  citiesBeforePeacetimeDepot: number;
  /** Share of its tanks it sends across the border while it attacks. */
  offensiveTankShare: number;
  /** Whether a damaged tank pulls back, and an exposed one avoids warships. */
  careful: boolean;
  /** Nuclear submarines it keeps. */
  maxSubmarines: number;
  /** Land mines it lays in front of an attack on it. */
  maxLandMines: number;
  /** Sea mines it lays off the ports of its enemy. */
  maxSeaMines: number;
}

const PROFILES: Record<Difficulty, GroundNavalProfile> = {
  [Difficulty.Easy]: {
    maxDepots: 1,
    tanksPerFactoryLevel: 1,
    maxTanks: 2,
    citiesBeforePeacetimeDepot: Infinity,
    offensiveTankShare: 0,
    careful: false,
    maxSubmarines: 0,
    maxLandMines: 1,
    maxSeaMines: 0,
  },
  [Difficulty.Medium]: {
    maxDepots: 1,
    tanksPerFactoryLevel: 2,
    maxTanks: 4,
    citiesBeforePeacetimeDepot: 8,
    offensiveTankShare: 1 / 3,
    careful: false,
    maxSubmarines: 1,
    maxLandMines: 2,
    maxSeaMines: 1,
  },
  [Difficulty.Hard]: {
    maxDepots: 2,
    tanksPerFactoryLevel: 3,
    maxTanks: 8,
    citiesBeforePeacetimeDepot: 6,
    offensiveTankShare: 1 / 2,
    careful: true,
    maxSubmarines: 1,
    maxLandMines: 4,
    maxSeaMines: 2,
  },
  [Difficulty.Impossible]: {
    maxDepots: 2,
    tanksPerFactoryLevel: 5,
    maxTanks: 12,
    citiesBeforePeacetimeDepot: 4,
    offensiveTankShare: 2 / 3,
    careful: true,
    maxSubmarines: 2,
    maxLandMines: 6,
    maxSeaMines: 4,
  },
};

/** A nation buys something once it holds this many times its price. */
const GOLD_RESERVE_FACTOR = 3n;
/** Mines are a luxury: more gold in hand before one is laid. */
const MINE_GOLD_RESERVE_FACTOR = 4n;
/** Most border tiles looked at for a front, spread evenly over it. */
const MAX_FRONT_TILES = 64;
/**
 * A tank attacks structures this close to the front. The engine lets it
 * drive tankBorderBuffer (30) past the border unharmed; this keeps a margin.
 */
const TANK_STRIKE_REACH = 22;
/** A careful nation pulls back a tank below this share of its health. */
const TANK_RETREAT_HEALTH = 0.4;
/** An incoming attack worth mining: at least this share of the nation's troops. */
const MINE_WORTHY_ATTACK = 0.1;
/** Where a sea mine goes: this far off an enemy port. */
const SEA_MINE_PORT_DISTANCE = 9;
/** A submarine counts as on station this close to its firing position. */
const SUB_STATION_RANGE = 12;
/** A careful nation does not surface with an enemy warship this close. */
const SUB_WARSHIP_SAFETY_RANGE = 50;
/** Ticks a submarine waits after a surfacing before the next one. */
const SUB_SURFACE_COOLDOWN = 900;

/**
 * How a nation uses rail depots and tanks, nuclear submarines, and mines.
 * Called once per attack tick, after the air force. Like
 * handleNationAircraft it keeps no state (everything is read off the game),
 * so there is nothing to snapshot, and it uses no randomness.
 *
 * Tanks: it keeps a few tanks per factory level (they roll out of
 * factories, up to a cap by difficulty) and builds a rail depot next to a
 * factory (at war, or in peace once it is big enough on harder
 * difficulties) to repair them. Under attack over land, its tanks take
 * position on the front facing the attacker, where they defend like defense
 * posts. While it attacks, a share of them (more on harder difficulties)
 * crosses the border to shell the enemy's structures near the front, never
 * further than a tank may go unharmed. A careful nation pulls damaged tanks
 * back to a depot to be repaired.
 *
 * Nuclear submarines (Medium and up): it keeps one or two at a port, sends
 * them submerged to the coast of its enemy and surfaces them there when it
 * can pay for nukes; NationNukeBehavior then launches from the surfaced
 * submarine (Player.nukeSpawn picks the nearest launcher). A careful nation
 * does not surface next to enemy warships.
 *
 * Mines: in front of a strong attack on it, it lays land mines on the
 * front; at war (Medium and up) it lays sea mines off the enemy's ports.
 */
export function handleNationGroundAndNaval(mg: Game, player: Player): void {
  const profile = PROFILES[mg.config().gameConfig().difficulty];
  const enemy = findEnemy(player);
  handleTanks(mg, player, profile, enemy);
  handleSubmarines(mg, player, profile, enemy);
  handleLandMines(mg, player, profile);
  handleSeaMines(mg, player, profile, enemy);
}

// --- Shared ---

export function canAfford(
  mg: Game,
  player: Player,
  type: UnitType,
  reserve: bigint = GOLD_RESERVE_FACTOR,
): boolean {
  if (aiUnitDisabled(mg, player, type)) {
    return false;
  }
  return player.gold() >= mg.unitInfo(type).cost(mg, player) * reserve;
}

function build(mg: Game, player: Player, type: UnitType, tile: TileRef): void {
  mg.addExecution(new ConstructionExecution(player, type, tile));
}

function sendTo(mg: Game, player: Player, unit: Unit, tile: TileRef): void {
  if (unit.warshipState().patrolTile !== tile) {
    mg.addExecution(new MoveWarshipExecution(player, [unit.id()], tile));
  }
}

export function finished(player: Player, type: UnitType): Unit[] {
  return player
    .units(type)
    .filter((u) => u.isActive() && !u.isUnderConstruction());
}

/**
 * The player's border tiles that touch `other`'s land, sorted by tile so the
 * answer does not depend on the order the border set keeps, and thinned to
 * at most MAX_FRONT_TILES spread evenly along it.
 */
function frontTiles(mg: Game, player: Player, other: Player): TileRef[] {
  const front: TileRef[] = [];
  // Owner ids and the four neighbours inline: this runs over every border
  // tile, several times per nation decision, on nations with long borders.
  const otherID = other.smallID();
  const w = mg.width();
  const lastRow = (mg.height() - 1) * w;
  for (const tile of player.borderTiles()) {
    const x = tile % w;
    if (
      (tile >= w && mg.ownerID(tile - w) === otherID) ||
      (tile < lastRow && mg.ownerID(tile + w) === otherID) ||
      (x !== 0 && mg.ownerID(tile - 1) === otherID) ||
      (x !== w - 1 && mg.ownerID(tile + 1) === otherID)
    ) {
      front.push(tile);
    }
  }
  front.sort((a, b) => a - b);
  if (front.length <= MAX_FRONT_TILES) {
    return front;
  }
  const step = front.length / MAX_FRONT_TILES;
  const thinned: TileRef[] = [];
  for (let i = 0; i < MAX_FRONT_TILES; i++) {
    thinned.push(front[Math.floor(i * step)]);
  }
  return thinned;
}

/** The player attacking `player` over land with the most troops, if any. */
function strongestLandAttacker(
  player: Player,
): { attacker: Player; troops: number } | null {
  let best: { attacker: Player; troops: number } | null = null;
  for (const attack of player.incomingAttacks()) {
    const attacker = attack.attacker();
    if (
      attack.sourceTile() !== null ||
      !player.canAttackPlayer(attacker) ||
      (best !== null && attack.troops() <= best.troops)
    ) {
      continue;
    }
    best = { attacker, troops: attack.troops() };
  }
  return best;
}

function isAttacking(player: Player, target: Player): boolean {
  return player.outgoingAttacks().some((a) => a.target() === target);
}

// --- Tanks ---

function handleTanks(
  mg: Game,
  player: Player,
  profile: GroundNavalProfile,
  enemy: Player | null,
): void {
  const config = mg.config();
  if (aiUnitDisabled(mg, player, UnitType.Tank)) {
    return;
  }
  // Tanks roll out of factories; depots repair them.
  const factories = finished(player, UnitType.Factory);
  const depots = finished(player, UnitType.RailDepot);
  const tanks = player.units(UnitType.Tank);
  if (!aiUnitDisabled(mg, player, UnitType.RailDepot)) {
    maybeBuildDepot(mg, player, profile, enemy);
  }
  if (factories.length === 0 && tanks.length === 0) {
    return;
  }
  // Where a tank goes to be repaired, or to wait: a depot, else a factory.
  const bases = depots.length > 0 ? depots : factories;

  // Where the tanks are wanted: the front facing an attack on the nation,
  // and the enemy structures near the front while it attacks.
  const attack = strongestLandAttacker(player);
  const defenseFront =
    attack !== null ? frontTiles(mg, player, attack.attacker) : [];
  const strikeTargets =
    enemy !== null &&
    profile.offensiveTankShare > 0 &&
    isAttacking(player, enemy)
      ? structuresNearFront(mg, frontTiles(mg, player, enemy), enemy)
      : [];

  let levels = 0;
  for (const factory of factories) levels += factory.level();
  const wanted = Math.min(
    profile.maxTanks,
    levels * profile.tanksPerFactoryLevel,
    levels * config.tanksPerFactoryLevel(),
  );
  if (
    tanks.length < wanted &&
    (enemy !== null || attack !== null) &&
    canAfford(mg, player, UnitType.Tank)
  ) {
    const spot = defenseFront[0] ?? strikeTargets[0]?.tile() ?? null;
    if (spot !== null && player.canBuild(UnitType.Tank, spot) !== false) {
      build(mg, player, UnitType.Tank, spot);
    }
  }

  const strikers = Math.floor(tanks.length * profile.offensiveTankShare);
  tanks.forEach((tank, i) => {
    if (
      profile.careful &&
      tank.health() < tank.maxHealth() * TANK_RETREAT_HEALTH
    ) {
      const home = findClosestBy(bases, (d) =>
        mg.euclideanDistSquared(d.tile(), tank.tile()),
      );
      if (home !== null) sendTo(mg, player, tank, home.tile());
      return;
    }
    if (i < strikers && strikeTargets.length > 0 && attack === null) {
      // Spread the strikers over the structures nearest the front.
      sendTo(mg, player, tank, strikeTargets[i % strikeTargets.length].tile());
      return;
    }
    if (defenseFront.length > 0) {
      // Spread the defenders evenly along the front.
      const slot = Math.floor(
        ((i + 0.5) * defenseFront.length) / Math.max(1, tanks.length),
      );
      sendTo(
        mg,
        player,
        tank,
        defenseFront[Math.min(slot, defenseFront.length - 1)],
      );
      return;
    }
    // Nothing to do: it comes home if it is out on foreign land.
    const post = tank.warshipState().patrolTile;
    if (post === undefined || mg.owner(post) !== player) {
      const home = findClosestBy(bases, (d) =>
        mg.euclideanDistSquared(d.tile(), tank.tile()),
      );
      if (home !== null) sendTo(mg, player, tank, home.tile());
    }
  });
}

/** The enemy's structures within TANK_STRIKE_REACH of the front, nearest first. */
function structuresNearFront(
  mg: Game,
  front: TileRef[],
  enemy: Player,
): Unit[] {
  if (front.length === 0) return [];
  const reachSquared = TANK_STRIKE_REACH * TANK_STRIKE_REACH;
  const scored: { unit: Unit; dist: number }[] = [];
  for (const unit of enemy.units(Structures.types)) {
    let best = Infinity;
    for (const tile of front) {
      const d = mg.euclideanDistSquared(tile, unit.tile());
      if (d < best) best = d;
    }
    if (best <= reachSquared) scored.push({ unit, dist: best });
  }
  scored.sort((a, b) => a.dist - b.dist || a.unit.id() - b.unit.id());
  return scored.map((s) => s.unit);
}

function maybeBuildDepot(
  mg: Game,
  player: Player,
  profile: GroundNavalProfile,
  enemy: Player | null,
): void {
  if (player.units(UnitType.RailDepot).length >= profile.maxDepots) {
    return;
  }
  const atWar = enemy !== null || strongestLandAttacker(player) !== null;
  if (
    !atWar &&
    player.units(UnitType.City).length < profile.citiesBeforePeacetimeDepot
  ) {
    return;
  }
  if (!canAfford(mg, player, UnitType.RailDepot)) {
    return;
  }
  const factories = finished(player, UnitType.Factory);
  if (factories.length === 0) {
    return;
  }
  // Next to a factory, on the side of the enemy if there is one.
  const toward = enemy !== null ? enemyCenter(mg, enemy) : null;
  let best: TileRef | null = null;
  let bestDist = Infinity;
  for (const factory of factories) {
    for (const [dx, dy] of DEPOT_OFFSETS) {
      const x = mg.x(factory.tile()) + dx;
      const y = mg.y(factory.tile()) + dy;
      if (!mg.isValidCoord(x, y)) continue;
      const tile = mg.ref(x, y);
      if (mg.owner(tile) !== player) continue;
      const dist = toward === null ? 0 : mg.euclideanDistSquared(tile, toward);
      if (dist >= bestDist) continue;
      if (player.canBuild(UnitType.RailDepot, tile) === false) continue;
      best = tile;
      bestDist = dist;
      if (toward === null) break;
    }
    if (best !== null && toward === null) break;
  }
  if (best !== null) {
    build(mg, player, UnitType.RailDepot, best);
  }
}

/** Candidate depot spots around a factory, well inside its reach (110). */
const DEPOT_OFFSETS: readonly [number, number][] = (() => {
  const offsets: [number, number][] = [];
  for (const r of [20, 40, 70]) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      offsets.push([dx * r, dy * r]);
    }
  }
  return offsets;
})();

/** Roughly where the enemy is: its first structure, else its spawn. */
function enemyCenter(mg: Game, enemy: Player): TileRef | null {
  const structure = enemy.units(Structures.types)[0];
  if (structure !== undefined) return structure.tile();
  return enemy.spawnTile() ?? null;
}

// --- Nuclear submarines ---

function handleSubmarines(
  mg: Game,
  player: Player,
  profile: GroundNavalProfile,
  enemy: Player | null,
): void {
  if (
    profile.maxSubmarines === 0 ||
    aiUnitDisabled(mg, player, UnitType.NuclearSubmarine)
  ) {
    return;
  }
  const subs = player.units(UnitType.NuclearSubmarine);
  if (
    subs.length < profile.maxSubmarines &&
    enemy !== null &&
    canAfford(mg, player, UnitType.NuclearSubmarine)
  ) {
    const port = finished(player, UnitType.Port)[0];
    const water = port === undefined ? null : waterNear(mg, port.tile(), 3);
    if (
      water !== null &&
      player.canBuild(UnitType.NuclearSubmarine, water) !== false
    ) {
      build(mg, player, UnitType.NuclearSubmarine, water);
    }
  }
  if (subs.length === 0 || enemy === null) {
    return;
  }
  const canPayNukes =
    !aiUnitDisabled(mg, player, UnitType.AtomBomb) &&
    player.gold() >= mg.unitInfo(UnitType.AtomBomb).cost(mg, player) * 2n;

  for (const sub of subs) {
    const station = submarineStation(mg, sub, enemy);
    if (station !== null) {
      sendTo(mg, player, sub, station);
    }
    const state = sub.submarineState();
    if (state === undefined || state.mode !== "submerged" || !canPayNukes) {
      continue;
    }
    const onStation =
      station === null ||
      mg.euclideanDistSquared(sub.tile(), station) <= SUB_STATION_RANGE ** 2;
    const rested =
      state.readyTick === 0 ||
      mg.ticks() - state.readyTick >= SUB_SURFACE_COOLDOWN;
    if (!onStation || !rested) continue;
    if (
      profile.careful &&
      mg.anyUnitNearby(
        sub.tile(),
        SUB_WARSHIP_SAFETY_RANGE,
        [UnitType.Warship],
        (w) => w.owner() !== player && !player.isFriendly(w.owner()),
      )
    ) {
      continue;
    }
    mg.addExecution(new SurfaceSubmarineExecution(player, sub.id()));
  }
}

/**
 * Where a submarine fires from: water off the enemy's coast nearest the
 * enemy's heartland, in the submarine's own sea. Null if there is none.
 */
export function submarineStation(
  mg: Game,
  sub: Unit,
  enemy: Player,
): TileRef | null {
  const center = enemyCenter(mg, enemy);
  if (center === null) return null;
  const component = mg.getWaterComponent(sub.tile());
  let best: TileRef | null = null;
  let bestDist = Infinity;
  for (const tile of enemy.borderTiles()) {
    if (!mg.isShore(tile)) continue;
    const dist = mg.euclideanDistSquared(tile, center);
    if (
      dist > bestDist ||
      (dist === bestDist && best !== null && tile > best)
    ) {
      continue;
    }
    const water = waterNear(mg, tile, 4);
    if (
      water === null ||
      (component !== null && !mg.hasWaterComponent(water, component))
    ) {
      continue;
    }
    best = water;
    bestDist = dist;
  }
  return best;
}

/** A water tile about `distance` tiles from `tile`, or null. */
export function waterNear(
  mg: Game,
  tile: TileRef,
  distance: number,
): TileRef | null {
  const x = mg.x(tile);
  const y = mg.y(tile);
  for (let d = distance; d >= 1; d--) {
    for (const [dx, dy] of [
      [d, 0],
      [-d, 0],
      [0, d],
      [0, -d],
      [d, d],
      [-d, d],
      [d, -d],
      [-d, -d],
    ]) {
      if (!mg.isValidCoord(x + dx, y + dy)) continue;
      const t = mg.ref(x + dx, y + dy);
      if (mg.isWater(t)) return t;
    }
  }
  return null;
}

// --- Mines ---

function handleLandMines(
  mg: Game,
  player: Player,
  profile: GroundNavalProfile,
): void {
  if (
    profile.maxLandMines === 0 ||
    player.units(UnitType.LandMine).length >= profile.maxLandMines ||
    !canAfford(mg, player, UnitType.LandMine, MINE_GOLD_RESERVE_FACTOR)
  ) {
    return;
  }
  const attack = strongestLandAttacker(player);
  if (attack === null || attack.troops < player.troops() * MINE_WORTHY_ATTACK) {
    return;
  }
  // On the front, where the attack will walk into it soon.
  const front = frontTiles(mg, player, attack.attacker);
  const start = Math.floor(front.length / 2);
  for (let i = 0; i < front.length; i++) {
    const tile = front[(start + i * 7) % front.length];
    if (player.canBuild(UnitType.LandMine, tile) !== false) {
      build(mg, player, UnitType.LandMine, tile);
      return;
    }
  }
}

function handleSeaMines(
  mg: Game,
  player: Player,
  profile: GroundNavalProfile,
  enemy: Player | null,
): void {
  if (
    enemy === null ||
    profile.maxSeaMines === 0 ||
    player.units(UnitType.SeaMine).length >= profile.maxSeaMines ||
    !canAfford(mg, player, UnitType.SeaMine, MINE_GOLD_RESERVE_FACTOR)
  ) {
    return;
  }
  // Off the enemy's ports: its warships and trade ships come by there.
  for (const port of enemy.units(UnitType.Port)) {
    const water = waterNear(mg, port.tile(), SEA_MINE_PORT_DISTANCE);
    if (water !== null && player.canBuild(UnitType.SeaMine, water) !== false) {
      build(mg, player, UnitType.SeaMine, water);
      return;
    }
  }
}
