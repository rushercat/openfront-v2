import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import {
  AllianceInfo,
  AllPlayers,
  BuildableUnit,
  Cell,
  Difficulty,
  EmojiMessage,
  GameUpdates,
  Gold,
  MessageType,
  Nation,
  NukeState,
  PlayerBuildableUnitType,
  PlayerID,
  PlayerInfo,
  PlayerProfile,
  PlayerType,
  Relation,
  SamLauncherState,
  SubmarineState,
  SpawnArea,
  Team,
  TerraNullius,
  Tick,
  TrainType,
  TransportShipState,
  UnitInfo,
  UnitType,
  WarshipState,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdate,
  PlayerUpdate,
  UnitUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import {
  DecreeType,
  PoliticsFactor,
} from "@openfront/engine-api/game/Politics";
import {
  GameLike,
  PlayerLike,
  ReadonlyTileSet,
  UnitLike,
  UnitPredicate,
} from "@openfront/engine-api/game/ReadViews";
import {
  AllPlayersStats,
  ClientID,
  GameID,
} from "@openfront/engine-api/Schemas";
import { MotionPlanRecord } from "@openfront/engine-lib/game/MotionPlans";
import type { EngineConfig } from "../configuration/EngineConfig";
import { AbstractGraph } from "../pathfinding/algorithms/AbstractGraph";
import { PathFinder } from "../pathfinding/types";
import type { ExecRecord, SnapshotWriter } from "../snapshot/SnapshotContext";
import { RailNetwork } from "./RailNetwork";
import { Stats } from "./Stats";

export interface OwnerComp {
  owner: Player;
}

export interface UnitParamsMap {
  [UnitType.TransportShip]: {
    troops?: number;
    targetTile?: TileRef;
  };

  [UnitType.Warship]: {
    patrolTile: TileRef;
  };

  [UnitType.Shell]: Record<string, never>;

  [UnitType.SAMMissile]: {
    targetUnit: Unit;
  };

  [UnitType.Port]: Record<string, never>;

  [UnitType.AtomBomb]: {
    targetTile?: number;
    trajectory: TileRef[];
  };

  [UnitType.HydrogenBomb]: {
    targetTile?: number;
    trajectory: TileRef[];
  };

  [UnitType.MIRV]: {
    targetTile?: number;
    targetPlayer?: Player | TerraNullius;
  };

  [UnitType.MIRVWarhead]: {
    targetTile?: number;
    trajectory: TileRef[];
  };

  [UnitType.TradeShip]: {
    targetUnit: Unit;
    lastSetSafeFromPirates?: number;
  };

  [UnitType.Train]: {
    trainType: TrainType;
    targetUnit?: Unit;
    loaded?: boolean;
  };

  [UnitType.Factory]: Record<string, never>;

  [UnitType.MissileSilo]: Record<string, never>;

  [UnitType.DefensePost]: Record<string, never>;

  [UnitType.SAMLauncher]: Record<string, never>;

  [UnitType.City]: Record<string, never>;

  [UnitType.AADefense]: Record<string, never>;

  [UnitType.Airfield]: Record<string, never>;

  // Aircraft patrol like warships, and keep their patrol tile in warshipState.
  [UnitType.FighterJet]: {
    patrolTile: TileRef;
  };

  [UnitType.Bomber]: {
    patrolTile: TileRef;
  };

  [UnitType.NuclearSubmarine]: {
    patrolTile: TileRef;
  };

  [UnitType.RailDepot]: Record<string, never>;

  [UnitType.RepairStation]: Record<string, never>;

  // Tanks are sent around like warships and keep their target in warshipState.
  [UnitType.Tank]: {
    patrolTile: TileRef;
  };

  [UnitType.LandMine]: Record<string, never>;

  [UnitType.SeaMine]: Record<string, never>;

  [UnitType.AircraftCarrier]: {
    patrolTile: TileRef;
  };

  // Flies straight to its target; trajectory makes it SAM-targetable.
  [UnitType.CruiseMissile]: {
    targetTile: TileRef;
    trajectory: TileRef[];
  };

  [UnitType.TransportPlane]: {
    targetTile: TileRef;
    troops: number;
  };

  [UnitType.Capital]: Record<string, never>;
}

// Type helper to get params type for a specific unit type
export type UnitParams<T extends UnitType> = UnitParamsMap[T];

export type AllUnitParams = UnitParamsMap[keyof UnitParamsMap];

export interface Execution {
  isActive(): boolean;
  activeDuringSpawnPhase(): boolean;
  init(mg: Game, ticks: number): void;
  tick(ticks: number): void;
  /**
   * Serializes this execution for a game snapshot (see
   * packages/engine/src/snapshot/README.md). Every class registers an
   * ExecutionSnapshotType in snapshot/ExecutionRegistry.ts.
   */
  snapshot(w: SnapshotWriter): ExecRecord;
  /**
   * Whether it keeps running while the world congress votes and the game is
   * frozen (Politics). Executions without it wait; ones created meanwhile
   * start once the vote is over.
   */
  activeDuringFreeze?(): boolean;
}

/**
 * The world congress and the decrees in force (GameFeature.Politics,
 * execution/PoliticsExecution). Rules elsewhere ask it what the decrees
 * change.
 */
export interface Politics {
  /** Whether the game is frozen for the vote during this (executed) tick. */
  isFrozenAt(tick: Tick): boolean;
  isDecreeActive(decree: DecreeType): boolean;
  /** Multiplier on a player's income or troop growth. */
  factor(player: Player, kind: PoliticsFactor): number;
  /** Multiplier on the price of a unit type. */
  costFactor(type: UnitType): number;
  /** Whether a decree forbids the player to build or launch this. */
  forbidsUnit(player: Player, type: UnitType): boolean;
  /** Whether a decree forbids attacker to attack target (ceasefire, …). */
  forbidsAttack(attacker: Player, target: Player): boolean;
  /** Multiplier on the attacker's troop losses against this defender. */
  attackLossFactor(attacker: Player, defender: Player | null): number;
  /** Multiplier on how fast attacks take land. */
  attackSpeedFactor(): number;
  /** Geneva convention: land around the owner's cities that can't be taken. */
  protectsTile(attacker: Player, tile: TileRef, range: number): boolean;
  /** An attack took a tile of previousOwner (bounty). */
  onConquer(attacker: Player, previousOwner: Player): void;
  tradeBlocked(a: Player, b: Player): boolean;
  allianceBlocked(a: Player, b: Player): boolean;
  /** Naval ban: warships only fire at landings on their owner's land. */
  navalDefenseOnly(): boolean;
}

/**
 * The draft mode (GameConfig.draft, execution/DraftExecution): which units a
 * player's deck unlocks and what its perks change. A freeze for the draft
 * rounds works like the congress vote's.
 */
export interface Draft {
  isFrozenAt(tick: Tick): boolean;
  /** Whether the player's deck lets them build or launch this. */
  allowsUnit(player: Player, type: UnitType): boolean;
  /** Multiplier on the price of a unit type for this player. */
  costFactor(player: Player, type: UnitType): number;
  /** Multiplier on a player's income or troop growth. */
  factor(player: Player, kind: PoliticsFactor): number;
  /** Multiplier on the attacker's troop losses against this defender. */
  attackLossFactor(attacker: Player, defender: Player | null): number;
}

export interface Attack {
  id(): string;
  retreating(): boolean;
  retreated(): boolean;
  orderRetreat(): void;
  executeRetreat(): void;
  target(): Player | TerraNullius;
  attacker(): Player;
  troops(): number;
  setTroops(troops: number): void;
  isActive(): boolean;
  delete(): void;
  // The tile the attack originated from, mostly used for boat attacks.
  sourceTile(): TileRef | null;
  addBorderTile(tile: TileRef): void;
  removeBorderTile(tile: TileRef): void;
  clearBorder(): void;
  borderSize(): number;
  // Target tiles this attack is about to fight over.
  borderTiles(): ReadonlySet<TileRef>;
  clusteredPositions(): TileRef[];
}

export interface AllianceRequest {
  accept(): void;
  reject(): void;
  requestor(): Player;
  recipient(): Player;
  createdAt(): Tick;
  status(): "pending" | "accepted" | "rejected";
}

export interface Alliance {
  requestor(): Player;
  recipient(): Player;
  createdAt(): Tick;
  expiresAt(): Tick;
  other(player: Player): Player;
}

export interface MutableAlliance extends Alliance {
  expire(): void;
  other(player: Player): Player;
  bothAgreedToExtend(): boolean;
  addExtensionRequest(player: Player): void;
  id(): number;
  extend(): void;
  onlyOneAgreedToExtend(): boolean;

  agreedToExtend(player: Player): boolean;
}

export function isUnit(unit: unknown): unit is Unit {
  return (
    unit &&
    typeof unit === "object" &&
    "isUnit" in unit &&
    typeof unit.isUnit === "function" &&
    unit.isUnit()
  );
}

export interface EngineUnitInfo extends UnitInfo {
  // extraUnits shifts the cost curve as if the player already had that many
  // additional units/levels — used to price the later steps of a bulk upgrade.
  cost: (game: Game, player: Player, extraUnits?: number) => Gold;
}

export interface Unit extends UnitLike {
  isUnit(): this is Unit;

  // Common properties.
  id(): number;
  type(): UnitType;
  owner(): Player;
  info(): EngineUnitInfo;
  isMarkedForDeletion(): boolean;
  markForDeletion(): void;
  isOverdueDeletion(): boolean;
  delete(displayMessage?: boolean, destroyer?: Player): void;
  tile(): TileRef;
  lastTile(): TileRef;
  move(tile: TileRef): void;
  isActive(): boolean;
  setOwner(owner: Player): void;
  touch(): void;
  hash(): number;
  toUpdate(): UnitUpdate;
  hasTrainStation(): boolean;
  setTrainStation(trainStation: boolean): void;
  wasDestroyedByEnemy(): boolean;
  destroyer(): Player | undefined;

  // Train
  trainType(): TrainType | undefined;
  isLoaded(): boolean | undefined;
  setLoaded(loaded: boolean): void;

  // Targeting
  setTargetTile(cell: TileRef | undefined): void;
  targetTile(): TileRef | undefined;
  targetPlayer(): Player | TerraNullius | undefined;
  setTrajectoryIndex(i: number): void;
  trajectoryIndex(): number;
  trajectory(): TileRef[];
  setTargetUnit(unit: Unit | undefined): void;
  targetUnit(): Unit | undefined;
  setTargetedBySAM(targeted: boolean): void;
  targetedBySAM(): boolean;
  setReachedTarget(): void;
  reachedTarget(): boolean;
  isTargetable(): boolean;
  setTargetable(targetable: boolean): void;

  // Health
  hasHealth(): boolean;
  warshipState(): WarshipState;
  updateWarshipState(update: Partial<WarshipState>): void;
  transportShipState(): TransportShipState;
  updateTransportShipState(update: Partial<TransportShipState>): void;
  nukeState(): NukeState;
  updateNukeState(update: Partial<NukeState>): void;

  health(): number;
  /**
   * Effective max health: a warship's veterancy bonus included, and a
   * structure's level (maxHealthAtLevel).
   */
  maxHealth(): number;
  modifyHealth(delta: number, attacker?: Player): void;

  // Warship veterancy
  /** Current veterancy level from warshipState (0 for non-warships). */
  veterancy(): number;
  /** Record this warship destroying an enemy unit (drives veterancy gain). */
  recordKill(targetType: UnitType): void;
  /** Record this warship capturing a trade ship (drives veterancy gain). */
  recordTradeCapture(): void;

  // Troops
  setTroops(troops: number): void;
  troops(): number;

  // --- UNIT SPECIFIC ---

  // SAMs & Missile Silos
  launch(): void;
  reloadMissile(): void;
  isInCooldown(): boolean;
  missileTimerQueue(): number[];
  samLauncherState(): SamLauncherState | undefined;

  // Nuclear submarines
  submarineState(): SubmarineState | undefined;
  updateSubmarineState(update: Partial<SubmarineState>): void;
  /** A submerged submarine: no one but its owner sees or targets it. */
  isSubmerged(): boolean;

  // Trade Ships
  setSafeFromPirates(): void; // Only for trade ships
  isSafeFromPirates(): boolean; // Only for trade ships

  // Construction phase on structures
  isUnderConstruction(): boolean;
  setUnderConstruction(underConstruction: boolean): void;

  // Upgradable Structures
  level(): number;
  increaseLevel(): void;
  decreaseLevel(destroyer?: Player): void;
  /**
   * Scenario editor: the structure as if built at this level, not upgraded
   * to it: loaded, and a SAM at its full range at once.
   */
  placeAtLevel(level: number): void;
}

export interface Embargo {
  createdAt: Tick;
  isTemporary: boolean;
  target: Player;
}

export interface DisconnectSnapshot {
  currentTick: number;
  teamTiles: number;
  totalLand: number;
  wasAlive: boolean;
}

export interface Player extends PlayerLike {
  // Basic Info
  smallID(): number;
  info(): PlayerInfo;
  setPlayerInfo(info: PlayerInfo): void;
  name(): string;
  displayName(): string;
  clanTag(): string | null;
  clientID(): ClientID | null;
  id(): PlayerID;
  type(): PlayerType;
  isPlayer(): this is Player;
  toString(): string;
  isLobbyCreator(): boolean;
  /** A scenario nation a human may be assigned (docs/ScenarioEditor.md). */
  playable(): boolean;
  setPlayable(playable: boolean): void;

  // State & Properties
  isAlive(): boolean;
  isTraitor(): boolean;
  markTraitor(): void;
  // Doomsday Clock (anti-stall): marked when below the rising territory bar.
  inDoomsdayClock(): boolean;
  /** Territory is actively rotting away (the final doomsday phase). */
  isDecaying(): boolean;
  markRotted(): void;
  doomsdayClockTicks(): number;
  enterDoomsdayClock(): void;
  clearDoomsdayClock(): void;
  largestClusterBoundingBox: { min: Cell; max: Cell } | null;
  lastTileChange(): Tick;
  /** Counter bumped on every ownership change of one of this player's tiles (also when its border set can change). */
  tileChangeVersion(): number;

  isDisconnected(): boolean;
  markDisconnected(
    isDisconnected: boolean,
    snapshot?: DisconnectSnapshot,
  ): void;
  disconnectSnapshot(): DisconnectSnapshot | null;
  disconnectedAtTick(): number | null;

  hasSpawned(): boolean;
  setSpawnTile(spawnTile: TileRef): void;
  spawnTile(): TileRef | undefined;
  /** openfront v2: recently conquered tiles, decaying (UnrestExecution). */
  unrest(): number;
  setUnrest(unrest: number): void;
  /** Unrest as a share of the player's land, 0 to 1. */
  unrestShare(): number;
  /** What the decrees in force do to this player's income/troop growth. */
  politicsFactor(kind: PoliticsFactor): number;
  /** Tick until which the player can't have a capital after losing one (-1 = never lost). */
  capitalLostUntil(): number;
  setCapitalLostUntil(tick: number): void;
  /** The player's finished capital, if it has one. */
  capital(): Unit | null;
  /** Finished airfields and aircraft carriers: where planes take off. */
  airBases(): Unit[];

  // Territory
  tiles(): ReadonlyTileSet;
  borderTiles(): ReadonlyTileSet;
  numTilesOwned(): number;
  conquer(tile: TileRef): void;
  relinquish(tile: TileRef): void;

  // Resources & Troops
  gold(): Gold;
  /** Sets gold outright, as starting gold is: not counted as income. */
  setGold(gold: Gold): void;
  addGold(toAdd: Gold, tile?: TileRef): void;
  removeGold(toRemove: Gold): Gold;

  // Cumulative trade revenue, surfaced on the live PlayerUpdate so clients can
  // compute per-source gold rates (leaderboard "Ship/Train Trade Gold/min").
  // Mirrors StatsSchemas GOLD_INDEX_TRADE / GOLD_INDEX_TRAIN_* semantics.
  tradeGold(): Gold;
  addTradeGold(toAdd: Gold): void;
  trainGold(): Gold;
  addTrainGold(toAdd: Gold): void;

  // Cumulative piracy revenue (captured trade ships; GOLD_INDEX_STEAL).
  piracyGold(): Gold;
  addPiracyGold(toAdd: Gold): void;

  // Cumulative gold received from ALL sources (workers, trade, trains,
  // piracy, conquest, donations). Incremented inside addGold(); surfaced on
  // the live PlayerUpdate for the leaderboard "Gold Income/min" column.
  goldEarned(): Gold;
  troops(): number;
  setTroops(troops: number): void;
  addTroops(troops: number): void;
  removeTroops(troops: number): number;

  // Units
  // Fixed-arity + array overloads instead of a rest parameter: the rest array
  // would be allocated on every call, and this is one of the hottest calls in
  // the simulation. With no arguments the player's live unit array is
  // returned — do not mutate it; typed queries return a fresh snapshot array.
  units(): Unit[];
  units(types: readonly UnitType[]): Unit[];
  units(type: UnitType, type2?: UnitType, type3?: UnitType): Unit[];
  unitCount(type: UnitType): number;
  unitsConstructed(type: UnitType): number;
  unitsOwned(type: UnitType): number;
  buildableUnits(
    tile: TileRef | null,
    units?: readonly PlayerBuildableUnitType[],
    includeBuildPreview?: boolean,
  ): BuildableUnit[];
  canBuild(
    type: UnitType,
    targetTile: TileRef,
    validTiles?: TileRef[] | null,
  ): TileRef | false;
  buildUnit<T extends UnitType>(
    type: T,
    spawnTile: TileRef,
    params: UnitParams<T>,
  ): Unit;

  // Returns the existing unit that can be upgraded,
  // or false if it cannot be upgraded.
  // New units of the same type can upgrade existing units.
  // e.g. if a place a new city here, can it upgrade an existing city?
  findUnitToUpgrade(type: UnitType, targetTile: TileRef): Unit | false;
  canUpgradeUnit(unit: Unit): boolean;
  upgradeUnit(unit: Unit): void;
  captureUnit(unit: Unit): void;

  // Relations & Diplomacy
  nearby(): (Player | TerraNullius)[];
  sharesBorderWith(other: Player | TerraNullius): boolean;
  relation(other: Player): Relation;
  allRelationsSorted(): { player: Player; relation: Relation }[];
  updateRelation(other: Player, delta: number): void;
  decayRelations(): void;
  isOnSameTeam(other: Player): boolean;
  // Either allied or on same team.
  isFriendly(other: Player, treatAFKFriendly?: boolean): boolean;
  team(): Team | null;
  incomingAllianceRequests(): AllianceRequest[];
  outgoingAllianceRequests(): AllianceRequest[];
  alliances(): MutableAlliance[];
  expiredAlliances(): Alliance[];
  allies(): Player[];
  isAlliedWith(other: Player): boolean;
  allianceWith(other: Player): MutableAlliance | null;
  allianceInfo(other: Player): AllianceInfo | null;
  canSendAllianceRequest(other: Player): boolean;
  breakAlliance(alliance: Alliance): void;
  removeAllAlliances(): void;
  createAllianceRequest(recipient: Player): AllianceRequest | null;
  betrayals(): number;

  // Targeting
  canTarget(other: Player): boolean;
  target(other: Player): void;
  targets(): Player[];
  transitiveTargets(): Player[];

  // Communication
  canSendEmoji(recipient: Player | typeof AllPlayers): boolean;
  outgoingEmojis(): EmojiMessage[];
  sendEmoji(recipient: Player | typeof AllPlayers, emoji: string): void;
  canSendQuickChat(recipient: Player): boolean;
  recordQuickChat(recipient: Player): void;

  // Donation
  canDonateGold(recipient: Player): boolean;
  canDonateTroops(recipient: Player): boolean;
  donateTroops(recipient: Player, troops: number): boolean;
  donateGold(recipient: Player, gold: Gold): boolean;
  canDeleteUnit(): boolean;
  recordDeleteUnit(): void;
  canEmbargoAll(): boolean;
  recordEmbargoAll(): void;

  // Embargo
  hasEmbargoAgainst(other: Player): boolean;
  // Excludes the temporary embargo every attacked player places on its attacker
  hasManualEmbargoAgainst(other: Player): boolean;
  tradingPartners(): Player[];
  addEmbargo(other: Player, isTemporary: boolean): void;
  getEmbargoes(): Embargo[];
  stopEmbargo(other: Player): void;
  endTemporaryEmbargo(other: Player): void;
  canTrade(other: Player): boolean;

  // Attacking.
  canAttack(tile: TileRef): boolean;
  canAttackPlayer(player: Player, treatAFKFriendly?: boolean): boolean;
  isImmune(): boolean;

  createAttack(
    target: Player | TerraNullius,
    troops: number,
    sourceTile: TileRef | null,
    border: Set<number>,
  ): Attack;
  outgoingAttacks(): Attack[];
  incomingAttacks(): Attack[];
  orderRetreat(attackID: string): void;
  executeRetreat(attackID: string): void;

  // Misc
  toUpdate(
    statsOut?: number[],
    attackTroopsOut?: number[],
  ): PlayerUpdate | null;
  playerProfile(): PlayerProfile;
  // WARNING: this operation is expensive.
  bestTransportShipSpawn(tile: TileRef): TileRef | false;
}

export interface Game extends GameLike {
  // Map & Dimensions
  isOnMap(cell: Cell): boolean;
  width(): number;
  height(): number;
  map(): GameMap;
  miniMap(): GameMap;
  forEachTile(fn: (tile: TileRef) => void): void;
  // Zero-allocation neighbor iteration (cardinal only), in the same N, S, W, E
  // order as neighbors().
  forEachNeighbor(tile: TileRef, callback: (neighbor: TileRef) => void): void;
  // Writes the cardinal neighbors of ref into out (same N, S, W, E order as
  // neighbors()) and returns the count. Reuse out across calls to avoid
  // allocation.
  neighbors4(ref: TileRef, out: TileRef[]): number;
  neighbors8(ref: TileRef, out: TileRef[]): number;
  // Zero-allocation neighbor iteration for performance-critical cluster calculation
  // Alternative to neighborsWithDiag() that returns arrays
  // Avoids creating intermediate arrays and uses a callback for better performance
  forEachNeighborWithDiag(
    tile: TileRef,
    callback: (neighbor: TileRef) => void,
  ): void;

  // Player Management
  player(id: PlayerID): Player;
  players(): Player[];
  allPlayers(): Player[];
  playerByClientID(id: ClientID): Player | null;
  playerBySmallID(id: number): Player | TerraNullius;
  hasPlayer(id: PlayerID): boolean;
  addPlayer(playerInfo: PlayerInfo): Player;
  terraNullius(): TerraNullius;
  owner(ref: TileRef): Player | TerraNullius;

  teams(): Team[];
  teamTilesOwned(team: Team): number;
  totalLandTiles(): number;
  teamSpawnArea(team: Team): SpawnArea | undefined;

  // Alliances
  expireAlliance(alliance: Alliance): void;

  // Immunity timer
  isSpawnImmunityActive(): boolean;
  isNationSpawnImmunityActive(): boolean;
  elapsedGameSeconds(): number;

  // Game State
  ticks(): Tick;
  inSpawnPhase(): boolean;
  endSpawnPhase(): void;
  queueViewResync(): void;
  executeNextTick(): GameUpdates;
  drainPendingUpdates(): GameUpdates;
  drainPackedTileUpdates(): Uint32Array;
  recordMotionPlan(record: MotionPlanRecord): void;
  drainPackedMotionPlans(): Uint32Array | null;
  drainPackedPlayerUpdates(): Float64Array | null;
  drainPackedAttackUpdates(): Float64Array | null;
  // null ends the game with no winner (a cancelled match, e.g. a ranked game
  // that didn't fill): the record is archived winnerless and never ranked.
  setWinner(
    winner: Player | Team | null,
    allPlayersStats: AllPlayersStats,
  ): void;
  getWinner(): Player | Team | null;
  config(): EngineConfig;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  /** The world congress, or null when politics is switched off. */
  politics(): Politics | null;
  setPolitics(politics: Politics | null): void;
  /** The draft, or null when the draft mode is off. */
  draft(): Draft | null;
  setDraft(draft: Draft | null): void;
  /** Whether the current tick is frozen for a congress vote. */
  isFrozen(): boolean;

  // Units
  unit(id: number): Unit | undefined;
  // See Player.units() for why this is not a rest parameter.
  units(): Unit[];
  units(types: readonly UnitType[]): Unit[];
  units(type: UnitType, type2?: UnitType, type3?: UnitType): Unit[];
  unitCount(type: UnitType): number;
  unitInfo(type: UnitType): EngineUnitInfo;
  hasUnitNearby(
    tile: TileRef,
    searchRange: number,
    type: UnitType,
    playerId?: PlayerID,
    includeUnderConstruction?: boolean,
  ): boolean;
  anyUnitNearby(
    tile: TileRef,
    searchRange: number,
    types: readonly UnitType[],
    predicate: (unit: Unit) => boolean,
    playerId?: PlayerID,
    includeUnderConstruction?: boolean,
  ): boolean;
  nearbyUnits(
    tile: TileRef,
    searchRange: number,
    types: UnitType | readonly UnitType[],
    predicate?: UnitPredicate,
    includeUnderConstruction?: boolean,
  ): Array<{ unit: Unit; distSquared: number }>;
  /** nearbyUnits() as a visit, in the same order, without the result array. */
  forEachNearbyUnit(
    tile: TileRef,
    searchRange: number,
    types: readonly UnitType[],
    visit: (unit: Unit, distSquared: number) => void,
    includeUnderConstruction?: boolean,
  ): void;

  addExecution(...exec: Execution[]): void;
  executions(): Execution[];
  removeExecution(exec: Execution): void;
  takeoverPlayer(player: Player | PlayerID, localClientID: ClientID): void;
  convertHumanToNation(player: Player | PlayerID, gameID: GameID): Execution;
  clearHumanPlayer(player: Player | PlayerID): void;
  clearOtherHumans(keptPlayer: Player | PlayerID): void;
  applySingleplayerConfig(difficulty?: Difficulty): void;
  displayMessage(
    message: string,
    type: MessageType,
    playerID: PlayerID | null,
    goldAmount?: bigint,
    params?: Record<string, string | number>,
    unitID?: number,
    focusPlayerID?: PlayerID,
  ): void;
  displayIncomingUnit(
    unitID: number,
    message: string,
    type: MessageType,
    playerID: PlayerID | null,
  ): void;

  displayChat(
    message: string,
    category: string,
    target: PlayerID | undefined,
    playerID: PlayerID | null,
    isFrom: boolean,
    recipient: string,
  ): void;

  // Nations
  nations(): Nation[];
  // Scenario editor (docs/ScenarioEditor.md)
  addNation(info: PlayerInfo): Player;
  removeNation(nation: Player): void;
  restoreNation(info: PlayerInfo): void;
  setNationInfo(nation: Player, info: PlayerInfo): void;
  /**
   * Writes the authored terrain of the tiles and repairs the terrain around
   * them, except what waits for endTerrainEdit() (WaterManager.editTerrain).
   */
  setTerrain(tiles: readonly TileRef[], terrain: readonly number[]): void;
  /** Redoes the ocean bit and the depth of water with no coast. */
  endTerrainEdit(): void;
  /** The map16x the map generator would make from the minimap. */
  downscaleMiniMap(): GameMap;
  /**
   * Relabels the water components and rebuilds the water graph after
   * terrain edits. The scenario editor runs it before test play.
   */
  rebuildWaterGraph(): void;

  numTilesWithFallout(): number;
  stats(): Stats;

  addUpdate(update: GameUpdate): void;
  railNetwork(): RailNetwork;
  /**
   * Bumped whenever a City, Port or Factory is added or removed (the
   * structures the rail network connects) and whenever land turns to water
   * (rail paths route around it), so rail previews can be memoised while
   * other units churn.
   */
  structureVersion(): number;
  /** MIRVs launched so far by anyone; each one raises the next one's price. */
  mirvsLaunched(): number;
  recordMirvLaunch(): void;
  /**
   * Round-robin counter per ship kind, used to spread the ships' water
   * pathfinder rebuilds over WaterPathFinder.STAGGER_SPREAD ticks.
   */
  nextShipStagger(kind: "tradeShip" | "transportShip"): number;
  /** Tick each player was last hit by a nation MIRV, shared by all nations. */
  nationMirvTargets(): Map<PlayerID, Tick>;
  conquerPlayer(conqueror: Player, conquered: Player): void;
  miniWaterHPA(): PathFinder<number> | null;
  miniWaterGraph(): AbstractGraph | null;
  getWaterComponent(tile: TileRef): number | null;
  hasWaterComponent(tile: TileRef, component: number): boolean;
  /**
   * Returns the approximate number of water tiles in the component
   * containing `tile`, or null if the tile has no water component. Useful for
   * filtering tiny water bodies (e.g. preventing AI port placement on ponds).
   */
  getWaterComponentSize(tile: TileRef): number | null;
  /**
   * Returns the set of water components that `player` shares with at least one
   * valid trade partner (cached). Used by nation AI for port-placement
   * heuristics. `null` means no usable water body for ports.
   */
  sharedWaterComponents(player: Player): Set<number> | null;
  /** Incremented each time the water navigation graph is rebuilt (e.g. after nuke terrain change). */
  waterGraphVersion(): number;

  /** Queue a land tile for conversion to water (batched every few ticks). Tile must be unowned. */
  queueWaterConversion(tile: TileRef): void;

  /** Queue a tile that was inside a nuke blast radius (for nukeable layer destruction). */
  queueNukeImpact(tile: TileRef): void;

  /** Drain all tiles from nuke impacts this tick. Called once per tick. */
  drainNukeImpacts(): TileRef[];
}
