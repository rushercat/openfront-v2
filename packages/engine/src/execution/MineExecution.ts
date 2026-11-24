import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MineableShips,
  Mines,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, isUnit, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

export type MineType = (typeof Mines.types)[number];

type MineInput = { owner: Player; type: MineType; tile: TileRef };

/**
 * A land or sea mine. Other players do not see it (the client hides it).
 *
 * - A land mine lies on its owner's land. When an enemy attack takes its
 *   tile it kills landMineTroopLossPercent of that attack's troops and is
 *   gone. If the tile changes hands any other way it is gone too.
 * - A sea mine floats on any water. Its owner's and their friends' ships
 *   are told apart and leave it be; any other ship coming within
 *   seaMineTriggerRange sets it off, and it sinks every ship within
 *   seaMineBlastRadius, its owner's included.
 */
export class MineExecution implements Execution {
  private mine: Unit | undefined;
  private mg: Game;

  constructor(private input: MineInput | Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (isUnit(this.input)) {
      this.mine = this.input;
      return;
    }
    const { owner, type, tile } = this.input;
    const spawn = owner.canBuild(type, tile);
    if (spawn === false) {
      console.warn(`cannot place ${type} for ${owner.name()} at ${tile}`);
      return;
    }
    this.mine = owner.buildUnit(type, spawn, {});
  }

  tick(_ticks: number): void {
    const mine = this.mine;
    if (mine === undefined || !mine.isActive()) {
      return;
    }
    if (mine.type() === UnitType.LandMine) {
      this.tickLandMine(mine);
    } else {
      this.tickSeaMine(mine);
    }
  }

  private tickLandMine(mine: Unit): void {
    const owner = mine.owner();
    const tileOwner = this.mg.owner(mine.tile());
    if (tileOwner === owner) {
      return;
    }
    if (tileOwner.isPlayer()) {
      // The attack that just took the tile walks into it.
      const attack = tileOwner
        .outgoingAttacks()
        .find((a) => a.isActive() && a.target() === owner);
      if (attack !== undefined) {
        const loss = Math.floor(
          (attack.troops() * this.mg.config().landMineTroopLossPercent()) / 100,
        );
        attack.setTroops(attack.troops() - loss);
      }
    }
    mine.delete(false);
  }

  private tickSeaMine(mine: Unit): void {
    const mg = this.mg;
    const owner = mine.owner();
    const triggered = mg.anyUnitNearby(
      mine.tile(),
      mg.config().seaMineTriggerRange(),
      MineableShips.types,
      (ship) =>
        ship.isActive() &&
        ship.owner() !== owner &&
        !owner.isFriendly(ship.owner()),
    );
    if (!triggered) {
      return;
    }
    for (const { unit } of mg.nearbyUnits(
      mine.tile(),
      mg.config().seaMineBlastRadius(),
      MineableShips.types,
    )) {
      if (unit.isActive()) {
        unit.delete(true, unit.owner() === owner ? undefined : owner);
      }
    }
    mine.delete(false);
  }

  isActive(): boolean {
    return this.mine?.isActive() ?? false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return MineExecutionSnapshot.write({
      input: isUnit(this.input)
        ? { unit: w.unit(this.input) }
        : {
            owner: w.player(this.input.owner),
            type: this.input.type,
            tile: this.input.tile,
          },
      initialized: this.mg !== undefined,
      mine: this.mine === undefined ? null : w.unit(this.mine),
    });
  }

  restoreSnapshot(s: MineState, r: SnapshotReader): void {
    this.input =
      "unit" in s.input
        ? r.unit(s.input.unit)
        : {
            owner: r.player(s.input.owner),
            type: s.input.type,
            tile: s.input.tile,
          };
    if (s.initialized) this.mg = r.game;
    if (s.mine !== null) this.mine = r.unit(s.mine);
  }
}

const MineStateSchema = z.object({
  /** An existing mine, or the params to place one in init(). */
  input: z.union([
    z.object({ unit: zRef() }),
    z.object({
      owner: zPlayerRef(),
      type: z.enum(Mines.types),
      // Validated by ConstructionExecution.init before it gets here.
      tile: zTile(),
    }),
  ]),
  initialized: z.boolean(),
  /** Null before init() or when the placement failed. */
  mine: zRef().nullable(),
});
type MineState = z.infer<typeof MineStateSchema>;

export const MineExecutionSnapshot = execSnapshotType({
  name: "Mine",
  version: 1,
  schema: MineStateSchema,
  cls: () => MineExecution,
});
