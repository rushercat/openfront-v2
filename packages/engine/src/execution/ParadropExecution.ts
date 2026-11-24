import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
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
import { AttackExecution } from "./AttackExecution";

/**
 * Paratroopers: a transport plane takes off from the player's nearest
 * airfield or aircraft carrier with `troops` aboard and flies straight to a
 * tile within the player's air range (Player.paradropSpawn). AA guns and
 * fighters can shoot it down, and the troops aboard are lost with it.
 * Landed, the troops take the tile and attack from there, like a boat
 * landing, behind the front. Over the player's own (or a friend's) land by
 * then, they just join the army.
 */
export class ParadropExecution implements Execution {
  private mg: Game;
  private plane: Unit | null = null;
  private active = true;

  constructor(
    private player: Player,
    private target: TileRef,
    /** Troops to drop; null for paradropDefaultTroopShare of the player's. */
    private troops: number | null,
  ) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (!mg.isValidRef(this.target)) {
      this.active = false;
      return;
    }
    const spawn = this.player.canBuild(UnitType.TransportPlane, this.target);
    if (spawn === false) {
      console.warn(
        `cannot drop paratroopers for ${this.player.name()} at ${this.target}`,
      );
      this.active = false;
      return;
    }
    const wanted =
      this.troops ??
      Math.floor(
        this.player.troops() * mg.config().paradropDefaultTroopShare(),
      );
    const troops = Math.min(
      Math.floor(wanted),
      Math.floor(this.player.troops()),
    );
    if (troops < 1) {
      this.active = false;
      return;
    }
    // buildUnit takes the troops aboard from the player.
    this.plane = this.player.buildUnit(UnitType.TransportPlane, spawn, {
      targetTile: this.target,
      troops,
    });
    const owner = mg.owner(this.target);
    if (owner.isPlayer()) {
      mg.displayIncomingUnit(
        this.plane.id(),
        "events_display.paradrop_inbound",
        MessageType.NAVAL_INVASION_INBOUND,
        owner.id(),
      );
    }
  }

  tick(_ticks: number): void {
    const plane = this.plane;
    if (plane === null || !plane.isActive()) {
      if (plane !== null) {
        this.mg.displayMessage(
          "events_display.paradrop_shot_down",
          MessageType.UNIT_DESTROYED,
          this.player.id(),
          undefined,
          { troops: renderTroops(plane.troops()) },
        );
      }
      this.active = false;
      return;
    }
    const next = flyToward(
      this.mg,
      plane.tile(),
      this.target,
      this.mg.config().transportPlaneSpeed(),
    );
    plane.move(next);
    if (next !== this.target) return;
    this.land(plane);
  }

  private land(plane: Unit): void {
    const mg = this.mg;
    const troops = plane.troops();
    const owner = mg.owner(this.target);
    plane.delete(false);
    this.plane = null;
    this.active = false;
    if (
      owner === this.player ||
      (owner.isPlayer() && this.player.isFriendly(owner)) ||
      !mg.isLand(this.target) ||
      mg.isImpassable(this.target)
    ) {
      this.player.addTroops(troops);
      return;
    }
    this.player.conquer(this.target);
    mg.addExecution(
      new AttackExecution(troops, this.player, owner.id(), this.target, false),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ParadropExecutionSnapshot.write({
      player: w.player(this.player),
      target: this.target,
      troops: this.troops,
      initialized: this.mg !== undefined,
      plane: this.plane === null ? null : w.unit(this.plane),
      active: this.active,
    });
  }

  restoreSnapshot(s: ParadropState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.target = s.target;
    this.troops = s.troops;
    if (s.initialized) this.mg = r.game;
    this.plane = s.plane === null ? null : r.unit(s.plane);
    this.active = s.active;
  }
}

const ParadropStateSchema = z.object({
  player: zPlayerRef(),
  target: zTile(),
  troops: zInt().nullable(),
  initialized: z.boolean(),
  plane: zRef().nullable(),
  active: z.boolean(),
});
type ParadropState = z.infer<typeof ParadropStateSchema>;

export const ParadropExecutionSnapshot = execSnapshotType({
  name: "Paradrop",
  version: 1,
  schema: ParadropStateSchema,
  cls: () => ParadropExecution,
});
