import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { PathFinding } from "../pathfinding/PathFinder";
import { PathStatus, SteppingPathFinder } from "../pathfinding/types";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import {
  AirPathFinderSchema,
  airPathFinderState,
  restoreAirPathFinder,
} from "../snapshot/PathfinderSnapshots";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/** Tiles a warship's or defense post's shell flies per tick. */
const DEFAULT_SHELL_SPEED = 3;

/**
 * What an aircraft's shot does differently from a warship's shell. A fighter
 * fires fast, weak shells; a bomber drops slow ones with a blast.
 */
export interface ShellOptions {
  /** Damage on impact, instead of the warship roll in effectOnTarget(). */
  damage?: number;
  /** Tiles flown per tick. */
  speed?: number;
  /**
   * Blast radius: the shell damages every structure in it that its owner may
   * attack, not just its target.
   */
  splashRadius?: number;
}

export class ShellExecution implements Execution {
  private active = true;
  private pathFinder: SteppingPathFinder<TileRef>;
  private shell: Unit | undefined;
  private mg: Game;
  private destroyAtTick: number = -1;
  private random: PseudoRandom;
  private fixedDamage: number | null;
  private speed: number;
  private splashRadius: number;

  constructor(
    private spawn: TileRef,
    private _owner: Player,
    private ownerUnit: Unit,
    private target: Unit,
    options: ShellOptions = {},
  ) {
    this.fixedDamage = options.damage ?? null;
    this.speed = options.speed ?? DEFAULT_SHELL_SPEED;
    this.splashRadius = options.splashRadius ?? 0;
  }

  init(mg: Game, ticks: number): void {
    this.pathFinder = PathFinding.Air(mg);
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
  }

  tick(ticks: number): void {
    this.shell ??= this._owner.buildUnit(UnitType.Shell, this.spawn, {});
    if (!this.shell.isActive()) {
      this.active = false;
      return;
    }
    if (
      !this.target.isActive() ||
      this.target.owner() === this.shell.owner() ||
      (this.destroyAtTick !== -1 && this.mg.ticks() >= this.destroyAtTick)
    ) {
      this.shell.delete(false);
      this.active = false;
      return;
    }

    if (this.destroyAtTick === -1 && !this.ownerUnit.isActive()) {
      this.destroyAtTick = this.mg.ticks() + this.mg.config().shellLifetime();
    }

    for (let i = 0; i < this.speed; i++) {
      const result = this.pathFinder.next(
        this.shell.tile(),
        this.target.tile(),
      );
      if (result.status === PathStatus.COMPLETE) {
        this.active = false;
        const targetType = this.target.type();
        const targetWasActive = this.target.isActive();
        const damage = this.fixedDamage ?? this.effectOnTarget();
        if (this.splashRadius > 0) {
          this.damageStructuresInBlast(damage);
        } else {
          this.target.modifyHealth(-damage, this._owner);
        }
        // Award veterancy to the firing warship when this shell lands the
        // killing blow on an enemy warship or transport ship.
        if (
          targetWasActive &&
          !this.target.isActive() &&
          this.ownerUnit.isActive() &&
          this.ownerUnit.type() === UnitType.Warship
        ) {
          this.ownerUnit.recordKill(targetType);
        }
        this.shell.setReachedTarget();
        this.shell.delete(false);
        return;
      } else if (result.status === PathStatus.NEXT) {
        this.shell.move(result.node);
      }
    }
  }

  /** A bomb: every structure in the blast its owner may attack takes the hit. */
  private damageStructuresInBlast(damage: number): void {
    const hits = this.mg.nearbyUnits(
      this.target.tile(),
      this.splashRadius,
      Structures.types,
      undefined,
      true,
    );
    for (const { unit } of hits) {
      if (
        !unit.isActive() ||
        unit.owner() === this._owner ||
        !this._owner.canAttackPlayer(unit.owner(), true)
      ) {
        continue;
      }
      unit.modifyHealth(-damage, this._owner);
    }
  }

  private effectOnTarget(): number {
    const { damage } = this.mg.config().unitInfo(UnitType.Shell);
    const baseDamage = damage ?? 250;

    const roll = this.random.nextInt(1, 6);
    let damageMultiplier = (roll - 1) * 25 + 200;

    // Veteran warships hit harder — scale the (integer) multiplier by the firing
    // unit's veterancy. Integer percent math keeps the engine float-free.
    const veterancy = this.ownerUnit.veterancy();
    if (veterancy > 0) {
      const bonusPercent = this.mg.config().warshipVeterancyShellDamageBonus();
      damageMultiplier = Math.floor(
        (damageMultiplier * (100 + veterancy * bonusPercent)) / 100,
      );
    }

    return Math.round((baseDamage / 250) * damageMultiplier);
  }

  public getEffectOnTargetForTesting(): number {
    return this.effectOnTarget();
  }

  isActive(): boolean {
    return this.active;
  }
  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ShellExecutionSnapshot.write({
      active: this.active,
      // mg, the pathfinder and the PRNG are all set by init.
      init:
        this.mg === undefined
          ? null
          : {
              pathFinder: airPathFinderState(this.pathFinder),
              random: w.random(this.random),
            },
      shell: this.shell === undefined ? null : w.unit(this.shell),
      destroyAtTick: this.destroyAtTick,
      spawn: this.spawn,
      owner: w.player(this._owner),
      ownerUnit: w.unit(this.ownerUnit),
      target: w.unit(this.target),
      fixedDamage: this.fixedDamage,
      speed: this.speed,
      splashRadius: this.splashRadius,
    });
  }

  restoreSnapshot(s: ShellState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.init !== null) {
      this.mg = r.game;
      this.pathFinder = restoreAirPathFinder(r.game, s.init.pathFinder);
      this.random = r.random(s.init.random);
    }
    if (s.shell !== null) this.shell = r.unit(s.shell);
    this.destroyAtTick = s.destroyAtTick;
    this.spawn = s.spawn;
    this._owner = r.player(s.owner);
    this.ownerUnit = r.unit(s.ownerUnit);
    this.target = r.unit(s.target);
    this.fixedDamage = s.fixedDamage;
    this.speed = s.speed;
    this.splashRadius = s.splashRadius;
  }
}

const ShellStateSchema = z.object({
  active: z.boolean(),
  init: z
    .object({ pathFinder: AirPathFinderSchema, random: zRandom() })
    .nullable(),
  shell: zRef().nullable(),
  destroyAtTick: zInt(),
  spawn: zTile(),
  owner: zPlayerRef(),
  ownerUnit: zRef(),
  target: zRef(),
  fixedDamage: zNum().nullable(),
  speed: zInt(),
  splashRadius: zInt(),
});
type ShellState = z.infer<typeof ShellStateSchema>;

export const ShellExecutionSnapshot = execSnapshotType({
  name: "Shell",
  version: 2,
  // Version 1 predates aircraft: every shell was a warship's.
  migrations: {
    1: (d) => ({
      ...d,
      fixedDamage: null,
      speed: DEFAULT_SHELL_SPEED,
      splashRadius: 0,
    }),
  },
  schema: ShellStateSchema,
  cls: () => ShellExecution,
});
