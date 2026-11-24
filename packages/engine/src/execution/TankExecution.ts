import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Player,
  Unit,
  UnitParams,
} from "../game/Game";
import { getOrientedRailroad } from "../game/Railroad";
import { TrainStation } from "../game/TrainStation";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { threatens } from "./AirMovement";
import { ShellExecution } from "./ShellExecution";

/** A tank this close to a station can board the railway there. */
const BOARDING_RANGE = 5;
/** The railway is only worth it when it saves at least this many tiles. */
const MIN_RAIL_GAIN = 20;
/** Tiles a tank shell flies per tick. */
const TANK_SHELL_SPEED = 4;
/** Structures that are stations on the railway. */
const STATION_TYPES: readonly UnitType[] = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.RailDepot,
];
const TARGET_TYPES: readonly UnitType[] = [UnitType.Tank, ...Structures.types];

/**
 * A tank. Rolls out of a factory and is sent around like a warship (its
 * target is warshipState().patrolTile), it rides the railway from a station
 * next to it to the station of the same network nearest the target, as long
 * as every station on the way belongs to its owner or a friend, and drives
 * the rest of the way over land, slowly.
 *
 * Near one of its owner's rail depots it is repaired: the best depot within
 * railDepotRepairRange gives back railDepotRepairPerLevel health per level
 * each second.
 *
 * It shoots enemy tanks and structures within tankRange. On its owner's
 * land it only defends (shoots what threatens its owner); sent across the
 * border it attacks everything it may. Attacks on its owner's land near it
 * cost the attacker as much as near a defense post (AttackExecution).
 *
 * It may drive tankBorderBuffer tiles past its owner's border; beyond that
 * it loses tankOutsideDamagePercent of its health each second.
 */
export class TankExecution implements Execution {
  private tank: Unit;
  private mg: Game;
  /** Railway tiles still to ride, in order. */
  private route: TileRef[] = [];
  private routeIndex = 0;
  /** The patrol tile the route was planned for. */
  private plannedFor: TileRef | null = null;
  private lastAttack = 0;

  constructor(private input: (UnitParams<UnitType.Tank> & OwnerComp) | Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.tank = this.input;
      return;
    }
    const spawn = this.input.owner.canBuild(
      UnitType.Tank,
      this.input.patrolTile,
    );
    if (spawn === false) {
      console.warn(
        `Failed to spawn tank for ${this.input.owner.name()} at ${this.input.patrolTile}`,
      );
      return;
    }
    this.tank = this.input.owner.buildUnit(UnitType.Tank, spawn, {
      patrolTile: this.input.patrolTile,
    });
  }

  tick(ticks: number): void {
    const tank = this.tank;
    if (tank === undefined || !tank.isActive()) {
      return;
    }
    if (ticks % 10 === 0) {
      // modifyHealth removes the tank at 0.
      this.wearDownOutsideBuffer();
      if (!tank.isActive()) {
        return;
      }
      this.repairAtDepot();
    }
    this.fight();
    this.drive();
  }

  // --- Border ---

  private wearDownOutsideBuffer(): void {
    const tank = this.tank;
    if (this.isWithinBuffer(tank.owner(), tank.tile())) {
      return;
    }
    const damage = Math.max(
      1,
      Math.floor(
        (tank.maxHealth() * this.mg.config().tankOutsideDamagePercent()) / 100,
      ),
    );
    tank.modifyHealth(-damage);
  }

  /** Health back from the best of the owner's finished rail depots in reach. */
  private repairAtDepot(): void {
    const tank = this.tank;
    if (tank.health() >= tank.maxHealth()) {
      return;
    }
    const config = this.mg.config();
    const owner = tank.owner();
    let level = 0;
    for (const { unit } of this.mg.nearbyUnits(
      tank.tile(),
      config.railDepotRepairRange(),
      UnitType.RailDepot,
    )) {
      if (unit.owner() === owner && unit.isActive()) {
        level = Math.max(level, unit.level());
      }
    }
    if (level > 0) {
      tank.modifyHealth(level * config.railDepotRepairPerLevel());
    }
  }

  /** Whether `tile` is the owner's land or within tankBorderBuffer of it. */
  private isWithinBuffer(owner: Player, tile: TileRef): boolean {
    if (this.mg.owner(tile) === owner) {
      return true;
    }
    const buffer = this.mg.config().tankBorderBuffer();
    const bufferSquared = buffer * buffer;
    for (const border of owner.borderTiles()) {
      if (this.mg.euclideanDistSquared(border, tile) <= bufferSquared) {
        return true;
      }
    }
    return false;
  }

  // --- Combat ---

  private fight(): void {
    const mg = this.mg;
    const config = mg.config();
    const tank = this.tank;
    if (mg.ticks() - this.lastAttack < config.tankAttackRate()) {
      return;
    }
    const target = this.findTarget();
    tank.setTargetUnit(target);
    const inCombat = target !== undefined;
    if ((tank.warshipState().isInCombat ?? false) !== inCombat) {
      tank.updateWarshipState({ isInCombat: inCombat });
    }
    if (target === undefined) {
      return;
    }
    this.lastAttack = mg.ticks();
    mg.addExecution(
      new ShellExecution(tank.tile(), tank.owner(), tank, target, {
        damage: config.tankShotDamage(),
        speed: TANK_SHELL_SPEED,
      }),
    );
  }

  private findTarget(): Unit | undefined {
    const mg = this.mg;
    const tank = this.tank;
    const owner = tank.owner();
    // At home a tank only defends, like a fighter on guard.
    const atHome = mg.owner(tank.tile()) === owner;
    let best: Unit | undefined = undefined;
    let bestIsTank = false;
    let bestDistSquared = 0;
    for (const { unit, distSquared } of mg.nearbyUnits(
      tank.tile(),
      mg.config().tankRange(),
      TARGET_TYPES,
    )) {
      const unitOwner = unit.owner();
      if (
        unit === tank ||
        !unit.isActive() ||
        unitOwner === owner ||
        !owner.canAttackPlayer(unitOwner, true)
      ) {
        continue;
      }
      const isTank = unit.type() === UnitType.Tank;
      if (atHome && !(isTank && threatens(mg, unit, owner))) {
        continue;
      }
      // Enemy tanks first: they shoot back.
      if (
        best === undefined ||
        (isTank && !bestIsTank) ||
        (isTank === bestIsTank && distSquared < bestDistSquared)
      ) {
        best = unit;
        bestIsTank = isTank;
        bestDistSquared = distSquared;
      }
    }
    return best;
  }

  // --- Driving ---

  private drive(): void {
    const tank = this.tank;
    const patrolTile = tank.warshipState().patrolTile;
    if (patrolTile === undefined || !this.mg.isValidRef(patrolTile)) {
      return;
    }
    if (patrolTile !== this.plannedFor) {
      this.plannedFor = patrolTile;
      this.route = this.railRoute(patrolTile) ?? [];
      this.routeIndex = 0;
    }
    if (this.routeIndex < this.route.length) {
      const last = Math.min(
        this.routeIndex + this.mg.config().tankRailSpeed() - 1,
        this.route.length - 1,
      );
      tank.move(this.route[last]);
      this.routeIndex = last + 1;
      return;
    }
    if (tank.tile() === patrolTile) {
      return;
    }
    const next = this.stepOverLand(patrolTile);
    if (next === undefined) {
      // Blocked (water in the way): stop here.
      tank.updateWarshipState({ patrolTile: tank.tile() });
      this.plannedFor = tank.tile();
      return;
    }
    tank.move(next);
  }

  /** The land neighbor that brings the tank closest to `target`. */
  private stepOverLand(target: TileRef): TileRef | undefined {
    const mg = this.mg;
    const from = this.tank.tile();
    let best: TileRef | undefined = undefined;
    let bestDist = mg.euclideanDistSquared(from, target);
    const x = mg.x(from);
    const y = mg.y(from);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || !mg.isValidCoord(x + dx, y + dy)) {
          continue;
        }
        const tile = mg.ref(x + dx, y + dy);
        if (!mg.isLand(tile) || mg.isImpassable(tile)) {
          continue;
        }
        const dist = mg.euclideanDistSquared(tile, target);
        if (dist < bestDist) {
          best = tile;
          bestDist = dist;
        }
      }
    }
    return best;
  }

  /**
   * The railway tiles from a station next to the tank to the station of
   * the same network nearest `target`, or null when there is none or it
   * does not save enough. Only its owner's and friends' stations count.
   */
  private railRoute(target: TileRef): TileRef[] | null {
    const mg = this.mg;
    const tank = this.tank;
    const owner = tank.owner();
    const friendly = (station: TrainStation): boolean => {
      const stationOwner = station.unit.owner();
      return (
        station.isActive() &&
        (stationOwner === owner || owner.isFriendly(stationOwner))
      );
    };
    const stations = mg.railNetwork().stationManager();

    let from: TrainStation | null = null;
    let fromDist = 0;
    for (const { unit, distSquared } of mg.nearbyUnits(
      tank.tile(),
      BOARDING_RANGE,
      STATION_TYPES,
    )) {
      const station = stations.findStation(unit);
      if (
        station === null ||
        station.getCluster() === null ||
        !friendly(station)
      ) {
        continue;
      }
      if (from === null || distSquared < fromDist) {
        from = station;
        fromDist = distSquared;
      }
    }
    const cluster = from?.getCluster();
    if (from === null || cluster === null || cluster === undefined) {
      return null;
    }

    let to: TrainStation | null = null;
    let toDist = 0;
    for (const station of cluster.stations) {
      if (!friendly(station)) {
        continue;
      }
      const dist = mg.euclideanDistSquared(station.tile(), target);
      if (to === null || dist < toDist) {
        to = station;
        toDist = dist;
      }
    }
    if (to === null || to === from) {
      return null;
    }
    const direct = Math.sqrt(mg.euclideanDistSquared(tank.tile(), target));
    if (Math.sqrt(toDist) + MIN_RAIL_GAIN > direct) {
      return null;
    }

    const path = mg.railNetwork().findStationsPath(from, to);
    if (path.length < 2 || !path.every(friendly)) {
      return null;
    }
    const tiles: TileRef[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const rail = getOrientedRailroad(path[i], path[i + 1]);
      if (rail === null) {
        return null;
      }
      tiles.push(...rail.getTiles());
    }
    tiles.push(to.tile());
    return tiles;
  }

  isActive(): boolean {
    return this.tank?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return TankExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            patrolTile: this.input.patrolTile,
          },
      initialized: this.mg !== undefined,
      tank: this.tank === undefined ? null : w.unit(this.tank),
      route: w.tiles(this.route),
      routeIndex: this.routeIndex,
      plannedFor: this.plannedFor,
      lastAttack: this.lastAttack,
    });
  }

  restoreSnapshot(s: TankState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : { owner: r.player(s.input.owner), patrolTile: s.input.patrolTile };
    if (s.initialized) this.mg = r.game;
    if (s.tank !== null) this.tank = r.unit(s.tank);
    this.route = Array.from(s.route);
    this.routeIndex = s.routeIndex;
    this.plannedFor = s.plannedFor;
    this.lastAttack = s.lastAttack;
  }
}

const TankStateSchema = z.object({
  /** An existing tank, or the params to build one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    z.object({ owner: zPlayerRef(), patrolTile: zTile() }),
  ]),
  initialized: z.boolean(),
  /** Null before init() or when the spawn failed. */
  tank: zRef().nullable(),
  route: zTiles(),
  routeIndex: zInt(),
  plannedFor: zTile().nullable(),
  lastAttack: zInt(),
});
type TankState = z.infer<typeof TankStateSchema>;

export const TankExecutionSnapshot = execSnapshotType({
  name: "Tank",
  version: 1,
  schema: TankStateSchema,
  cls: () => TankExecution,
});
