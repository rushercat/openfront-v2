// Every entry is `<ClassName>Snapshot`, exported next to its class.
import { AADefenseExecutionSnapshot } from "../execution/AADefenseExecution";
import { AAMissileExecutionSnapshot } from "../execution/AAMissileExecution";
import { AircraftCarrierExecutionSnapshot } from "../execution/AircraftCarrierExecution";
import { AircraftExecutionSnapshot } from "../execution/AircraftExecution";
import { AirfieldExecutionSnapshot } from "../execution/AirfieldExecution";
import { AllianceExtensionExecutionSnapshot } from "../execution/alliance/AllianceExtensionExecution";
import { AllianceRejectExecutionSnapshot } from "../execution/alliance/AllianceRejectExecution";
import { AllianceRequestExecutionSnapshot } from "../execution/alliance/AllianceRequestExecution";
import { BreakAllianceExecutionSnapshot } from "../execution/alliance/BreakAllianceExecution";
import { AttackExecutionSnapshot } from "../execution/AttackExecution";
import { BoatRetreatExecutionSnapshot } from "../execution/BoatRetreatExecution";
import {
  CapitalExecutionSnapshot,
  CapitalSystemExecutionSnapshot,
} from "../execution/CapitalExecution";
import { CityExecutionSnapshot } from "../execution/CityExecution";
import { ConstructionExecutionSnapshot } from "../execution/ConstructionExecution";
import { CruiseMissileExecutionSnapshot } from "../execution/CruiseMissileExecution";
import { DefensePostExecutionSnapshot } from "../execution/DefensePostExecution";
import {
  DraftExecutionSnapshot,
  DraftPickExecutionSnapshot,
  DraftResearchExecutionSnapshot,
} from "../execution/DraftExecution";
import { DeleteUnitExecutionSnapshot } from "../execution/DeleteUnitExecution";
import { DonateGoldExecutionSnapshot } from "../execution/DonateGoldExecution";
import { DonateTroopsExecutionSnapshot } from "../execution/DonateTroopExecution";
import { DoomsdayClockExecutionSnapshot } from "../execution/DoomsdayClockExecution";
import { EmbargoAllExecutionSnapshot } from "../execution/EmbargoAllExecution";
import { EmbargoExecutionSnapshot } from "../execution/EmbargoExecution";
import { EmojiExecutionSnapshot } from "../execution/EmojiExecution";
import { FactoryExecutionSnapshot } from "../execution/FactoryExecution";
import { HistoricalScenarioExecutionSnapshot } from "../execution/HistoricalScenarioExecution";
import { MarkDisconnectedExecutionSnapshot } from "../execution/MarkDisconnectedExecution";
import { MineExecutionSnapshot } from "../execution/MineExecution";
import { MirvExecutionSnapshot } from "../execution/MIRVExecution";
import { MissileSiloExecutionSnapshot } from "../execution/MissileSiloExecution";
import { MissionExecutionSnapshot } from "../execution/MissionExecution";
import { MoveWarshipExecutionSnapshot } from "../execution/MoveWarshipExecution";
import { NationExecutionSnapshot } from "../execution/NationExecution";
import { NoOpExecutionSnapshot } from "../execution/NoOpExecution";
import {
  NuclearSubmarineExecutionSnapshot,
  SurfaceSubmarineExecutionSnapshot,
} from "../execution/NuclearSubmarineExecution";
import { NukeExecutionSnapshot } from "../execution/NukeExecution";
import { ParadropExecutionSnapshot } from "../execution/ParadropExecution";
import { PauseExecutionSnapshot } from "../execution/PauseExecution";
import { PlayerExecutionSnapshot } from "../execution/PlayerExecution";
import {
  CastVoteExecutionSnapshot,
  PoliticsExecutionSnapshot,
  ProposeDecreeExecutionSnapshot,
} from "../execution/PoliticsExecution";
import { PortExecutionSnapshot } from "../execution/PortExecution";
import { QuickChatExecutionSnapshot } from "../execution/QuickChatExecution";
import { RailDepotExecutionSnapshot } from "../execution/RailDepotExecution";
import { RecomputeRailClusterExecutionSnapshot } from "../execution/RecomputeRailClusterExecution";
import { RepairStationExecutionSnapshot } from "../execution/RepairStationExecution";
import { RetreatExecutionSnapshot } from "../execution/RetreatExecution";
import { SAMLauncherExecutionSnapshot } from "../execution/SAMLauncherExecution";
import { SAMMissileExecutionSnapshot } from "../execution/SAMMissileExecution";
import { ShellExecutionSnapshot } from "../execution/ShellExecution";
import { SpawnExecutionSnapshot } from "../execution/SpawnExecution";
import { SpawnTimerExecutionSnapshot } from "../execution/SpawnTimerExecution";
import { TankExecutionSnapshot } from "../execution/TankExecution";
import { TargetPlayerExecutionSnapshot } from "../execution/TargetPlayerExecution";
import { TradeShipExecutionSnapshot } from "../execution/TradeShipExecution";
import { TrainExecutionSnapshot } from "../execution/TrainExecution";
import { TrainStationExecutionSnapshot } from "../execution/TrainStationExecution";
import { TransportShipExecutionSnapshot } from "../execution/TransportShipExecution";
import { TribeExecutionSnapshot } from "../execution/TribeExecution";
import { UnrestExecutionSnapshot } from "../execution/UnrestExecution";
import { UpgradeStructureExecutionSnapshot } from "../execution/UpgradeStructureExecution";
import { WarshipExecutionSnapshot } from "../execution/WarshipExecution";
import { WinCheckExecutionSnapshot } from "../execution/WinCheckExecution";
import type { ExecutionSnapshotType } from "./ExecutionSnapshot";

/**
 * Every execution class, by the type name its snapshots are stored under.
 * A class missing here cannot be snapshotted (snapshotGame throws), and a
 * stored type missing here cannot be restored. Retiring a class means
 * keeping an entry whose restoreSnapshot maps old records onto whatever
 * replaced it.
 */
export const EXECUTION_SNAPSHOT_TYPES = [
  AADefenseExecutionSnapshot,
  AircraftCarrierExecutionSnapshot,
  CapitalExecutionSnapshot,
  CapitalSystemExecutionSnapshot,
  CruiseMissileExecutionSnapshot,
  ParadropExecutionSnapshot,
  UnrestExecutionSnapshot,
  PoliticsExecutionSnapshot,
  ProposeDecreeExecutionSnapshot,
  CastVoteExecutionSnapshot,
  DraftExecutionSnapshot,
  DraftPickExecutionSnapshot,
  DraftResearchExecutionSnapshot,
  MineExecutionSnapshot,
  NuclearSubmarineExecutionSnapshot,
  SurfaceSubmarineExecutionSnapshot,
  RailDepotExecutionSnapshot,
  TankExecutionSnapshot,
  AAMissileExecutionSnapshot,
  AircraftExecutionSnapshot,
  AirfieldExecutionSnapshot,
  RepairStationExecutionSnapshot,
  HistoricalScenarioExecutionSnapshot,
  MissionExecutionSnapshot,
  AllianceExtensionExecutionSnapshot,
  AllianceRejectExecutionSnapshot,
  AllianceRequestExecutionSnapshot,
  AttackExecutionSnapshot,
  BoatRetreatExecutionSnapshot,
  BreakAllianceExecutionSnapshot,
  CityExecutionSnapshot,
  ConstructionExecutionSnapshot,
  DefensePostExecutionSnapshot,
  DeleteUnitExecutionSnapshot,
  DonateGoldExecutionSnapshot,
  DonateTroopsExecutionSnapshot,
  DoomsdayClockExecutionSnapshot,
  EmbargoAllExecutionSnapshot,
  EmbargoExecutionSnapshot,
  EmojiExecutionSnapshot,
  FactoryExecutionSnapshot,
  MarkDisconnectedExecutionSnapshot,
  MirvExecutionSnapshot,
  MissileSiloExecutionSnapshot,
  MoveWarshipExecutionSnapshot,
  NationExecutionSnapshot,
  NoOpExecutionSnapshot,
  NukeExecutionSnapshot,
  PauseExecutionSnapshot,
  PlayerExecutionSnapshot,
  PortExecutionSnapshot,
  QuickChatExecutionSnapshot,
  RecomputeRailClusterExecutionSnapshot,
  RetreatExecutionSnapshot,
  SAMLauncherExecutionSnapshot,
  SAMMissileExecutionSnapshot,
  ShellExecutionSnapshot,
  SpawnExecutionSnapshot,
  SpawnTimerExecutionSnapshot,
  TargetPlayerExecutionSnapshot,
  TradeShipExecutionSnapshot,
  TrainExecutionSnapshot,
  TrainStationExecutionSnapshot,
  TransportShipExecutionSnapshot,
  TribeExecutionSnapshot,
  UpgradeStructureExecutionSnapshot,
  WarshipExecutionSnapshot,
  WinCheckExecutionSnapshot,
] as unknown as readonly ExecutionSnapshotType<unknown>[];
