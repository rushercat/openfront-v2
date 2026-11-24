import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { flyToward } from "./AirMovement";

/** Ticks an AA missile flies before it gives up. It outruns every aircraft. */
const AA_MISSILE_LIFETIME = 100;

/**
 * A missile an AA Defense fired at an aircraft. Unlike a SAM missile, which
 * flies to a precomputed interception tile and deletes the nuke, this one
 * homes in on its target and damages it.
 */
export class AAMissileExecution implements Execution {
  private active = true;
  private missile: Unit | undefined;
  private mg: Game;
  private ticksLeft = AA_MISSILE_LIFETIME;

  constructor(
    private spawn: TileRef,
    private _owner: Player,
    private target: Unit,
    /** The missile unit, if the AA gun already built it (it usually does). */
    missile?: Unit,
  ) {
    this.missile = missile;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.tick(ticks);
  }

  tick(ticks: number): void {
    this.missile ??= this._owner.buildUnit(UnitType.SAMMissile, this.spawn, {
      targetUnit: this.target,
    });
    if (!this.missile.isActive()) {
      this.active = false;
      return;
    }
    this.ticksLeft--;
    if (
      !this.target.isActive() ||
      this.ticksLeft <= 0 ||
      this.target.owner() === this.missile.owner() ||
      !this.missile.owner().canAttackPlayer(this.target.owner(), true)
    ) {
      this.missile.delete(false);
      this.active = false;
      return;
    }

    const targetTile = this.target.tile();
    const next = flyToward(
      this.mg,
      this.missile.tile(),
      targetTile,
      this.mg.config().aaMissileSpeed(),
    );
    if (next !== this.missile.tile()) {
      this.missile.move(next);
    }
    if (next !== targetTile) {
      return;
    }

    this.active = false;
    this.target.modifyHealth(
      -this.mg.config().aaMissileDamage(),
      this.missile.owner(),
    );
    this.missile.setReachedTarget();
    this.missile.delete(false);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AAMissileExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      missile: this.missile === undefined ? null : w.unit(this.missile),
      ticksLeft: this.ticksLeft,
      spawn: this.spawn,
      owner: w.player(this._owner),
      target: w.unit(this.target),
    });
  }

  restoreSnapshot(s: AAMissileState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    if (s.missile !== null) this.missile = r.unit(s.missile);
    this.ticksLeft = s.ticksLeft;
    this.spawn = s.spawn;
    this._owner = r.player(s.owner);
    this.target = r.unit(s.target);
  }
}

const AAMissileStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  missile: zRef().nullable(),
  ticksLeft: zInt(),
  spawn: zTile(),
  owner: zPlayerRef(),
  target: zRef(),
});
type AAMissileState = z.infer<typeof AAMissileStateSchema>;

export const AAMissileExecutionSnapshot = execSnapshotType({
  name: "AAMissile",
  version: 1,
  schema: AAMissileStateSchema,
  cls: () => AAMissileExecution,
});
