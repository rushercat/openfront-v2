import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import {
  Execution,
  Game,
  isUnit,
  OwnerComp,
  Unit,
  UnitParams,
} from "../game/Game";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathStatus } from "../pathfinding/types";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import {
  restoreWaterPathFinder,
  WaterPathFinderSchema,
  waterPathFinderState,
} from "../snapshot/PathfinderSnapshots";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AADefenseExecution } from "./AADefenseExecution";
import {
  SAM_TARGET_TYPES,
  SAMTargetingSystem,
  TargetingStateSchema,
} from "./SAMLauncherExecution";
import { SAMMissileExecution } from "./SAMMissileExecution";

/** The carrier stops once it is this close to where it was sent. */
const ARRIVAL_RANGE = 2;
/** Percent of the ticks a carrier moves on: it is slower than a warship. */
const SPEED_PERCENT = 60;

/**
 * An aircraft carrier: an airfield at sea. Built at a port and sent around
 * like a warship (move_warship), it sails to the tile it was sent to.
 *
 * Planes take off from it and are repaired near it like at an airfield, it
 * adds carrierAircraftCapacity to the player's aircraft cap, and its
 * carrierAirRange around it counts as air range (AirfieldCoverage,
 * Player.aircraftSpawn). Its AA guns are an AADefenseExecution on the
 * carrier itself; its small SAM, run here, holds one missile against nukes
 * and cruise missiles within carrierSamRange and reloads it in
 * carrierSamCooldown ticks. Warships, fighters and sea mines sink it.
 */
export class AircraftCarrierExecution implements Execution {
  private carrier: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  private moveBudget = 0;
  /** Launch ticks of the SAM missile while it reloads. */
  private samQueue: number[] = [];
  private targeting: SAMTargetingSystem | undefined;

  constructor(
    private input: (UnitParams<UnitType.AircraftCarrier> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    if (isUnit(this.input)) {
      this.carrier = this.input;
      return;
    }
    const spawn = this.input.owner.canBuild(
      UnitType.AircraftCarrier,
      this.input.patrolTile,
    );
    if (spawn === false) {
      console.warn(
        `Failed to spawn aircraft carrier for ${this.input.owner.name()} at ${this.input.patrolTile}`,
      );
      return;
    }
    this.carrier = this.input.owner.buildUnit(UnitType.AircraftCarrier, spawn, {
      patrolTile: this.input.patrolTile,
    });
    // Its AA guns.
    mg.addExecution(new AADefenseExecution(this.carrier));
  }

  tick(ticks: number): void {
    const carrier = this.carrier;
    if (carrier === undefined || !carrier.isActive()) {
      return;
    }
    this.fireSam(ticks);
    this.move();
  }

  private fireSam(ticks: number): void {
    const mg = this.mg;
    const cooldown = mg.config().carrierSamCooldown();
    while (this.samQueue.length > 0 && ticks - this.samQueue[0] >= cooldown) {
      this.samQueue.shift();
    }
    if (this.samQueue.length > 0) return;
    if (SAM_TARGET_TYPES.every((type) => mg.unitCount(type) === 0)) return;
    this.targeting ??= new SAMTargetingSystem(mg, this.carrier);
    const target = this.targeting.getValidTargets(ticks)[0];
    if (target === undefined) return;
    this.samQueue.push(ticks);
    target.unit.setTargetedBySAM(true);
    mg.addExecution(
      new SAMMissileExecution(
        this.carrier.tile(),
        this.carrier.owner(),
        this.carrier,
        target.unit,
        target.tile,
      ),
    );
  }

  private move(): void {
    const carrier = this.carrier;
    const patrolTile = carrier.warshipState().patrolTile;
    if (patrolTile === undefined || !this.mg.isValidRef(patrolTile)) {
      return;
    }
    if (
      this.mg.euclideanDistSquared(carrier.tile(), patrolTile) <=
      ARRIVAL_RANGE ** 2
    ) {
      return;
    }
    this.moveBudget += SPEED_PERCENT;
    if (this.moveBudget < 100) return;
    this.moveBudget -= 100;
    const result = this.pathfinder.next(carrier.tile(), patrolTile);
    switch (result.status) {
      case PathStatus.COMPLETE:
      case PathStatus.NEXT:
        carrier.move(result.node);
        break;
      case PathStatus.NOT_FOUND:
        carrier.updateWarshipState({ patrolTile: carrier.tile() });
        break;
    }
  }

  isActive(): boolean {
    return this.carrier?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AircraftCarrierExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            patrolTile: this.input.patrolTile,
          },
      initialized: this.mg !== undefined,
      carrier: this.carrier === undefined ? null : w.unit(this.carrier),
      pathfinder:
        this.pathfinder === undefined
          ? null
          : waterPathFinderState(this.pathfinder),
      moveBudget: this.moveBudget,
      samQueue: [...this.samQueue],
      targeting:
        this.targeting === undefined ? null : this.targeting.getState(),
    });
  }

  restoreSnapshot(s: AircraftCarrierState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : { owner: r.player(s.input.owner), patrolTile: s.input.patrolTile };
    if (s.initialized) this.mg = r.game;
    if (s.carrier !== null) this.carrier = r.unit(s.carrier);
    if (s.pathfinder !== null) {
      this.pathfinder = restoreWaterPathFinder(r.game, s.pathfinder);
    }
    this.moveBudget = s.moveBudget;
    this.samQueue = [...s.samQueue];
    if (s.targeting !== null && this.carrier !== undefined) {
      this.targeting = new SAMTargetingSystem(r.game, this.carrier);
      this.targeting.setState(s.targeting);
    }
  }
}

const AircraftCarrierStateSchema = z.object({
  /** An existing carrier, or the params to build one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    z.object({ owner: zPlayerRef(), patrolTile: zTile() }),
  ]),
  initialized: z.boolean(),
  /** Null before init() or when the spawn failed. */
  carrier: zRef().nullable(),
  pathfinder: WaterPathFinderSchema.nullable(),
  moveBudget: zInt(),
  samQueue: z.array(zInt()),
  targeting: TargetingStateSchema.nullable(),
});
type AircraftCarrierState = z.infer<typeof AircraftCarrierStateSchema>;

export const AircraftCarrierExecutionSnapshot = execSnapshotType({
  name: "AircraftCarrier",
  version: 1,
  schema: AircraftCarrierStateSchema,
  cls: () => AircraftCarrierExecution,
});
