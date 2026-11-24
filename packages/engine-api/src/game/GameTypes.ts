import { AllPlayersStats, ClientID } from "../Schemas";

import { TileRef } from "./GameMap";
import { GameUpdate, GameUpdateType } from "./GameUpdates";
import { GameMapType, maps, type MapInfo } from "./Maps.gen";

function isEnumValue<T extends Record<string, string | number>>(
  enumObj: T,
  value: unknown,
): value is T[keyof T] {
  return Object.values(enumObj).includes(value as T[keyof T]);
}

export type PlayerID = string;

export type Tick = number;

export type Gold = bigint;

export type WarshipState = {
  state: "patrolling" | "retreating" | "docked";
  patrolTile?: TileRef;
  retreatPort?: TileRef;
  isInCombat?: boolean;
  lastCombatTick: number;
  // Veterancy level (0–max) plus a shared integer progress meter fed by
  // transport kills and trade captures (see UnitImpl.addVeterancyProgress).
  veterancy: number;
  veterancyProgress: number;
};

export type TransportShipState = {
  isRetreating: boolean;
  troops: number;
};

export type NukeState = {
  trajectory?: TileRef[];
  trajectoryIndex?: number;
  targetedBySam: boolean;
  waitTicks: number;
};

export type SamLauncherState = {
  upgradeStartTick?: number;
  startRange: number;
  targetLevel: number;
  duration: number;
};

/**
 * A nuclear submarine is invisible to everyone but its owner while
 * submerged. Surfacing takes a while (surfacing, readyTick in the future);
 * once surfaced it may launch nukes until its payload is spent or its fire
 * window closes, then it dives again.
 */
export type SubmarineMode = "submerged" | "surfacing" | "surfaced";

export type SubmarineState = {
  mode: SubmarineMode;
  /** Tick the surfacing submarine can fire; meaningless while submerged. */
  readyTick: number;
  /** Payload points left this surfacing (see Config.nukePayloadCost). */
  payloadLeft: number;
};

export const AllPlayers = "AllPlayers" as const;

// export type GameUpdates = Record<GameUpdateType, GameUpdate[]>;
// Create a type that maps GameUpdateType to its corresponding update type
type UpdateTypeMap<T extends GameUpdateType> = Extract<GameUpdate, { type: T }>;

// Then use it to create the record type
export type GameUpdates = {
  [K in GameUpdateType]: UpdateTypeMap<K>[];
};

export interface MapPos {
  x: number;
  y: number;
}

export enum Difficulty {
  Easy = "Easy",
  Medium = "Medium",
  Hard = "Hard",
  Impossible = "Impossible",
}

export const isDifficulty = (value: unknown): value is Difficulty =>
  isEnumValue(Difficulty, value);

export type Team = string;

export interface SpawnArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TeamGameSpawnAreas = Record<string, SpawnArea[]>;

export const Duos = "Duos" as const;

export const Trios = "Trios" as const;

export const Quads = "Quads" as const;

export const HumansVsNations = "Humans Vs Nations" as const;

export const ColoredTeams: Record<string, Team> = {
  Red: "Red",
  Blue: "Blue",
  Teal: "Teal",
  Purple: "Purple",
  Yellow: "Yellow",
  Orange: "Orange",
  Green: "Green",
  Bot: "Bot",
  Humans: "Humans",
  Nations: "Nations",
} as const;

// GameMapType and the maps list are generated from
// map-generator/assets/maps/<map>/info.json by the map-generator
// (`npm run gen-maps`).
export {
  GameMapType,
  mapCategoryOrder,
  maps,
  type CustomTribe,
  type GameMapName,
  type MapCategory,
  type MapInfo,
  type SpecialModifierKey,
} from "./Maps.gen";

/**
 * The map of a game whose map files came with its start (a scenario's own
 * terrain) rather than from resources/maps. It is not a stock map: it is not
 * in `GameMapType` or `maps`, so nothing lists, picks or fetches it, and the
 * engine accepts any files for it. A snapshot still refuses to restore onto
 * files other than the ones it was taken on.
 */
export const CustomGameMap = "Custom" as const;

/**
 * Historical scenarios (openfront v2): a stock map with nations at their
 * historical positions, starting borders and fixed alliances. Their data is
 * in engine-lib/game/HistoricalScenarios.ts.
 */
export enum HistoricalScenarioId {
  Europe1939 = "europe1939",
  MareNostrum218 = "marenostrum218",
  Sengoku1560 = "sengoku1560",
  Italy1494 = "italy1494",
  Britannia800 = "britannia800",
  Africa1884 = "africa1884",
  ColdWar1962 = "coldwar1962",
}

/** A game's map: a stock map, or `CustomGameMap`. */
export type GameMapId = GameMapType | typeof CustomGameMap;

/**
 * The maps players can pick or be dealt: everything but `hidden` ones (the
 * tutorial map), which only code that names them starts.
 */
export const listedMaps: readonly MapInfo[] = maps.filter((m) => !m.hidden);

export enum GameType {
  Singleplayer = "Singleplayer",
  Public = "Public",
  Private = "Private",
}

export const isGameType = (value: unknown): value is GameType =>
  isEnumValue(GameType, value);

export enum GameMode {
  FFA = "Free For All",
  Team = "Team",
}

export enum RankedType {
  OneVOne = "1v1",
  TwoVTwo = "2v2",
  FreeForAll = "ffa",
  ClanWars = "clanwars",
}

export const isGameMode = (value: unknown): value is GameMode =>
  isEnumValue(GameMode, value);

export enum GameMapSize {
  Compact = "Compact",
  Normal = "Normal",
}

export interface PublicGameModifiers {
  isCompact?: boolean;
  isRandomSpawn?: boolean;
  isCrowded?: boolean;
  isHardNations?: boolean;
  startingGold?: number;
  goldMultiplier?: number;
  isAlliancesDisabled?: boolean;
  isPortsDisabled?: boolean;
  isNukesDisabled?: boolean;
  isSAMsDisabled?: boolean;
  isPeaceTime?: boolean;
  isWaterNukes?: boolean;
  isDoomsdayClock?: boolean;
}

// Largest bulk-purchase amount an intent may carry (mirrored by the intent
// schemas' max). Also the length of BuildableUnit.upgradeCosts.
export const MAX_UPGRADE_AMOUNT = 50;

export interface UnitInfo {
  maxHealth?: number;
  damage?: number;
  constructionDuration?: number;
  upgradable?: boolean;
}

function unitTypeGroup<T extends readonly UnitType[]>(types: T) {
  return {
    types,
    has(type: UnitType): type is T[number] {
      return (types as readonly UnitType[]).includes(type);
    },
  };
}

export enum UnitType {
  TransportShip = "Transport",
  Warship = "Warship",
  Shell = "Shell",
  SAMMissile = "SAMMissile",
  Port = "Port",
  AtomBomb = "Atom Bomb",
  HydrogenBomb = "Hydrogen Bomb",
  TradeShip = "Trade Ship",
  MissileSilo = "Missile Silo",
  DefensePost = "Defense Post",
  SAMLauncher = "SAM Launcher",
  City = "City",
  MIRV = "MIRV",
  MIRVWarhead = "MIRV Warhead",
  Train = "Train",
  Factory = "Factory",
  // Air warfare. An AA Defense shoots SAMMissile units at aircraft; aircraft
  // are built at an Airfield and fire Shell units (guns and bombs).
  AADefense = "AA Defense",
  Airfield = "Airfield",
  FighterJet = "Fighter Jet",
  Bomber = "Bomber",
  // A submarine that hides under water and surfaces to launch nukes.
  NuclearSubmarine = "Nuclear Submarine",
  // Tanks are built at a Rail Depot and ride its railway network.
  RailDepot = "Rail Depot",
  Tank = "Tank",
  LandMine = "Land Mine",
  SeaMine = "Sea Mine",
  // Mends damaged structures around it; nothing else repairs them.
  RepairStation = "Repair Station",
  // A mobile airfield at sea with its own AA guns and a small SAM.
  AircraftCarrier = "Aircraft Carrier",
  // A conventional missile from a silo that wears down structures.
  CruiseMissile = "Cruise Missile",
  // Carries paratroopers from an airfield or carrier behind the front.
  TransportPlane = "Transport Plane",
  // Every player's seat of government, placed near the spawn and movable.
  Capital = "Capital",
}

/**
 * Game mechanics a lobby can switch off (GameConfig.disabledFeatures), like
 * units through disabledUnits.
 */
export enum GameFeature {
  /** A capital near the spawn that boosts troops and gold. */
  Capital = "capital",
  /** Freshly conquered land yields less for a while. */
  Unrest = "unrest",
  /** Extreme unrest makes outlying land break away as a new nation. */
  Secession = "secession",
  /** The world congress: players propose and vote on decrees (Politics). */
  Politics = "politics",
}

export enum TrainType {
  Engine = "Engine",
  TailEngine = "TailEngine",
  Carriage = "Carriage",
}

export const Nukes = unitTypeGroup([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRVWarhead,
  UnitType.MIRV,
] as const);

export const BuildableAttacks = unitTypeGroup([
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.Warship,
  UnitType.FighterJet,
  UnitType.Bomber,
  UnitType.NuclearSubmarine,
  UnitType.Tank,
  UnitType.AircraftCarrier,
  UnitType.CruiseMissile,
  UnitType.TransportPlane,
] as const);

export const Structures = unitTypeGroup([
  UnitType.City,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
  UnitType.Port,
  UnitType.Factory,
  UnitType.AADefense,
  UnitType.Airfield,
  UnitType.RailDepot,
  UnitType.RepairStation,
  UnitType.Capital,
] as const);

/**
 * Mines: placed like structures but hidden from other players, never
 * upgraded and gone once they go off.
 */
export const Mines = unitTypeGroup([
  UnitType.LandMine,
  UnitType.SeaMine,
] as const);

/** Ships a sea mine goes off under (and sinks). */
export const MineableShips = unitTypeGroup([
  UnitType.TransportShip,
  UnitType.TradeShip,
  UnitType.Warship,
  UnitType.NuclearSubmarine,
  UnitType.AircraftCarrier,
] as const);

/** Planes: built at an Airfield, patrol like warships, shot by AA Defenses. */
export const Aircraft = unitTypeGroup([
  UnitType.FighterJet,
  UnitType.Bomber,
] as const);

/**
 * Units a player selects on the map and sends somewhere (move_warship
 * intent): they patrol around the tile they were sent to.
 */
export const PatrolUnits = unitTypeGroup([
  UnitType.Warship,
  ...Aircraft.types,
  UnitType.NuclearSubmarine,
  UnitType.Tank,
  UnitType.AircraftCarrier,
] as const);

/** What AA guns (AA Defenses, carriers) shoot at: aircraft and transport planes. */
export const AirTargets = unitTypeGroup([
  ...Aircraft.types,
  UnitType.TransportPlane,
] as const);

export const BuildMenus = unitTypeGroup([
  ...Structures.types,
  ...BuildableAttacks.types,
  ...Mines.types,
] as const);

export const PlayerBuildable = unitTypeGroup([
  ...BuildMenus.types,
  UnitType.TransportShip,
] as const);

export type PlayerBuildableUnitType = (typeof PlayerBuildable.types)[number];

export enum Relation {
  Hostile = 0,
  Distrustful = 1,
  Neutral = 2,
  Friendly = 3,
}

export class Nation {
  constructor(
    public readonly spawnCell: Cell | undefined,
    public readonly playerInfo: PlayerInfo,
  ) {}
}

export class Cell {
  public index: number;

  private strRepr: string;

  constructor(
    public readonly x: number,
    public readonly y: number,
  ) {
    this.strRepr = `Cell[${this.x},${this.y}]`;
  }

  pos(): MapPos {
    return {
      x: this.x,
      y: this.y,
    };
  }

  toString(): string {
    return this.strRepr;
  }
}

export enum TerrainType {
  Plains,
  Highland,
  Mountain,
  Ocean,
  Impassable,
}

export enum PlayerType {
  Bot = "BOT",
  Human = "HUMAN",
  Nation = "NATION",
}

export class PlayerInfo {
  public readonly displayName: string;

  constructor(
    public readonly name: string,
    public readonly playerType: PlayerType,
    // null if tribe.
    public readonly clientID: ClientID | null,
    // TODO: make player id the small id
    public readonly id: PlayerID,
    public readonly isLobbyCreator: boolean = false,
    public readonly clanTag: string | null = null,
    public readonly friends: ClientID[] = [],
    // Server-pinned team slot (index into the game's team list) for
    // matchmade team games; null = assign normally.
    public readonly teamIndex: number | null = null,
    // Manifest flag code (e.g. "in", "pk") for PlayerType.Nation players.
    // Carried from the map manifest through to the client so it can render
    // the correct flag even when multiple nations on a map share a display
    // name (e.g. India's and Pakistan's "Punjab").
    public readonly nationFlag: string | null = null,
  ) {
    this.displayName = formatPlayerDisplayName(this.name, this.clanTag);
  }
}

export interface TerraNullius {
  isPlayer(): false;
  id(): null;
  clientID(): ClientID;
  smallID(): number;
}

export interface PlayerActions {
  canAttack: boolean;
  buildableUnits: BuildableUnit[];
  canSendEmojiAllPlayers: boolean;
  canEmbargoAll?: boolean;
  interaction?: PlayerInteraction;
}

export interface BuildableUnit {
  canBuild: TileRef | false;
  // unit id of the existing unit that can be upgraded, or false if it cannot be upgraded.
  canUpgrade: number | false;
  type: PlayerBuildableUnitType;
  cost: Gold;
  // Cumulative cost of upgrading 1..MAX_UPGRADE_AMOUNT times (upgrade costs
  // escalate per level, so a bulk total is NOT cost * amount). Only set when
  // canUpgrade is not false.
  upgradeCosts?: Gold[];
  overlappingRailroads: TileRef[];
  ghostRailPaths: TileRef[][];
}

// Total price of buying `amount` of a buildable in one intent. Upgrades use
// the escalating totals from core; flat-cost units (nukes) scale linearly.
export function bulkCost(bu: BuildableUnit, amount: number): Gold {
  return bu.upgradeCosts?.[amount - 1] ?? bu.cost * BigInt(amount);
}

// Largest amount (up to MAX_UPGRADE_AMOUNT) whose bulk total fits in `gold`.
// 0 when not even a single purchase is affordable.
export function maxBulkAmount(bu: BuildableUnit, gold: Gold): number {
  let max = 0;
  for (let n = 1; n <= MAX_UPGRADE_AMOUNT; n++) {
    // Never price upgrades past the shipped totals — beyond the array,
    // bulkCost would silently fall back to linear pricing.
    if (bu.upgradeCosts !== undefined && n > bu.upgradeCosts.length) {
      break;
    }
    if (bulkCost(bu, n) > gold) {
      break;
    }
    max = n;
  }
  return max;
}

// Fixed mid-ladder steps for the bulk menus. Bombs come in smaller batches
// than structure upgrades — x2 is the standard play against a single SAM.
export const NUKE_BULK_STEPS: readonly number[] = [2, 5];

export const STRUCTURE_BULK_STEPS: readonly number[] = [5, 10];

export interface PlayerProfile {
  relations: Record<number, Relation>;
  alliances: number[];
}

export interface PlayerBorderTiles {
  borderTiles: ReadonlySet<TileRef>;
}

/**
 * The humans' stats as they stand right now, for the client's provisional XP
 * figure (src/client/ProvisionalXp.ts): the player's own XP is scored from
 * the same per-player stats the end-of-game record carries, and in FFA from
 * who went out before them. Built by the engine's humanStatsSnapshot().
 */
export interface HumanStatsSnapshot extends HumanDisconnects {
  // Every human's stats, keyed by clientID: the object the archived record
  // carries per player (players who never spawned have none).
  stats: AllPlayersStats;
}

/**
 * Just the snapshot's tick and who is disconnected, without the stats: what
 * the client needs at the end of the game, where it has the stats from the
 * Win update already. Built by the engine's humanDisconnects().
 */
export interface HumanDisconnects {
  // The tick the snapshot was taken at.
  tick: number;
  // Humans whose connection is currently marked lost: clientID -> the tick
  // it was. The API reads a player who never came back as having left then.
  disconnectedAt: Record<ClientID, number>;
}

export interface AllianceInfo {
  expiresAt: Tick;
  inExtensionWindow: boolean;
  myPlayerAgreedToExtend: boolean;
  otherAgreedToExtend: boolean;
  canExtend: boolean;
}

export interface PlayerInteraction {
  sharedBorder: boolean;
  canSendEmoji: boolean;
  canSendAllianceRequest: boolean;
  canBreakAlliance: boolean;
  canTarget: boolean;
  canDonateGold: boolean;
  canDonateTroops: boolean;
  canEmbargo: boolean;
  allianceInfo?: AllianceInfo;
}

export interface EmojiMessage {
  message: string;
  senderID: number;
  recipientID: number | typeof AllPlayers;
  createdAt: Tick;
}

export enum MessageType {
  ATTACK_FAILED,
  ATTACK_CANCELLED,
  ATTACK_REQUEST,
  CONQUERED_PLAYER,
  MIRV_INBOUND,
  NUKE_INBOUND,
  NUKE_DETONATED,
  HYDROGEN_BOMB_INBOUND,
  NAVAL_INVASION_INBOUND,
  SAM_MISS,
  SAM_HIT,
  CAPTURED_ENEMY_UNIT,
  UNIT_DESTROYED,
  ALLIANCE_ACCEPTED,
  ALLIANCE_REJECTED,
  ALLIANCE_REQUEST,
  ALLIANCE_BROKEN,
  ALLIANCE_EXPIRED,
  DONATION_SENT,
  DONATION_RECEIVED,
  CHAT,
  RENEW_ALLIANCE,
}

// Message categories used for filtering events in the EventsDisplay
export enum MessageCategory {
  ATTACK = "ATTACK",
  NUKE = "NUKE",
  ALLIANCE = "ALLIANCE",
  TRADE = "TRADE",
  CHAT = "CHAT",
}

// Ensures that all message types are included in a category
export const MESSAGE_TYPE_CATEGORIES: Record<MessageType, MessageCategory> = {
  [MessageType.ATTACK_FAILED]: MessageCategory.ATTACK,
  [MessageType.ATTACK_CANCELLED]: MessageCategory.ATTACK,
  [MessageType.ATTACK_REQUEST]: MessageCategory.ATTACK,
  [MessageType.CONQUERED_PLAYER]: MessageCategory.ATTACK,
  [MessageType.MIRV_INBOUND]: MessageCategory.NUKE,
  [MessageType.NUKE_INBOUND]: MessageCategory.NUKE,
  [MessageType.NUKE_DETONATED]: MessageCategory.NUKE,
  [MessageType.HYDROGEN_BOMB_INBOUND]: MessageCategory.NUKE,
  [MessageType.NAVAL_INVASION_INBOUND]: MessageCategory.ATTACK,
  [MessageType.SAM_MISS]: MessageCategory.ATTACK,
  [MessageType.SAM_HIT]: MessageCategory.ATTACK,
  [MessageType.CAPTURED_ENEMY_UNIT]: MessageCategory.ATTACK,
  [MessageType.UNIT_DESTROYED]: MessageCategory.ATTACK,
  [MessageType.ALLIANCE_ACCEPTED]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_REJECTED]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_REQUEST]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_BROKEN]: MessageCategory.ALLIANCE,
  [MessageType.ALLIANCE_EXPIRED]: MessageCategory.ALLIANCE,
  [MessageType.RENEW_ALLIANCE]: MessageCategory.ALLIANCE,
  [MessageType.DONATION_SENT]: MessageCategory.TRADE,
  [MessageType.DONATION_RECEIVED]: MessageCategory.TRADE,
  [MessageType.CHAT]: MessageCategory.CHAT,
} as const;

/**
 * Get the category of a message type
 */
export function getMessageCategory(messageType: MessageType): MessageCategory {
  return MESSAGE_TYPE_CATEGORIES[messageType];
}

export interface NameViewData {
  x: number;
  y: number;
  size: number;
}

export function formatPlayerDisplayName(
  username: string,
  clanTag?: string | null,
): string {
  return clanTag ? `[${clanTag}] ${username}` : username;
}
