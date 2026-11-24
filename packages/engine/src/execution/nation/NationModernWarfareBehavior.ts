import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import { cruiseTrajectory } from "../CruiseMissileExecution";
import { MoveWarshipExecution } from "../MoveWarshipExecution";
import { findEnemy } from "./NationAircraftBehavior";
import {
  canAfford,
  finished,
  submarineStation,
  waterNear,
} from "./NationGroundNavalBehavior";
import { isPathInterceptable } from "./NationNukePlanning";
import { aiUnitDisabled } from "./NationUtils";

/** How a nation uses carriers, cruise missiles, paratroopers and its capital. */
interface ModernProfile {
  /** Aircraft carriers it keeps. */
  maxCarriers: number;
  /** Cruise missiles it has in the air at once (0: it fires none). */
  maxCruiseMissiles: number;
  /**
   * Whether it reads which SAMs are reloading, and fires through their reach
   * while they can't answer in time. Otherwise it stays clear of every SAM
   * that could shoot the missile down.
   */
  readsSamReloads: boolean;
  /** Share of its troops it drops behind the front (0: it drops none). */
  paradropShare: number;
  /** Whether it moves its capital away from an enemy closing in. */
  movesCapital: boolean;
}

const PROFILES: Record<Difficulty, ModernProfile> = {
  [Difficulty.Easy]: {
    maxCarriers: 0,
    maxCruiseMissiles: 0,
    readsSamReloads: false,
    paradropShare: 0,
    movesCapital: false,
  },
  [Difficulty.Medium]: {
    maxCarriers: 1,
    maxCruiseMissiles: 1,
    readsSamReloads: false,
    paradropShare: 0,
    movesCapital: false,
  },
  [Difficulty.Hard]: {
    maxCarriers: 1,
    maxCruiseMissiles: 2,
    readsSamReloads: false,
    paradropShare: 0.15,
    movesCapital: true,
  },
  [Difficulty.Impossible]: {
    maxCarriers: 2,
    maxCruiseMissiles: 3,
    readsSamReloads: true,
    paradropShare: 0.2,
    movesCapital: true,
  },
};

/** What a cruise missile on each kind of structure is worth to a nation. */
const CRUISE_TARGET_VALUE: Partial<Record<UnitType, number>> = {
  [UnitType.MissileSilo]: 6,
  [UnitType.SAMLauncher]: 5,
  [UnitType.Airfield]: 5,
  [UnitType.Capital]: 4,
  [UnitType.Factory]: 4,
  [UnitType.Port]: 3,
  [UnitType.AADefense]: 3,
  [UnitType.City]: 2,
  [UnitType.RailDepot]: 2,
  [UnitType.DefensePost]: 1,
};

const CRUISE_TARGET_TYPES = Object.keys(CRUISE_TARGET_VALUE) as UnitType[];

/** Troops (share of its maximum) a nation wants before it drops some. */
const PARADROP_MIN_TROOP_RATIO = 0.5;
/** How close enemy land may get to a capital before it is moved. */
const CAPITAL_THREAT_RANGE = 20;
/** How far from that enemy land a new capital has to be. */
const CAPITAL_SAFE_DISTANCE = 60;
/** Cities a nation tries to put its new capital beside, the farthest first. */
const CAPITAL_CITY_CANDIDATES = 5;

/**
 * Carriers, cruise missiles, paratroopers and the capital, for a nation at
 * Medium and up. Called once per attack tick; keeps no state of its own.
 *
 * - Carriers: bought once it has a port and an enemy; they sail for water
 *   off the enemy's coast, where their aircraft reach inland.
 * - Cruise missiles: fired from ready silos at the enemy's most valuable
 *   structures in reach, only when the flight gets past every SAM and
 *   carrier along the way (Impossible also fires while they reload), a few
 *   in the air at a time and never two at a structure one already finishes.
 * - Paratroopers (Hard, Impossible): with troops to spare, a share is
 *   dropped onto an enemy city (or other structure) in air range.
 * - Capital (Hard, Impossible): moved to its city farthest from the enemy
 *   once enemy land closes in on it.
 */
export function handleNationModernWarfare(mg: Game, player: Player): void {
  const profile = PROFILES[mg.config().gameConfig().difficulty];
  const enemy = findEnemy(player);
  handleCarriers(mg, player, profile, enemy);
  if (enemy === null) return;
  handleCruiseMissiles(mg, player, profile, enemy);
  handleParadrop(mg, player, profile, enemy);
  handleCapital(mg, player, profile, enemy);
}

function handleCarriers(
  mg: Game,
  player: Player,
  profile: ModernProfile,
  enemy: Player | null,
): void {
  if (profile.maxCarriers === 0) return;
  const carriers = player.units(UnitType.AircraftCarrier);
  if (
    enemy !== null &&
    carriers.length < profile.maxCarriers &&
    canAfford(mg, player, UnitType.AircraftCarrier)
  ) {
    const port = finished(player, UnitType.Port)[0];
    const water = port === undefined ? null : waterNear(mg, port.tile(), 3);
    if (
      water !== null &&
      player.canBuild(UnitType.AircraftCarrier, water) !== false
    ) {
      mg.addExecution(
        new ConstructionExecution(player, UnitType.AircraftCarrier, water),
      );
    }
  }
  if (enemy === null) return;
  for (const carrier of carriers) {
    const station = submarineStation(mg, carrier, enemy);
    if (station !== null && carrier.warshipState().patrolTile !== station) {
      mg.addExecution(
        new MoveWarshipExecution(player, [carrier.id()], station),
      );
    }
  }
}

function handleCruiseMissiles(
  mg: Game,
  player: Player,
  profile: ModernProfile,
  enemy: Player,
): void {
  if (profile.maxCruiseMissiles === 0) return;
  if (
    player.units(UnitType.CruiseMissile).length >= profile.maxCruiseMissiles ||
    !canAfford(mg, player, UnitType.CruiseMissile)
  ) {
    return;
  }
  const silos = finished(player, UnitType.MissileSilo).filter(
    (s) => !s.isInCooldown(),
  );
  if (silos.length === 0) return;
  const config = mg.config();
  const range = config.cruiseMissileRange();
  const damage = config.cruiseMissileDamage();
  // Where our missiles in the air are going to land.
  const inFlight = player
    .units(UnitType.CruiseMissile)
    .map((m) => m.targetTile())
    .filter((t): t is TileRef => t !== undefined);
  // Best first; the SAM check below is the expensive part.
  const candidates: { structure: Unit; score: number }[] = [];
  for (const structure of enemy.units(CRUISE_TARGET_TYPES)) {
    const value = CRUISE_TARGET_VALUE[structure.type()] ?? 0;
    const tile = structure.tile();
    const inReach = silos.some(
      (s) => mg.euclideanDistSquared(s.tile(), tile) <= range * range,
    );
    if (!inReach) continue;
    // A missile already on its way finishes it: don't waste a second one.
    if (
      structure.health() <= damage &&
      inFlight.some((t) => mg.euclideanDistSquared(t, tile) <= 1)
    ) {
      continue;
    }
    candidates.push({ structure, score: value * structure.level() });
  }
  candidates.sort(
    (a, b) => b.score - a.score || a.structure.id() - b.structure.id(),
  );
  for (const { structure } of candidates) {
    const tile = structure.tile();
    const spawn = player.canBuild(UnitType.CruiseMissile, tile);
    if (spawn === false) continue;
    // Only fire if it gets through: no SAM or carrier along the way that
    // could shoot it down (Impossible: none that is loaded in time).
    const trajectory = cruiseTrajectory(
      mg,
      spawn,
      tile,
      config.cruiseMissileSpeed(),
    );
    if (
      isPathInterceptable(mg, player, trajectory, {
        useReloadState: profile.readsSamReloads,
      })
    ) {
      continue;
    }
    mg.addExecution(
      new ConstructionExecution(player, UnitType.CruiseMissile, tile),
    );
    return;
  }
}

function handleParadrop(
  mg: Game,
  player: Player,
  profile: ModernProfile,
  enemy: Player,
): void {
  if (
    profile.paradropShare === 0 ||
    aiUnitDisabled(mg, player, UnitType.TransportPlane) ||
    player.units(UnitType.TransportPlane).length > 0 ||
    !canAfford(mg, player, UnitType.TransportPlane) ||
    player.troops() < mg.config().maxTroops(player) * PARADROP_MIN_TROOP_RATIO
  ) {
    return;
  }
  let target: TileRef | null = null;
  let bestLevel = 0;
  for (const structure of enemy.units(
    UnitType.City,
    UnitType.Factory,
    UnitType.Port,
  )) {
    if (structure.level() <= bestLevel) continue;
    if (player.canBuild(UnitType.TransportPlane, structure.tile()) === false) {
      continue;
    }
    target = structure.tile();
    bestLevel = structure.level();
  }
  if (target === null) return;
  const troops = Math.floor(player.troops() * profile.paradropShare);
  if (troops < 1) return;
  mg.addExecution(
    new ConstructionExecution(
      player,
      UnitType.TransportPlane,
      target,
      undefined,
      undefined,
      troops,
    ),
  );
}

/** Enemy land within CAPITAL_THREAT_RANGE of the tile, if any. */
function threatNear(mg: Game, tile: TileRef, enemy: Player): TileRef | null {
  const x = mg.x(tile);
  const y = mg.y(tile);
  const r = CAPITAL_THREAT_RANGE;
  for (let dy = -r; dy <= r; dy += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      if (!mg.isValidCoord(x + dx, y + dy)) continue;
      const t = mg.ref(x + dx, y + dy);
      if (mg.owner(t) === enemy) return t;
    }
  }
  return null;
}

function handleCapital(
  mg: Game,
  player: Player,
  profile: ModernProfile,
  enemy: Player,
): void {
  if (!profile.movesCapital) return;
  const capital = player.capital();
  if (
    capital === null ||
    player.units(UnitType.Capital).length > 1 ||
    !canAfford(mg, player, UnitType.Capital, 2n)
  ) {
    return;
  }
  const threat = threatNear(mg, capital.tile(), enemy);
  if (threat === null) return;
  // Next to one of its cities far from the enemy (structures keep their
  // distance, so beside the city rather than on it), the farthest first.
  const minDist = CAPITAL_SAFE_DISTANCE * CAPITAL_SAFE_DISTANCE;
  const cities = finished(player, UnitType.City)
    .map((city) => ({
      city,
      dist: mg.euclideanDistSquared(city.tile(), threat),
    }))
    .filter(({ dist }) => dist > minDist)
    .sort((a, b) => b.dist - a.dist || a.city.id() - b.city.id())
    .slice(0, CAPITAL_CITY_CANDIDATES);
  const offset = mg.config().structureMinDist() + 1;
  for (const { city } of cities) {
    const x = mg.x(city.tile());
    const y = mg.y(city.tile());
    for (const [dx, dy] of [
      [0, 0],
      [offset, 0],
      [-offset, 0],
      [0, offset],
      [0, -offset],
    ]) {
      if (!mg.isValidCoord(x + dx, y + dy)) continue;
      const tile = mg.ref(x + dx, y + dy);
      if (
        mg.owner(tile) !== player ||
        threatNear(mg, tile, enemy) !== null ||
        player.canBuild(UnitType.Capital, tile) === false
      ) {
        continue;
      }
      mg.addExecution(
        new ConstructionExecution(player, UnitType.Capital, tile),
      );
      return;
    }
  }
}
