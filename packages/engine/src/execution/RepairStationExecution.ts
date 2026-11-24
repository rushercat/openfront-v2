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
 * A Repair Station does nothing by itself: PlayerExecution mends its owner's
 * damaged structures in reach of it (Config.repairStationRange and
 * repairStationHealPercent), as damaged structures no longer heal alone.
 */
export class RepairStationExecution implements Execution {
  private mg: Game;
  private active: boolean = true;

  constructor(private station: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.station.isActive()) {
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
    return RepairStationExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      station: w.unit(this.station),
    });
  }

  restoreSnapshot(s: RepairStationState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.station = r.unit(s.station);
  }
}

const RepairStationStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  station: zRef(),
});
type RepairStationState = z.infer<typeof RepairStationStateSchema>;

export const RepairStationExecutionSnapshot = execSnapshotType({
  name: "RepairStation",
  version: 1,
  schema: RepairStationStateSchema,
  cls: () => RepairStationExecution,
});
