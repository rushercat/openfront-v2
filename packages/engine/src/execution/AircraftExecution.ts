import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Aircraft,
  AirTargets,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, isUnit, OwnerComp, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  AirfieldCoverage,
  flyToward,
  randomTileAround,
  randomTileOnRing,
  threatens,
} from "./AirMovement";
import { ShellExecution } from "./ShellExecution";

export type AircraftType = (typeof Aircraft.types)[number];

type AircraftInput = OwnerComp & { type: AircraftType; patrolTile: TileRef };

/** What a fighter goes for first. Lower is more urgent. */
const FIGHTER_TARGET_TYPES: readonly UnitType[] = [
  UnitType.Bomber,
  UnitType.TransportPlane,
  UnitType.FighterJet,
  UnitType.TransportShip,
  UnitType.AircraftCarrier,
  UnitType.Warship,
  UnitType.NuclearSubmarine,
  UnitType.Tank,
  UnitType.TradeShip,
];

/** Tiles a fighter's shot flies per tick: it has to catch another fighter. */
const FIGHTER_SHOT_SPEED = 8;
/** Tiles a bomb flies per tick. */
const BOMB_SPEED = 3;
/** Random tiles a fighter on guard tries for a waypoint over its own land. */
const GUARD_WAYPOINT_ATTEMPTS = 8;
/** alreadySentShell is pruned of dead units once it holds this many. */
const SENT_SHELL_PRUNE_SIZE = 32;

/**
 * How sharply an aircraft can turn per tick, as the cosine and sine of the
 * angle (fighter 45°, everything else 30°). Constants rather than Math.cos so
 * every client computes exactly the same turns.
 */
const FIGHTER_TURN = { cos: Math.SQRT1_2, sin: Math.SQRT1_2 };
const BOMBER_TURN = { cos: 0.8660254037844386, sin: 0.5 };
/**
 * A waypoint counts as reached within this many tiles: about twice the
 * turning radius (fighter ≈ 5.2, bomber ≈ 3.9), so a plane never circles a
 * waypoint it can't turn onto.
 */
const FIGHTER_ARRIVAL_RANGE = 12;
const BOMBER_ARRIVAL_RANGE = 8;
/**
 * Ticks after a move order during which a damaged plane obeys it instead of
 * breaking off to be repaired (warships wait as long).
 */
const RETREAT_AFTER_ORDER_TICKS = 50;
/** Radius a plane circles its base at while it is repaired. */
const BASE_CIRCLE_RADIUS = 10;

/**
 * A fighter jet or a bomber. Like a warship it patrols around the tile its
 * owner sent it to (warshipState().patrolTile, moved by MoveWarshipExecution)
 * and engages on its own, but it flies in a straight line over land and
 * water and can never stop.
 *
 * - A fighter chases enemy aircraft and ships near it (bombers first) and
 *   shoots them. It cannot hurt structures. Patrolling over its owner's
 *   land it is on guard and only goes for what threatens its owner (see
 *   threatens()); sent anywhere else it hunts everything it may attack.
 * - A bomber circles over the enemy structure nearest its patrol tile and
 *   drops bombs that damage every enemy structure in their blast. It cannot
 *   hurt anything else.
 *
 * Both repair near one of their owner's airfields and only operate within
 * the range of their owner's airfields (AirfieldCoverage): orders beyond it
 * end at its edge, and a plane whose airfield is lost flies back into the
 * range of another. Without any airfield left a plane runs dry and slowly
 * loses health. Only AA Defenses and fighters can shoot them down (a
 * nuke's blast destroys them as well).
 */
export class AircraftExecution implements Execution {
  private random: PseudoRandom;
  private plane: Unit;
  private mg: Game;
  private lastAttack = 0;
  // Boats sink to one shot; don't waste a second one on them.
  private alreadySentShell = new Set<Unit>();
  private lastEmittedCombat = false;
  /**
   * Where the plane points (a unit vector, y southwards) and where exactly it
   * is between tiles. Planes turn gradually instead of reversing on the
   * spot, so they never look like they fly backwards.
   */
  private headingX = 0;
  private headingY = -1;
  private hasHeading = false;
  private posX: number | null = null;
  private posY: number | null = null;
  /**
   * The airfield or carrier a badly damaged plane flies back to and is
   * repaired at (see handleRetreat), like a warship at its port.
   */
  private retreatBase: Unit | undefined = undefined;
  private healRemainder = 0;
  /** A new patrol tile is a fresh order: it ends a retreat for a while. */
  private lastObservedPatrolTile: TileRef | undefined = undefined;
  private lastManualMoveTick = -RETREAT_AFTER_ORDER_TICKS;

  constructor(private input: AircraftInput | Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.plane = this.input;
    } else {
      const spawn = this.input.owner.canBuild(
        this.input.type,
        this.input.patrolTile,
      );
      if (spawn === false) {
        console.warn(
          `Failed to spawn ${this.input.type} for ${this.input.owner.name()} at ${this.input.patrolTile}`,
        );
        return;
      }
      const patrolTile =
        new AirfieldCoverage(mg, this.input.owner).clamp(
          this.input.patrolTile,
        ) ?? this.input.patrolTile;
      this.plane = this.input.owner.buildUnit(this.input.type, spawn, {
        patrolTile,
      });
    }
    // Aircraft bought in the same tick must not fly in formation forever.
    this.random = new PseudoRandom(mg.ticks() + this.plane.id());
  }

  tick(ticks: number): void {
    const plane = this.plane;
    if (!plane.isActive()) {
      return;
    }
    const isInCombat = plane.warshipState().isInCombat ?? false;
    if (this.lastEmittedCombat && !isInCombat) {
      plane.touch();
    }
    this.lastEmittedCombat = isInCombat;

    this.handleManualOrder();
    // Docked at a base it heals at the port rate instead (healAtBase).
    if (plane.warshipState().state !== "docked") {
      this.repair(ticks);
    }
    // Rebuilt every tick: airfields come and go and change level.
    const coverage = new AirfieldCoverage(this.mg, plane.owner());
    if (ticks % 10 === 0 && !this.stayInRange(coverage)) {
      return;
    }
    // Pulling the patrol tile back into range is no order of the player's.
    this.lastObservedPatrolTile = plane.warshipState().patrolTile;

    if (this.handleRetreat()) {
      return;
    }

    if (plane.type() === UnitType.FighterJet) {
      this.tickFighter(coverage);
    } else {
      this.tickBomber(coverage);
    }
  }

  private repair(ticks: number): void {
    const plane = this.plane;
    if (ticks % 2 !== 0 || plane.health() >= plane.maxHealth()) {
      return;
    }
    const range = this.mg.config().airfieldRepairRange();
    const rangeSquared = range * range;
    for (const airfield of plane
      .owner()
      .units(UnitType.Airfield, UnitType.AircraftCarrier)) {
      if (
        !airfield.isUnderConstruction() &&
        this.mg.euclideanDistSquared(plane.tile(), airfield.tile()) <=
          rangeSquared
      ) {
        plane.modifyHealth(this.mg.config().airfieldRepairAmount());
        return;
      }
    }
  }

  /**
   * Sends the plane back into its owner's airfield range when its patrol
   * tile fell out of it, and wears it down without any airfield. False once
   * the plane is lost.
   */
  private stayInRange(coverage: AirfieldCoverage): boolean {
    const plane = this.plane;
    if (!coverage.hasAirfield()) {
      const decay = Math.max(
        1,
        Math.floor(
          (plane.maxHealth() *
            this.mg.config().aircraftNoAirfieldDecayPercent()) /
            100,
        ),
      );
      // modifyHealth removes the plane at 0.
      plane.modifyHealth(-decay);
      return plane.isActive();
    }
    const patrolTile = plane.warshipState().patrolTile;
    if (patrolTile === undefined || coverage.contains(patrolTile)) {
      return true;
    }
    plane.updateWarshipState({ patrolTile: coverage.clamp(patrolTile) });
    plane.setTargetTile(undefined);
    plane.setTargetUnit(undefined);
    return true;
  }

  // --- Retreat for repairs ---

  /** A new patrol tile is the player's (or a nation's) order: obey it. */
  private handleManualOrder(): void {
    const patrolTile = this.plane.warshipState().patrolTile;
    if (
      this.lastObservedPatrolTile !== undefined &&
      patrolTile !== this.lastObservedPatrolTile
    ) {
      this.lastManualMoveTick = this.mg.ticks();
      if (this.retreatBase !== undefined) {
        this.endRetreat();
      }
    }
    this.lastObservedPatrolTile = patrolTile;
  }

  /**
   * A badly damaged plane breaks off, flies back to its owner's nearest
   * airfield or carrier and circles over it until it is fully repaired, then
   * returns to its patrol. Over its base it heals exactly as fast as a
   * warship docked at a port of the same level, relative to its max health
   * (healAtBase). True while the plane is busy with that.
   */
  private handleRetreat(): boolean {
    const plane = this.plane;
    if (this.retreatBase === undefined) {
      if (!this.shouldRetreat()) {
        return false;
      }
      const base = this.nearestBase();
      if (base === undefined) {
        return false;
      }
      this.retreatBase = base;
      this.healRemainder = 0;
      plane.setTargetUnit(undefined);
      plane.setTargetTile(undefined);
      plane.updateWarshipState({
        state: "retreating",
        retreatPort: base.tile(),
        isInCombat: false,
      });
    }
    if (!this.isUsableBase(this.retreatBase)) {
      // Lost or captured: make for the next one.
      const next = this.nearestBase();
      if (next === undefined) {
        this.endRetreat();
        return false;
      }
      this.retreatBase = next;
      plane.setTargetTile(undefined);
    }
    if (plane.health() >= plane.maxHealth()) {
      this.endRetreat();
      return false;
    }

    const base = this.retreatBase;
    const docking = this.mg.config().aircraftDockingRange();
    const docked =
      this.mg.euclideanDistSquared(plane.tile(), base.tile()) <=
      docking * docking;
    // A carrier sails on: keep retreatPort on it.
    plane.updateWarshipState({
      state: docked ? "docked" : "retreating",
      retreatPort: base.tile(),
    });
    if (docked) {
      this.healAtBase(base);
    }
    // Circle over the base (it can't land: planes never stop).
    this.followWaypoints(() =>
      randomTileOnRing(this.mg, this.random, base.tile(), BASE_CIRCLE_RADIUS),
    );
    return true;
  }

  private shouldRetreat(): boolean {
    const plane = this.plane;
    if (this.mg.ticks() - this.lastManualMoveTick < RETREAT_AFTER_ORDER_TICKS) {
      return false;
    }
    const threshold = Math.floor(
      (plane.maxHealth() * this.mg.config().aircraftRetreatHealthPercent()) /
        100,
    );
    return plane.health() < threshold;
  }

  private endRetreat(): void {
    this.retreatBase = undefined;
    this.healRemainder = 0;
    this.plane.setTargetTile(undefined);
    this.plane.updateWarshipState({
      state: "patrolling",
      retreatPort: undefined,
    });
  }

  private isUsableBase(base: Unit): boolean {
    return (
      base.isActive() &&
      base.owner() === this.plane.owner() &&
      !base.isUnderConstruction()
    );
  }

  private nearestBase(): Unit | undefined {
    const tile = this.plane.tile();
    let best: Unit | undefined = undefined;
    let bestDist = 0;
    for (const base of this.plane.owner().airBases()) {
      const dist = this.mg.euclideanDistSquared(tile, base.tile());
      if (
        best === undefined ||
        dist < bestDist ||
        (dist === bestDist && base.id() < best.id())
      ) {
        best = base;
        bestDist = dist;
      }
    }
    return best;
  }

  /**
   * The port rate, scaled to the plane: a docked warship heals
   * warshipPassiveHealing plus the port's level × warshipPortHealingBonusPerLevel,
   * shared among the ships docked there, per tick, out of a warship's max
   * health. A plane over its base heals the same share of its own max health,
   * the pool shared among the owner's planes docked at that base (a carrier
   * counts as level 1). So both take equally long to be repaired.
   */
  private healAtBase(base: Unit): void {
    const mg = this.mg;
    const config = mg.config();
    const plane = this.plane;
    const docking = config.aircraftDockingRange();
    let docked = 0;
    for (const { unit } of mg.nearbyUnits(base.tile(), docking, [
      UnitType.FighterJet,
      UnitType.Bomber,
    ])) {
      if (
        unit.owner() === plane.owner() &&
        unit.warshipState().state === "docked"
      ) {
        docked++;
      }
    }
    docked = Math.max(1, docked);
    const level = base.type() === UnitType.AircraftCarrier ? 1 : base.level();
    const warshipMaxHealth =
      config.unitInfo(UnitType.Warship).maxHealth ?? 1000;
    const warshipHealing =
      config.warshipPassiveHealing() +
      (level * config.warshipPortHealingBonusPerLevel()) / docked;
    this.healRemainder +=
      (warshipHealing * plane.maxHealth()) / warshipMaxHealth;
    const healing = Math.floor(this.healRemainder);
    if (healing <= 0) {
      return;
    }
    this.healRemainder -= healing;
    plane.modifyHealth(healing);
  }

  // --- Fighter ---

  private tickFighter(coverage: AirfieldCoverage): void {
    const target = this.findFighterTarget(coverage);
    this.plane.setTargetUnit(target);
    if (target === undefined) {
      this.patrol();
      return;
    }
    this.shootAt(target);
    // Stay on its tail.
    this.flyTo(target.tile());
  }

  private findFighterTarget(coverage: AirfieldCoverage): Unit | undefined {
    const mg = this.mg;
    const config = mg.config();
    const plane = this.plane;
    const owner = plane.owner();
    const patrolTile = plane.warshipState().patrolTile;
    // On guard over its owner's land, or sent out to hunt.
    const onGuard = patrolTile !== undefined && mg.owner(patrolTile) === owner;
    const leashSquared =
      (onGuard ? config.fighterGuardRange() : config.fighterLeashRange()) ** 2;

    let best: Unit | undefined = undefined;
    let bestPriority = 0;
    let bestDistSquared = 0;
    // Visited in nearbyUnits() order, so ties go the same way as before.
    mg.forEachNearbyUnit(
      plane.tile(),
      config.fighterTargetingRange(),
      FIGHTER_TARGET_TYPES,
      (unit, distSquared) => {
        const unitOwner = unit.owner();
        if (
          unit === plane ||
          unitOwner === owner ||
          !owner.canAttackPlayer(unitOwner, true) ||
          this.alreadySentShell.has(unit)
        ) {
          return;
        }
        if (onGuard && !threatens(mg, unit, owner)) {
          return;
        }
        if (unit.isSubmerged() || !coverage.contains(unit.tile())) {
          return;
        }
        const type = unit.type();
        if (
          type === UnitType.Warship &&
          unit.warshipState().state === "docked"
        ) {
          return;
        }
        if (type === UnitType.TradeShip) {
          // Don't sink ships that are on their way to trade with us.
          const destinationOwner = unit.targetUnit()?.owner();
          if (
            destinationOwner === owner ||
            destinationOwner?.isFriendly(owner)
          ) {
            return;
          }
        }
        if (
          patrolTile !== undefined &&
          mg.euclideanDistSquared(patrolTile, unit.tile()) > leashSquared
        ) {
          return;
        }
        const priority = FIGHTER_TARGET_TYPES.indexOf(type);
        if (
          best === undefined ||
          priority < bestPriority ||
          (priority === bestPriority && distSquared < bestDistSquared)
        ) {
          best = unit;
          bestPriority = priority;
          bestDistSquared = distSquared;
        }
      },
    );
    return best;
  }

  private shootAt(target: Unit): void {
    const mg = this.mg;
    const config = mg.config();
    const plane = this.plane;
    plane.updateWarshipState({ isInCombat: true });

    const atAircraft = AirTargets.has(target.type());
    const attackRate = atAircraft
      ? config.fighterAirAttackRate()
      : config.fighterShipAttackRate();
    if (
      mg.ticks() - this.lastAttack < attackRate ||
      mg.euclideanDistSquared(plane.tile(), target.tile()) >
        config.fighterGunRange() ** 2
    ) {
      return;
    }
    this.lastAttack = mg.ticks();
    mg.addExecution(
      new ShellExecution(plane.tile(), plane.owner(), plane, target, {
        damage: atAircraft
          ? config.fighterShotDamage()
          : config.fighterShipShotDamage(),
        speed: FIGHTER_SHOT_SPEED,
      }),
    );
    if (!target.hasHealth()) {
      this.rememberSentShell(target);
      plane.setTargetUnit(undefined);
    }
  }

  private rememberSentShell(target: Unit): void {
    if (this.alreadySentShell.size >= SENT_SHELL_PRUNE_SIZE) {
      for (const unit of this.alreadySentShell) {
        if (!unit.isActive()) {
          this.alreadySentShell.delete(unit);
        }
      }
    }
    this.alreadySentShell.add(target);
  }

  // --- Bomber ---

  private tickBomber(coverage: AirfieldCoverage): void {
    const plane = this.plane;
    const previous = plane.targetUnit();
    let target = previous;
    if (target === undefined || !this.isBombable(target, coverage)) {
      target = this.findBomberTarget(coverage);
      plane.setTargetUnit(target);
      // The old waypoint belonged to the old target (or to the patrol). Only
      // when the target changed: a patrolling bomber without one used to drop
      // its waypoint every tick and zigzag on the spot.
      if (target !== previous) plane.setTargetTile(undefined);
    }
    if (target === undefined) {
      this.patrol();
      return;
    }
    this.bomb(target);
    // Fly passes over it: every chord of this circle is in bombing range.
    const targetTile = target.tile();
    this.followWaypoints(() =>
      randomTileOnRing(
        this.mg,
        this.random,
        targetTile,
        this.mg.config().bomberBombRange(),
      ),
    );
  }

  private isBombable(unit: Unit, coverage: AirfieldCoverage): boolean {
    const owner = this.plane.owner();
    const patrolTile = this.plane.warshipState().patrolTile;
    return (
      unit.isActive() &&
      Structures.has(unit.type()) &&
      unit.owner() !== owner &&
      owner.canAttackPlayer(unit.owner(), true) &&
      patrolTile !== undefined &&
      this.mg.euclideanDistSquared(patrolTile, unit.tile()) <=
        this.mg.config().bomberTargetingRange() ** 2 &&
      coverage.contains(unit.tile())
    );
  }

  private findBomberTarget(coverage: AirfieldCoverage): Unit | undefined {
    const patrolTile = this.plane.warshipState().patrolTile;
    if (patrolTile === undefined) {
      return undefined;
    }
    const owner = this.plane.owner();
    let best: Unit | undefined = undefined;
    let bestDistSquared = 0;
    for (const { unit, distSquared } of this.mg.nearbyUnits(
      patrolTile,
      this.mg.config().bomberTargetingRange(),
      Structures.types,
      undefined,
      true,
    )) {
      if (
        unit.owner() === owner ||
        !owner.canAttackPlayer(unit.owner(), true) ||
        !coverage.contains(unit.tile())
      ) {
        continue;
      }
      if (best === undefined || distSquared < bestDistSquared) {
        best = unit;
        bestDistSquared = distSquared;
      }
    }
    return best;
  }

  private bomb(target: Unit): void {
    const mg = this.mg;
    const config = mg.config();
    const plane = this.plane;
    if (
      mg.euclideanDistSquared(plane.tile(), target.tile()) >
      config.bomberBombRange() ** 2
    ) {
      return;
    }
    plane.updateWarshipState({ isInCombat: true });
    if (mg.ticks() - this.lastAttack < config.bomberAttackRate()) {
      return;
    }
    this.lastAttack = mg.ticks();
    mg.addExecution(
      new ShellExecution(plane.tile(), plane.owner(), plane, target, {
        damage: config.bomberBombDamage(),
        speed: BOMB_SPEED,
        splashRadius: config.bomberBombRadius(),
      }),
    );
  }

  // --- Flying ---

  private patrol(): void {
    const plane = this.plane;
    const patrolTile = plane.warshipState().patrolTile;
    if (patrolTile === undefined || !this.mg.isValidRef(patrolTile)) {
      return;
    }
    const range = this.mg.config().aircraftPatrolRange(plane.type());
    const owner = plane.owner();
    // A fighter on guard stays over its owner's land: straying across the
    // border would make it an intruder for the neighbor's AA Defenses.
    const staysHome =
      plane.type() === UnitType.FighterJet &&
      this.mg.owner(patrolTile) === owner;
    this.followWaypoints(
      () => {
        if (!staysHome) {
          return randomTileAround(this.mg, this.random, patrolTile, range);
        }
        for (let i = 0; i < GUARD_WAYPOINT_ATTEMPTS; i++) {
          const tile = randomTileAround(
            this.mg,
            this.random,
            patrolTile,
            range,
          );
          if (this.mg.owner(tile) === owner) {
            return tile;
          }
        }
        return patrolTile;
      },
      staysHome ? owner : undefined,
    );
  }

  /** Flies to the unit's target tile, drawing the next one on arrival. */
  private followWaypoints(
    nextWaypoint: () => TileRef,
    stayOver?: Player,
  ): void {
    const plane = this.plane;
    let waypoint = plane.targetTile();
    const arrival =
      plane.type() === UnitType.FighterJet
        ? FIGHTER_ARRIVAL_RANGE
        : BOMBER_ARRIVAL_RANGE;
    if (
      waypoint === undefined ||
      this.mg.euclideanDistSquared(waypoint, plane.tile()) <= arrival * arrival
    ) {
      waypoint = nextWaypoint();
      plane.setTargetTile(waypoint);
    }
    this.flyTo(waypoint, stayOver);
  }

  /**
   * Flies `aircraftSpeed` tiles towards `destination`, turning at most
   * FIGHTER_TURN/BOMBER_TURN per tick, so the plane flies curves and always
   * points the way it moves. A plane that has to stay over `stayOver`'s land
   * (a fighter on guard) turns as sharply as it needs to at the border.
   */
  private flyTo(destination: TileRef, stayOver?: Player): void {
    const mg = this.mg;
    const plane = this.plane;
    const tile = plane.tile();
    const speed = mg.config().aircraftSpeed(plane.type());
    const turn =
      plane.type() === UnitType.FighterJet ? FIGHTER_TURN : BOMBER_TURN;

    // The exact position follows the tile, unless something else moved the
    // plane (it spawned, or a carrier carried it).
    if (
      this.posX === null ||
      this.posY === null ||
      Math.round(this.posX) !== mg.x(tile) ||
      Math.round(this.posY) !== mg.y(tile)
    ) {
      this.posX = mg.x(tile);
      this.posY = mg.y(tile);
    }
    const dx = mg.x(destination) - this.posX;
    const dy = mg.y(destination) - this.posY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const wantX = dist > 0 ? dx / dist : this.headingX;
    const wantY = dist > 0 ? dy / dist : this.headingY;
    const ahead =
      !this.hasHeading ||
      this.headingX * wantX + this.headingY * wantY >= turn.cos;
    if (dist <= speed && ahead) {
      // Close enough to get there this tick, and roughly ahead.
      if (dist > 0) {
        this.headingX = dx / dist;
        this.headingY = dy / dist;
        this.hasHeading = true;
      }
      this.posX = mg.x(destination);
      this.posY = mg.y(destination);
      if (destination !== tile) plane.move(destination);
      return;
    }
    if (!this.hasHeading) {
      this.headingX = wantX;
      this.headingY = wantY;
      this.hasHeading = true;
    } else if (this.headingX * wantX + this.headingY * wantY >= turn.cos) {
      this.headingX = wantX;
      this.headingY = wantY;
    } else {
      // Turn by the most it may, towards the side the destination is on.
      const side = this.headingX * wantY - this.headingY * wantX;
      const sin = side >= 0 ? turn.sin : -turn.sin;
      const hx = this.headingX * turn.cos - this.headingY * sin;
      const hy = this.headingX * sin + this.headingY * turn.cos;
      const len = Math.sqrt(hx * hx + hy * hy);
      this.headingX = hx / len;
      this.headingY = hy / len;
    }
    const maxX = mg.width() - 1;
    const maxY = mg.height() - 1;
    this.posX = Math.min(maxX, Math.max(0, this.posX + this.headingX * speed));
    this.posY = Math.min(maxY, Math.max(0, this.posY + this.headingY * speed));
    let next = mg.ref(Math.round(this.posX), Math.round(this.posY));
    if (stayOver !== undefined && mg.owner(next) !== stayOver) {
      // The curve would leave the land it guards: cut straight back instead.
      next = flyToward(mg, tile, destination, speed);
      const ndx = mg.x(next) - mg.x(tile);
      const ndy = mg.y(next) - mg.y(tile);
      const nlen = Math.sqrt(ndx * ndx + ndy * ndy);
      if (nlen > 0) {
        this.headingX = ndx / nlen;
        this.headingY = ndy / nlen;
      }
      this.posX = mg.x(next);
      this.posY = mg.y(next);
    }
    if (next !== tile) plane.move(next);
  }

  isActive(): boolean {
    return this.plane?.isActive();
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AircraftExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            type: this.input.type,
            patrolTile: this.input.patrolTile,
          },
      initialized: this.mg !== undefined,
      random: this.random === undefined ? null : w.random(this.random),
      plane: this.plane === undefined ? null : w.unit(this.plane),
      lastAttack: this.lastAttack,
      alreadySentShell: [...this.alreadySentShell].map((u) => w.unit(u)),
      lastEmittedCombat: this.lastEmittedCombat,
      heading: this.hasHeading ? [this.headingX, this.headingY] : null,
      pos:
        this.posX === null || this.posY === null
          ? null
          : [this.posX, this.posY],
      retreatBase:
        this.retreatBase === undefined ? null : w.unit(this.retreatBase),
      healRemainder: this.healRemainder,
      lastObservedPatrolTile: this.lastObservedPatrolTile ?? null,
      lastManualMoveTick: this.lastManualMoveTick,
    });
  }

  restoreSnapshot(s: AircraftExecutionState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : {
            owner: r.player(s.input.owner),
            type: s.input.type,
            patrolTile: s.input.patrolTile,
          };
    if (s.initialized) this.mg = r.game;
    if (s.random !== null) this.random = r.random(s.random);
    if (s.plane !== null) this.plane = r.unit(s.plane);
    this.lastAttack = s.lastAttack;
    this.alreadySentShell = new Set(s.alreadySentShell.map((i) => r.unit(i)));
    this.lastEmittedCombat = s.lastEmittedCombat;
    const heading = s.heading ?? null;
    this.hasHeading = heading !== null;
    this.headingX = heading?.[0] ?? 0;
    this.headingY = heading?.[1] ?? -1;
    this.posX = s.pos?.[0] ?? null;
    this.posY = s.pos?.[1] ?? null;
    this.retreatBase =
      s.retreatBase === null || s.retreatBase === undefined
        ? undefined
        : r.unit(s.retreatBase);
    this.healRemainder = s.healRemainder ?? 0;
    this.lastObservedPatrolTile = s.lastObservedPatrolTile ?? undefined;
    this.lastManualMoveTick =
      s.lastManualMoveTick ?? -RETREAT_AFTER_ORDER_TICKS;
  }
}

const AircraftExecutionStateSchema = z.object({
  /** An existing aircraft, or the params to build one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    z.object({
      owner: zPlayerRef(),
      type: z.enum(Aircraft.types),
      // Validated by ConstructionExecution.init before it gets here.
      patrolTile: zTile(),
    }),
  ]),
  initialized: z.boolean(),
  /** Null before init() or when the spawn failed. */
  random: zRandom().nullable(),
  plane: zRef().nullable(),
  lastAttack: zInt(),
  /** In insertion order. */
  alreadySentShell: z.array(zRef()),
  lastEmittedCombat: z.boolean(),
  /** Where the plane points and exactly is (absent in older snapshots). */
  heading: z.tuple([z.number(), z.number()]).nullable().optional(),
  pos: z.tuple([z.number(), z.number()]).nullable().optional(),
  /** Retreat for repairs (absent in older snapshots). */
  retreatBase: zRef().nullable().optional(),
  healRemainder: z.number().optional(),
  lastObservedPatrolTile: zTile().nullable().optional(),
  lastManualMoveTick: zInt().optional(),
});
type AircraftExecutionState = z.infer<typeof AircraftExecutionStateSchema>;

export const AircraftExecutionSnapshot = execSnapshotType({
  name: "Aircraft",
  version: 1,
  schema: AircraftExecutionStateSchema,
  cls: () => AircraftExecution,
});
