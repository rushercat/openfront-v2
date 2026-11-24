// Renderer types (units, players, tiles, names, config)
export {
  DEFAULT_NUKE_EXPLOSION_COLOR,
  MAX_NUKE_EXPLOSION_COLORS,
  PlayerTypeEnum,
  TrainType,
} from "./Renderer";
export type {
  AllianceData,
  AttackData,
  AttackRingInput,
  ConquestFx,
  DeadUnitFx,
  EmojiData,
  GhostPreviewData,
  NameEntry,
  NukeExplosionRenderParams,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RangeWarning,
  RendererConfig,
  TerrainRect,
  UnitState,
} from "./Renderer";

// Frame data — boundary contract between game integration and features
export type { FrameData } from "./FrameData";

// Frame events — per-frame ephemeral events (rendering FX)
export type { BonusEvent, FrameEvents } from "./FrameEvents";

// Unit type string constants and derived sets
export {
  AIRCRAFT_TYPES,
  ALL_UNIT_TYPES,
  HEADING_TYPES,
  HIDDEN_UNIT_TYPES,
  NUKE_MAGNITUDES,
  NUKE_TYPES,
  SMOOTHED_NUKE_TYPES,
  STRUCTURE_TYPES,
  TRAIL_TYPES,
  UT_AA_DEFENSE,
  UT_AIRFIELD,
  UT_ATOM_BOMB,
  UT_BOMBER,
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_FIGHTER_JET,
  UT_HYDROGEN_BOMB,
  UT_LAND_MINE,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_MISSILE_SILO,
  UT_NUCLEAR_SUBMARINE,
  UT_PORT,
  UT_RAIL_DEPOT,
  UT_REPAIR_STATION,
  UT_SAM_LAUNCHER,
  UT_SAM_MISSILE,
  UT_SEA_MINE,
  UT_SHELL,
  UT_TANK,
  UT_AIRCRAFT_CARRIER,
  UT_CRUISE_MISSILE,
  UT_TRANSPORT_PLANE,
  UT_CAPITAL,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
} from "./UnitType";
