import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GameFeature,
  MessageType,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * Runs a capital. Finished, it replaces the owner's previous capital: that
 * is how a capital moves. Lost any other way (taken, bombed), the owner goes
 * without one, and without its bonuses, for capitalLostTicks.
 */
export class CapitalExecution implements Execution {
  private mg: Game;
  private active = true;
  /** Whether the capital was finished (and so replaced the old one). */
  private established = false;

  constructor(private capital: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.capital.isActive()) {
      this.active = false;
      if (this.established) this.onLost();
      return;
    }
    if (this.capital.isUnderConstruction() || this.established) return;
    this.established = true;
    const owner = this.capital.owner();
    for (const other of owner.units(UnitType.Capital)) {
      if (other !== this.capital) other.delete(false);
    }
  }

  private onLost(): void {
    const owner = this.capital.owner();
    // Moved: the new one stands already.
    if (owner.capital() !== null || !owner.isAlive()) return;
    owner.setCapitalLostUntil(
      this.mg.ticks() + this.mg.config().capitalLostTicks(),
    );
    this.mg.displayMessage(
      "events_display.capital_lost",
      MessageType.UNIT_DESTROYED,
      owner.id(),
      undefined,
      { minutes: Math.round(this.mg.config().capitalLostTicks() / 600) },
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CapitalExecutionSnapshot.write({
      initialized: this.mg !== undefined,
      capital: w.unit(this.capital),
      active: this.active,
      established: this.established,
    });
  }

  restoreSnapshot(s: CapitalState, r: SnapshotReader): void {
    if (s.initialized) this.mg = r.game;
    this.capital = r.unit(s.capital);
    this.active = s.active;
    this.established = s.established;
  }
}

const CapitalStateSchema = z.object({
  initialized: z.boolean(),
  capital: zRef(),
  active: z.boolean(),
  established: z.boolean(),
});
type CapitalState = z.infer<typeof CapitalStateSchema>;

export const CapitalExecutionSnapshot = execSnapshotType({
  name: "Capital",
  version: 1,
  schema: CapitalStateSchema,
  cls: () => CapitalExecution,
});

/** How often players without a capital are checked, in ticks. */
const CAPITAL_CHECK_INTERVAL = 10;

/**
 * Gives every player without a capital one, for free, once the spawn phase
 * is over (and once the wait after losing the last one has run out): at the
 * spawn tile if they still hold it, else on their land nearest its middle.
 */
export class CapitalSystemExecution implements Execution {
  private mg: Game;
  private active = true;

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
    if (mg.config().isFeatureDisabled(GameFeature.Capital)) {
      this.active = false;
    }
  }

  tick(ticks: number): void {
    if (ticks % CAPITAL_CHECK_INTERVAL !== 0) return;
    for (const player of this.mg.players()) {
      if (
        player.type() === PlayerType.Bot ||
        !player.hasSpawned() ||
        player.numTilesOwned() === 0 ||
        player.units(UnitType.Capital).length > 0 ||
        player.capitalLostUntil() > ticks
      ) {
        continue;
      }
      placeCapital(this.mg, player);
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CapitalSystemExecutionSnapshot.write({
      initialized: this.mg !== undefined,
      active: this.active,
    });
  }

  restoreSnapshot(s: CapitalSystemState, r: SnapshotReader): void {
    if (s.initialized) this.mg = r.game;
    this.active = s.active;
  }
}

/** The tile a player's capital belongs on: the spawn, else the land's middle. */
export function capitalAnchor(mg: Game, player: Player): TileRef | null {
  const spawn = player.spawnTile();
  if (spawn !== undefined && mg.owner(spawn) === player) return spawn;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const tile of player.tiles()) {
    sumX += mg.x(tile);
    sumY += mg.y(tile);
    count++;
  }
  if (count === 0) return null;
  const cx = sumX / count;
  const cy = sumY / count;
  let best: TileRef | null = null;
  let bestDist = Infinity;
  for (const tile of player.tiles()) {
    const dx = mg.x(tile) - cx;
    const dy = mg.y(tile) - cy;
    const dist = dx * dx + dy * dy;
    // Ties go to the lowest tile, so iteration order doesn't matter.
    if (
      dist < bestDist ||
      (dist === bestDist && best !== null && tile < best)
    ) {
      bestDist = dist;
      best = tile;
    }
  }
  return best;
}

/** Sets up a player's free capital; whether it worked. */
export function placeCapital(mg: Game, player: Player): boolean {
  const anchor = capitalAnchor(mg, player);
  if (anchor === null) return false;
  const spawn = player.canBuild(UnitType.Capital, anchor);
  if (spawn === false) return false;
  const capital = player.buildUnit(UnitType.Capital, spawn, {});
  mg.addExecution(new CapitalExecution(capital));
  return true;
}

const CapitalSystemStateSchema = z.object({
  initialized: z.boolean(),
  active: z.boolean(),
});
type CapitalSystemState = z.infer<typeof CapitalSystemStateSchema>;

export const CapitalSystemExecutionSnapshot = execSnapshotType({
  name: "CapitalSystem",
  version: 1,
  schema: CapitalSystemStateSchema,
  cls: () => CapitalSystemExecution,
});
