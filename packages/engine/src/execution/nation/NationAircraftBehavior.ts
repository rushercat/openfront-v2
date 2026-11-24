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
import { aiUnitDisabled } from "./NationUtils";

/**
 * Bombers a nation keeps per airfield level, keyed by difficulty. An airfield
 * level holds five aircraft; nations do not fill it with bombers, which they
 * lose to AA Defenses faster than they can pay for them.
 */
const BOMBERS_PER_AIRFIELD_LEVEL: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0.5,
  [Difficulty.Medium]: 1,
  [Difficulty.Hard]: 1,
  [Difficulty.Impossible]: 1.5,
};

/** Fighters a nation at war keeps per airfield level. */
const FIGHTERS_PER_AIRFIELD_LEVEL = 1;

/** Fighters a nation keeps on guard while it has nobody to fight. */
const PEACETIME_FIGHTERS = 1;

/** A nation buys an aircraft once it holds this many times its price. */
const GOLD_RESERVE_FACTOR = 3n;

/**
 * How a nation uses its air force. Called once per attack tick, after the
 * structures (NationStructureBehavior builds the airfields and the AA
 * Defenses).
 *
 * - It buys a few fighters and bombers per airfield level (more bombers on
 *   harder difficulties): bombers only while it has an enemy to bomb, and
 *   only a couple of fighters in peace.
 * - Idle bombers go for the nearest structure of the enemy: whoever attacks
 *   the nation over land, else whoever it attacks. A bad relation alone is
 *   no reason to bomb. With no enemy they wait over an airfield.
 * - Fighters guard the nation's structures and intercept enemy bombers
 *   working on them. They do not escort: over enemy AA Defenses they would
 *   only be shot down.
 *
 * It keeps no state: everything is read off the game, so there is nothing to
 * snapshot.
 */
export function handleNationAircraft(mg: Game, player: Player): void {
  const fightersEnabled = !aiUnitDisabled(mg, player, UnitType.FighterJet);
  const bombersEnabled = !aiUnitDisabled(mg, player, UnitType.Bomber);
  if (!fightersEnabled && !bombersEnabled) {
    return;
  }
  const airfields = player
    .units(UnitType.Airfield)
    .filter((airfield) => !airfield.isUnderConstruction());
  const fighters = player.units(UnitType.FighterJet);
  const bombers = player.units(UnitType.Bomber);
  if (airfields.length === 0 && fighters.length === 0 && bombers.length === 0) {
    return;
  }

  const enemy = findEnemy(player);
  if (airfields.length > 0) {
    maybeBuyAircraft(
      mg,
      player,
      enemy,
      airfields,
      fighters,
      bombers,
      fightersEnabled,
      bombersEnabled,
    );
  }
  directBombers(mg, player, enemy, airfields, bombers);
  directFighters(mg, player, fighters);
}

/** Who the nation is at war with, if anyone. */
export function findEnemy(player: Player): Player | null {
  let enemy: Player | null = null;
  let mostTroops = -1;
  for (const attack of player.incomingAttacks()) {
    const attacker = attack.attacker();
    if (attack.troops() > mostTroops && player.canAttackPlayer(attacker)) {
      enemy = attacker;
      mostTroops = attack.troops();
    }
  }
  if (enemy !== null) {
    return enemy;
  }
  for (const attack of player.outgoingAttacks()) {
    const target = attack.target();
    if (target.isPlayer() && player.canAttackPlayer(target)) {
      return target;
    }
  }
  return null;
}

function nearestStructure(mg: Game, owner: Player, from: TileRef): Unit | null {
  return findClosestBy(owner.units(Structures.types), (structure) =>
    mg.euclideanDistSquared(structure.tile(), from),
  );
}

function nearestAirfieldTile(
  mg: Game,
  airfields: Unit[],
  from: TileRef,
): TileRef | null {
  return (
    findClosestBy(airfields, (airfield) =>
      mg.euclideanDistSquared(airfield.tile(), from),
    )?.tile() ?? null
  );
}

function maybeBuyAircraft(
  mg: Game,
  player: Player,
  enemy: Player | null,
  airfields: Unit[],
  fighters: Unit[],
  bombers: Unit[],
  fightersEnabled: boolean,
  bombersEnabled: boolean,
): void {
  const { difficulty } = mg.config().gameConfig();
  let airfieldLevels = 0;
  for (const airfield of airfields) {
    airfieldLevels += airfield.level();
  }
  const maxBombers = Math.ceil(
    airfieldLevels * BOMBERS_PER_AIRFIELD_LEVEL[difficulty],
  );
  const maxFighters =
    enemy === null
      ? PEACETIME_FIGHTERS
      : Math.max(
          PEACETIME_FIGHTERS,
          airfieldLevels * FIGHTERS_PER_AIRFIELD_LEVEL,
        );

  // Where a new bomber would go; none without an enemy with structures.
  const bombTarget =
    bombersEnabled && enemy !== null && bombers.length < maxBombers
      ? nearestStructure(mg, enemy, airfields[0].tile())
      : null;

  let type: UnitType.FighterJet | UnitType.Bomber;
  let patrolTile: TileRef;
  if (
    bombTarget !== null &&
    (!fightersEnabled ||
      bombers.length <= fighters.length ||
      fighters.length >= maxFighters)
  ) {
    type = UnitType.Bomber;
    patrolTile = bombTarget.tile();
  } else if (fightersEnabled && fighters.length < maxFighters) {
    type = UnitType.FighterJet;
    // Spread the guard over the nation's structures.
    const structures = player.units(Structures.types);
    patrolTile = structures[fighters.length % structures.length].tile();
  } else {
    return;
  }

  const cost = mg.unitInfo(type).cost(mg, player);
  if (
    player.gold() < cost * GOLD_RESERVE_FACTOR ||
    player.canBuild(type, patrolTile) === false
  ) {
    return;
  }
  mg.addExecution(new ConstructionExecution(player, type, patrolTile));
}

function sendTo(mg: Game, player: Player, plane: Unit, tile: TileRef): void {
  if (plane.warshipState().patrolTile !== tile) {
    mg.addExecution(new MoveWarshipExecution(player, [plane.id()], tile));
  }
}

function directBombers(
  mg: Game,
  player: Player,
  enemy: Player | null,
  airfields: Unit[],
  bombers: Unit[],
): void {
  for (const bomber of bombers) {
    // A bomber with a structure in its sights keeps at it.
    const current = bomber.targetUnit();
    if (
      current !== undefined &&
      current.isActive() &&
      current.owner() !== player &&
      player.canAttackPlayer(current.owner())
    ) {
      continue;
    }
    const target =
      enemy === null ? null : nearestStructure(mg, enemy, bomber.tile());
    const destination =
      target?.tile() ?? nearestAirfieldTile(mg, airfields, bomber.tile());
    if (destination !== null) {
      sendTo(mg, player, bomber, destination);
    }
  }
}

function directFighters(mg: Game, player: Player, fighters: Unit[]): void {
  if (fighters.length === 0) {
    return;
  }
  // Our structures that enemy bombers are working on.
  const threatened: TileRef[] = [];
  for (const bomber of mg.units(UnitType.Bomber)) {
    const target = bomber.targetUnit();
    if (
      target !== undefined &&
      target.isActive() &&
      target.owner() === player &&
      player.canAttackPlayer(bomber.owner())
    ) {
      threatened.push(target.tile());
    }
  }

  for (const fighter of fighters) {
    if (threatened.length > 0) {
      const tile = findClosestBy(threatened, (t) =>
        mg.euclideanDistSquared(t, fighter.tile()),
      );
      if (tile !== null) {
        sendTo(mg, player, fighter, tile);
      }
      continue;
    }
    // Nothing to intercept: it stays on guard where it is, unless the land
    // under its post was lost. Over foreign land it would hunt, and be shot.
    const post = fighter.warshipState().patrolTile;
    if (post === undefined || mg.owner(post) !== player) {
      const home = nearestStructure(mg, player, fighter.tile());
      if (home !== null) {
        sendTo(mg, player, fighter, home.tile());
      }
    }
  }
}
