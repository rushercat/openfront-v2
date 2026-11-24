import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zNum,
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
  Player,
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

/** The submarine idles once it is this close to where it was sent. */
const ARRIVAL_RANGE = 2;

/**
 * A nuclear submarine: a mobile missile silo. Built at a port and sent
 * around like a warship (move_warship), it sails to the tile it was sent to
 * and waits there.
 *
 * Submerged, it is invisible to everyone but its owner and nothing can
 * target it. Ordered to surface (SurfaceSubmarineExecution) it shows up at
 * once but needs submarineSurfaceTicks before it can fire; then it holds a
 * fresh payload (Config.submarinePayload) and Player.nukeSpawn launches
 * nukes from it like from a silo, each spending its payload cost
 * (recordNukeLaunch). It dives again once nothing more fits or after
 * submarineFireWindowTicks. Surfaced it sails at a fraction of its speed.
 */
export class NuclearSubmarineExecution implements Execution {
  private sub: Unit;
  private mg: Game;
  private pathfinder: WaterPathFinder;
  /** Percent points of movement saved up while surfaced (see move()). */
  private moveBudget = 0;

  constructor(
    private input: (UnitParams<UnitType.NuclearSubmarine> & OwnerComp) | Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathfinder = new WaterPathFinder(mg);
    if (isUnit(this.input)) {
      this.sub = this.input;
      return;
    }
    const spawn = this.input.owner.canBuild(
      UnitType.NuclearSubmarine,
      this.input.patrolTile,
    );
    if (spawn === false) {
      console.warn(
        `Failed to spawn nuclear submarine for ${this.input.owner.name()} at ${this.input.patrolTile}`,
      );
      return;
    }
    this.sub = this.input.owner.buildUnit(UnitType.NuclearSubmarine, spawn, {
      patrolTile: this.input.patrolTile,
    });
  }

  tick(ticks: number): void {
    const sub = this.sub;
    if (sub === undefined || !sub.isActive()) {
      return;
    }
    this.updateMode();
    this.move();
  }

  private updateMode(): void {
    const sub = this.sub;
    const state = sub.submarineState();
    if (state === undefined) {
      return;
    }
    const config = this.mg.config();
    const now = this.mg.ticks();
    if (state.mode === "surfacing" && now >= state.readyTick) {
      sub.updateSubmarineState({ mode: "surfaced" });
      return;
    }
    if (state.mode !== "surfaced") {
      return;
    }
    const smallestNuke = config.nukePayloadCost(UnitType.AtomBomb);
    if (
      state.payloadLeft < smallestNuke ||
      now >= state.readyTick + config.submarineFireWindowTicks()
    ) {
      sub.updateSubmarineState({ mode: "submerged", payloadLeft: 0 });
    }
  }

  private move(): void {
    const sub = this.sub;
    const patrolTile = sub.warshipState().patrolTile;
    if (patrolTile === undefined || !this.mg.isValidRef(patrolTile)) {
      return;
    }
    if (
      this.mg.euclideanDistSquared(sub.tile(), patrolTile) <=
      ARRIVAL_RANGE ** 2
    ) {
      return;
    }
    if (!sub.isSubmerged()) {
      // Surfaced it only gets to move on some ticks.
      this.moveBudget += this.mg.config().submarineSurfacedSpeedPercent();
      if (this.moveBudget < 100) {
        return;
      }
      this.moveBudget -= 100;
    }
    const result = this.pathfinder.next(sub.tile(), patrolTile);
    switch (result.status) {
      case PathStatus.COMPLETE:
      case PathStatus.NEXT:
        sub.move(result.node);
        break;
      case PathStatus.NOT_FOUND:
        // Nowhere to go: stay put rather than retry every tick.
        sub.updateWarshipState({ patrolTile: sub.tile() });
        break;
    }
  }

  isActive(): boolean {
    return this.sub?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return NuclearSubmarineExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            patrolTile: this.input.patrolTile,
          },
      initialized: this.mg !== undefined,
      sub: this.sub === undefined ? null : w.unit(this.sub),
      pathfinder:
        this.pathfinder === undefined
          ? null
          : waterPathFinderState(this.pathfinder),
      moveBudget: this.moveBudget,
    });
  }

  restoreSnapshot(s: NuclearSubmarineState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : { owner: r.player(s.input.owner), patrolTile: s.input.patrolTile };
    if (s.initialized) this.mg = r.game;
    if (s.sub !== null) this.sub = r.unit(s.sub);
    if (s.pathfinder !== null) {
      this.pathfinder = restoreWaterPathFinder(r.game, s.pathfinder);
    }
    this.moveBudget = s.moveBudget;
  }
}

const NuclearSubmarineStateSchema = z.object({
  /** An existing submarine, or the params to build one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    z.object({ owner: zPlayerRef(), patrolTile: zTile() }),
  ]),
  initialized: z.boolean(),
  /** Null before init() or when the spawn failed. */
  sub: zRef().nullable(),
  pathfinder: WaterPathFinderSchema.nullable(),
  moveBudget: zInt(),
});
type NuclearSubmarineState = z.infer<typeof NuclearSubmarineStateSchema>;

export const NuclearSubmarineExecutionSnapshot = execSnapshotType({
  name: "NuclearSubmarine",
  version: 1,
  schema: NuclearSubmarineStateSchema,
  cls: () => NuclearSubmarineExecution,
});

/**
 * The surface_submarine order: a submerged submarine of the player starts
 * to surface. It is visible and can be shot at from now on, and can fire
 * once submarineSurfaceTicks have passed.
 */
export class SurfaceSubmarineExecution implements Execution {
  constructor(
    private player: Player,
    private unitId: number,
  ) {}

  init(mg: Game, _ticks: number): void {
    const sub = this.player
      .units(UnitType.NuclearSubmarine)
      .find((unit) => unit.id() === this.unitId);
    if (sub === undefined || !sub.isActive() || !sub.isSubmerged()) {
      return;
    }
    const config = mg.config();
    sub.updateSubmarineState({
      mode: "surfacing",
      readyTick: mg.ticks() + config.submarineSurfaceTicks(),
      payloadLeft: config.submarinePayload(),
    });
  }

  tick(_ticks: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return SurfaceSubmarineExecutionSnapshot.write({
      player: w.player(this.player),
      unitId: this.unitId,
    });
  }

  restoreSnapshot(s: SurfaceSubmarineState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.unitId = s.unitId;
  }
}

// unitId is untrusted intent data (checked in init), so any number.
const SurfaceSubmarineStateSchema = z.object({
  player: zPlayerRef(),
  unitId: zNum(),
});
type SurfaceSubmarineState = z.infer<typeof SurfaceSubmarineStateSchema>;

export const SurfaceSubmarineExecutionSnapshot = execSnapshotType({
  name: "SurfaceSubmarine",
  version: 1,
  schema: SurfaceSubmarineStateSchema,
  cls: () => SurfaceSubmarineExecution,
});
