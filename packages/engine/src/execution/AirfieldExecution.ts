import { zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * An airfield does nothing by itself: PlayerImpl.aircraftSpawn launches
 * aircraft from it and counts its levels toward the aircraft cap, and
 * AircraftExecution repairs aircraft that fly near it.
 */
export class AirfieldExecution implements Execution {
  private mg: Game;
  private active: boolean = true;

  constructor(private airfield: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.airfield.isActive()) {
      this.active = false;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AirfieldExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      airfield: w.unit(this.airfield),
    });
  }

  restoreSnapshot(s: AirfieldState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.airfield = r.unit(s.airfield);
  }
}

const AirfieldStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  airfield: zRef(),
});
type AirfieldState = z.infer<typeof AirfieldStateSchema>;

export const AirfieldExecutionSnapshot = execSnapshotType({
  name: "Airfield",
  version: 1,
  schema: AirfieldStateSchema,
  cls: () => AirfieldExecution,
});
