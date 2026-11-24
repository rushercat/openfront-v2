import { zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { TrainStationExecution } from "./TrainStationExecution";

/**
 * A rail depot joins the railway as a station (it was only placed within
 * reach of a factory, see PlayerImpl.railDepotSpawn) and repairs its
 * owner's tanks around it (TankExecution.repairAtDepot). Tanks themselves
 * roll out of factories (PlayerImpl.tankSpawn).
 */
export class RailDepotExecution implements Execution {
  private mg: Game;
  private active: boolean = true;
  private stationCreated = false;

  constructor(private depot: Unit) {}

  init(mg: Game, _ticks: number): void {
    this.mg = mg;
  }

  tick(_ticks: number): void {
    if (!this.depot.isActive()) {
      this.active = false;
      return;
    }
    if (!this.stationCreated) {
      this.stationCreated = true;
      if (!this.depot.hasTrainStation()) {
        this.mg.addExecution(new TrainStationExecution(this.depot));
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return RailDepotExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      stationCreated: this.stationCreated,
      depot: w.unit(this.depot),
    });
  }

  restoreSnapshot(s: RailDepotState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.stationCreated = s.stationCreated;
    this.depot = r.unit(s.depot);
  }
}

const RailDepotStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  stationCreated: z.boolean(),
  depot: zRef(),
});
type RailDepotState = z.infer<typeof RailDepotStateSchema>;

export const RailDepotExecutionSnapshot = execSnapshotType({
  name: "RailDepot",
  version: 1,
  schema: RailDepotStateSchema,
  cls: () => RailDepotExecution,
});
