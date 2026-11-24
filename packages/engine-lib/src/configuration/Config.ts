import {
  Difficulty,
  GameFeature,
  GameType,
  PlayerType,
  Tick,
  UnitInfo,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PoliticsFactor } from "@openfront/engine-api/game/Politics";
import { PlayerLike } from "@openfront/engine-api/game/ReadViews";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { pow } from "../DetMath";
import { DoomsdayClockSpeed } from "../game/DoomsdayClock";
import {
  STRUCTURE_BASE_HEALTH,
  structureHealthFraction,
} from "../game/UnitHealth";
import { assertNever } from "../Util";

export interface NukeMagnitude {
  inner: number;
  outer: number;
}

const DEFAULT_SPAWN_IMMUNITY_TICKS = 5 * 10;

/** SAM launcher construction duration in ticks (non-instant-build). */
export const SAM_CONSTRUCTION_TICKS = 30 * 10;

// Doomsday Clock tunables (anti-stall). Off unless enabled in GameConfig.
// Times in seconds. The required map share rises in waves (levels + times in
// DoomsdayClock.ts, chosen by `speed`). A side caught below the bar gets a
// warnSeconds cooldown ("Danger, decay in Xs"), then troops bleed DOWN TO A
// FLOOR (drainFloorPercent of max), not to zero: the warn (30s) + the linear
// drain (~90s from full troops, sooner with fewer troops or a shrinking
// territory) make ~2 minutes from caught to the floor. A doomed side is crippled
// to 5% of max, not eliminated, so a brief dip below the bar is recoverable (the
// drain stops the moment it climbs back); the rising bar still guarantees a
// finish by squeezing territory and leaving the doomed side easy to conquer.
const DOOMSDAY_CLOCK_DEFAULTS = {
  enabled: false,
  speed: "normal" as DoomsdayClockSpeed,
  warnSeconds: 30, // cooldown (the flashing danger cue) before decay begins
  drainStartPercent: 2, // starts bleeding at once (already beats troop income)
  drainMaxPercent: 5,
  drainRampSeconds: 90, // ramps LINEARLY to the max over this long
  drainFloorPercent: 5, // drain settles here: crippled to 5% of max, never wiped
  // The floor decays start -> drainFloorPercent over floorDecaySeconds, leaving
  // one comeback window with a usable army. It must not be permanent: maxTroops is
  // sublinear (~100k at one tile), so a fixed 40% is ~40k troops on a single tile.
  floorStartPercent: 40,
  floorDecaySeconds: 90,
  // TERRITORY ROT — the finisher, since the drain never kills. rotDeathSeconds is
  // a DEADLINE, not a rate: the territory is gone this long after the skull
  // appeared, whatever it holds. 0 disables rot. Timeline:
  //
  //   0s    skull blinks, warn countdown
  //   30s   skull steady, troops draining              (warnSeconds)
  //   120s  floor at 5%, territory rotting, skull RED  (warn + floorDecay)
  //   150s  nothing left, eliminated                   (rotDeathSeconds)
  rotDeathSeconds: 150,
  // Grainy opening: pinholes across this share of the territory before the holes
  // grow together. Held to a third of the rot window, so shortening the window
  // shortens this too: at 20s the speckle WAS the death rather than its opening.
  rotGrainSeconds: 10,
  rotSpecklePercent: 15,
  // Warships bleed on their OWN gentler start + a STEEP (convex) ramp to a much
  // higher ceiling. A ship caught when its side is first doomed lasts about as
  // long as troops (the low start + no income ≈ the troop net rate), but the rate
  // curves up sharply (warshipDrainCurveExponent), so once a side has been under
  // the clock the full ramp, ships drop to the same floor in ~2s (50%/s), not
  // sunk. Ships only.
  warshipDrainStartPercent: 1,
  warshipDrainMaxPercent: 50,
  warshipDrainCurveExponent: 8, // >1 = convex: stays gentle early, then spikes
};

// Share of the land a side must hold to win, in every game mode.
const PERCENT_TILES_OWNED_TO_WIN = 80;

// Overtime tunables (anti-stalemate). Off unless enabled in GameConfig.
// After startMinutes the percentage of tiles required to win falls from the
// base by dropPercentPerMinute, with no floor: the bar keeps sinking until the
// leading side crosses it, so a stalled game always ends. Only `enabled` and
// `startMinutes` are wire-configurable.
const OVERTIME_DEFAULTS = {
  enabled: false,
  startMinutes: 30,
  dropPercentPerMinute: 2,
};

export class Config {
  private unitInfoCache = new Map<UnitType, UnitInfo>();
  constructor(
    protected _gameConfig: GameConfig,
    private _isReplay: boolean,
    public readonly listed: boolean = false,
    private _spectator: boolean = false,
  ) {}

  isReplay(): boolean {
    return this._isReplay;
  }

  /** True when the player joined the lobby as a spectator (watch-only). */
  isIntentionalSpectator(): boolean {
    return this._spectator;
  }

  traitorDefenseDebuff(): number {
    return 0.5;
  }
  traitorDuration(): number {
    return 30 * 10; // 30 seconds
  }

  // Doomsday Clock config, resolved against defaults. One read per tick.
  doomsdayClockConfig(): typeof DOOMSDAY_CLOCK_DEFAULTS {
    const c = this._gameConfig.doomsdayClock;
    const d = DOOMSDAY_CLOCK_DEFAULTS;
    return {
      enabled: c?.enabled ?? d.enabled,
      speed: c?.speed ?? d.speed,
      // Drain/warn tuning is internal (not wire-configurable): always defaults.
      warnSeconds: d.warnSeconds,
      drainStartPercent: d.drainStartPercent,
      drainMaxPercent: d.drainMaxPercent,
      drainRampSeconds: d.drainRampSeconds,
      drainFloorPercent: d.drainFloorPercent,
      floorStartPercent: d.floorStartPercent,
      floorDecaySeconds: d.floorDecaySeconds,
      rotDeathSeconds: d.rotDeathSeconds,
      rotGrainSeconds: d.rotGrainSeconds,
      rotSpecklePercent: d.rotSpecklePercent,
      warshipDrainStartPercent: d.warshipDrainStartPercent,
      warshipDrainMaxPercent: d.warshipDrainMaxPercent,
      warshipDrainCurveExponent: d.warshipDrainCurveExponent,
    };
  }
  // Overtime config, resolved against defaults.
  overtimeConfig(): typeof OVERTIME_DEFAULTS {
    const c = this._gameConfig.overtime;
    const d = OVERTIME_DEFAULTS;
    return {
      enabled: c?.enabled ?? d.enabled,
      startMinutes: c?.startMinutes ?? d.startMinutes,
      // The drop rate is internal (not wire-configurable): always the default.
      dropPercentPerMinute: d.dropPercentPerMinute,
    };
  }
  spawnImmunityDuration(): Tick {
    return (
      this._gameConfig.spawnImmunityDuration ?? DEFAULT_SPAWN_IMMUNITY_TICKS
    );
  }
  nationSpawnImmunityDuration(): Tick {
    return DEFAULT_SPAWN_IMMUNITY_TICKS;
  }
  hasExtendedSpawnImmunity(): boolean {
    return this.spawnImmunityDuration() > DEFAULT_SPAWN_IMMUNITY_TICKS;
  }

  gameConfig(): GameConfig {
    return this._gameConfig;
  }

  cityTroopIncrease(): number {
    return 250_000;
  }
  msPerTick(): number {
    return 100;
  }
  SAMCooldown(): number {
    return 90;
  }
  SiloCooldown(): number {
    return 90;
  }

  defensePostRange(): number {
    return 30;
  }

  isUnitDisabled(unitType: UnitType): boolean {
    // Capitals come and go with their mechanic.
    if (
      unitType === UnitType.Capital &&
      this.isFeatureDisabled(GameFeature.Capital)
    ) {
      return true;
    }
    return this._gameConfig.disabledUnits?.includes(unitType) ?? false;
  }
  /** Whether the lobby switched this mechanic off (GameConfig.disabledFeatures). */
  isFeatureDisabled(feature: GameFeature): boolean {
    // The onboarding tutorial keeps to the classic game.
    if (this._gameConfig.tutorial === true) return true;
    return this._gameConfig.disabledFeatures?.includes(feature) ?? false;
  }

  // World congress (GameFeature.Politics, engine-api game/Politics).
  /** Ticks after the spawn phase before the first congress round. */
  politicsFirstRoundTicks(): Tick {
    // openfront v2: 8 minutes (was 5).
    return 4800;
  }
  /** Ticks between the end of one round and the start of the next. */
  politicsIntervalTicks(): Tick {
    // openfront v2: 7 minutes (was 4), so the congress interrupts less.
    return 4200;
  }
  /** How long players have to put a decree forward (the game runs on). */
  politicsProposalTicks(): Tick {
    return 200;
  }
  /** How long the vote lasts at most (the game is frozen meanwhile). */
  politicsVotingTicks(): Tick {
    return 200;
  }
  /** Decrees in force at the same time. */
  politicsMaxActive(): number {
    return 2;
  }
  /** Proposals per round (first come, first served). */
  politicsMaxProposals(): number {
    return 4;
  }
  /** A proposal costs this share of the proposer's gold. */
  politicsProposalCostPercent(): number {
    return 25;
  }
  /** A veto costs this share of the vetoing player's gold. */
  politicsVetoCostPercent(): number {
    return 35;
  }
  /** How much gold counts next to land: weight += this × √(gold / 1000). */
  politicsGoldWeight(): number {
    return 0.25;
  }
  /** Share of the total weight that has to vote yes or no. */
  politicsQuorum(): number {
    return 0.3;
  }
  /** Voting weight of a player: √tiles + a little gold, halved for traitors. */
  politicsVoteWeight(player: PlayerLike, isTraitor: boolean): number {
    const tiles = player.numTilesOwned();
    const gold = Number(player.gold());
    let weight =
      Math.sqrt(Math.max(0, tiles)) +
      this.politicsGoldWeight() * Math.sqrt(Math.max(0, gold) / 1000);
    if (isTraitor) weight /= 2;
    return Math.round(weight * 100) / 100;
  }
  instantBuild(): boolean {
    return this._gameConfig.instantBuild;
  }
  disableAlliances(): boolean {
    // customAllianceDuration === 0 disables alliances (the "custom alliances"
    // control at 0). The legacy boolean is still honored for older configs.
    return (
      this._gameConfig.customAllianceDuration === 0 ||
      (this._gameConfig.disableAlliances ?? false)
    );
  }
  isRandomSpawn(): boolean {
    return this._gameConfig.randomSpawn;
  }
  infiniteTroops(): boolean {
    return this._gameConfig.infiniteTroops;
  }
  donateTroops(): boolean {
    return this._gameConfig.donateTroops;
  }
  trainStationMaxRange(): number {
    return 110;
  }

  unitInfo(type: UnitType): UnitInfo {
    const cached = this.unitInfoCache.get(type);
    if (cached !== undefined) {
      return cached;
    }

    let info: UnitInfo;
    switch (type) {
      case UnitType.Warship:
        info = { maxHealth: 1000 };
        break;
      case UnitType.FighterJet:
        info = { maxHealth: 200 };
        break;
      case UnitType.Bomber:
        info = { maxHealth: 400 };
        break;
      case UnitType.NuclearSubmarine:
        info = { maxHealth: 800 };
        break;
      case UnitType.Tank:
        info = { maxHealth: 400 };
        break;
      case UnitType.AircraftCarrier:
        info = { maxHealth: 1500 };
        break;
      case UnitType.TransportPlane:
        info = { maxHealth: 160 };
        break;
      // A capital set up at the spawn (or after one was lost) stands at
      // once; moving it takes a while.
      case UnitType.Capital:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.Capital],
          constructionDuration: this.instantBuild() ? 0 : 30 * 10,
        };
        break;
      case UnitType.Shell:
        info = { damage: 250 };
        break;
      // Structures have health too: aircraft wear them down, a nuke still
      // destroys them outright. maxHealth is the level 1 value; an upgraded
      // structure has more (maxHealthAtLevel).
      case UnitType.Port:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.Port],
          constructionDuration: this.instantBuild() ? 0 : 5 * 10,
          upgradable: true,
        };
        break;
      case UnitType.MissileSilo:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.MissileSilo],
          constructionDuration: this.instantBuild() ? 0 : 10 * 10,
          upgradable: true,
        };
        break;
      case UnitType.DefensePost:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.DefensePost],
          constructionDuration: this.instantBuild() ? 0 : 5 * 10,
        };
        break;
      case UnitType.SAMLauncher:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.SAMLauncher],
          constructionDuration: this.instantBuild()
            ? 0
            : SAM_CONSTRUCTION_TICKS,
          upgradable: true,
        };
        break;
      case UnitType.City:
      case UnitType.Factory:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[type],
          constructionDuration: this.instantBuild() ? 0 : 2 * 10,
          upgradable: true,
        };
        break;
      case UnitType.AADefense:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.AADefense],
          constructionDuration: this.instantBuild() ? 0 : 10 * 10,
          upgradable: true,
        };
        break;
      case UnitType.Airfield:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.Airfield],
          constructionDuration: this.instantBuild() ? 0 : 10 * 10,
          upgradable: true,
        };
        break;
      case UnitType.RepairStation:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.RepairStation],
          constructionDuration: this.instantBuild() ? 0 : 5 * 10,
          upgradable: true,
        };
        break;
      case UnitType.RailDepot:
        info = {
          maxHealth: STRUCTURE_BASE_HEALTH[UnitType.RailDepot],
          constructionDuration: this.instantBuild() ? 0 : 10 * 10,
          upgradable: true,
        };
        break;
      // Mines have no health: anything that reaches one sets it off.
      case UnitType.LandMine:
      case UnitType.SeaMine:
      case UnitType.TransportShip:
      case UnitType.SAMMissile:
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.MIRV:
      case UnitType.MIRVWarhead:
      case UnitType.TradeShip:
      case UnitType.Train:
      case UnitType.CruiseMissile:
        info = {};
        break;
      default:
        assertNever(type);
    }

    this.unitInfoCache.set(type, info);
    return info;
  }

  private hasInfiniteTroopsFor(player: PlayerLike): boolean {
    if (this.infiniteTroops()) return true;
    return (
      (this._gameConfig.hostCheats?.infiniteTroops ?? false) &&
      player.isLobbyCreator()
    );
  }
  deletionMarkDuration(): Tick {
    return 30 * 10;
  }

  deleteUnitCooldown(): Tick {
    return 30 * 10;
  }
  allianceRequestDuration(): Tick {
    return 20 * 10;
  }
  allianceDuration(): Tick {
    // Host can set a custom alliance duration in minutes (1-15); 0 disables
    // alliances (see disableAlliances). Falls back to the 5 minute default.
    const m = this._gameConfig.customAllianceDuration;
    if (typeof m === "number" && m > 0) return m * 60 * 10;
    return 300 * 10; // 5 minutes.
  }

  // The win bar in tenths of a percent (800 = 80.0%). Integer math, so the
  // sim's check is exact; a host can set the base to any tenth (see
  // GameConfig.winThresholdTenths).
  percentageTilesOwnedToWinTenths(elapsedGameSeconds: number): number {
    const base =
      this._gameConfig.winThresholdTenths ?? PERCENT_TILES_OWNED_TO_WIN * 10;
    const sd = this.overtimeConfig();
    if (!sd.enabled) {
      return base;
    }
    // Whole seconds only: elapsedGameSeconds is ticks/10 and can carry a
    // fractional part. The bar moves in WHOLE percentage points (one step
    // every 60/dropPercentPerMinute seconds), so the HUD shows exactly the
    // integer the sim checks — and integer math is trivially deterministic.
    const secondsPastStart =
      Math.floor(elapsedGameSeconds) - sd.startMinutes * 60;
    if (secondsPastStart <= 0) {
      return base;
    }
    return Math.max(
      0,
      base - Math.floor((secondsPastStart * sd.dropPercentPerMinute) / 60) * 10,
    );
  }

  // The same bar as a percentage, for display (80, or 75.5 for a custom one).
  percentageTilesOwnedToWin(elapsedGameSeconds: number): number {
    return this.percentageTilesOwnedToWinTenths(elapsedGameSeconds) / 10;
  }
  armyLimitWarningThreshold(): number {
    return 0.8;
  }
  numSpawnPhaseTurns(): number {
    if (this._gameConfig.gameType === GameType.Singleplayer) {
      return 100;
    }
    if (this.isRandomSpawn()) {
      return 150;
    }
    return 200;
  }

  maxTroops(player: PlayerLike): number {
    return this.troopCap(player, true);
  }

  /** maxTroops without what cities add */
  maxTroopsWithoutCities(player: PlayerLike): number {
    return this.troopCap(player, false);
  }

  private troopCap(player: PlayerLike, withCities: boolean): number {
    // A damaged city holds troops in proportion to its health.
    const cityTroops = withCities
      ? player
          .units(UnitType.City)
          .filter((u) => !u.isUnderConstruction())
          .map((city) => city.level() * structureHealthFraction(city))
          .reduce((a, b) => a + b, 0) * this.cityTroopIncrease()
      : 0;
    const maxTroops =
      player.type() === PlayerType.Human && this.hasInfiniteTroopsFor(player)
        ? 1_000_000_000
        : 2 * (pow(player.numTilesOwned(), 0.6) * 1000 + 50000) + cityTroops;

    // The tutorial's nation and tribe never spend troops on attacks: at their
    // usual cap they'd bank more than a new player could beat.
    if (this._gameConfig.tutorial && player.type() !== PlayerType.Human) {
      return maxTroops * 0.1;
    }

    if (player.type() === PlayerType.Bot) {
      return maxTroops / 3;
    }

    if (player.type() === PlayerType.Human) {
      return maxTroops;
    }

    switch (this._gameConfig.difficulty) {
      case Difficulty.Easy:
        return maxTroops * 0.5;
      case Difficulty.Medium:
        return maxTroops * 0.75;
      case Difficulty.Hard:
        return maxTroops * 1; // Like humans
      case Difficulty.Impossible:
        return maxTroops * 1.25;
      default:
        assertNever(this._gameConfig.difficulty);
    }
  }

  /**
   * Troop regeneration multiplier for a player whose cities are damaged:
   * 1 with every city intact, down to 0.5 with all of them at 0 health,
   * weighted by city level (a damaged level 5 city counts five times).
   */
  damagedCityRegenFactor(player: PlayerLike): number {
    let levels = 0;
    let lost = 0;
    for (const city of player.units(UnitType.City)) {
      if (city.isUnderConstruction()) continue;
      const level = city.level();
      levels += level;
      lost += level * (1 - structureHealthFraction(city));
    }
    if (levels === 0 || lost <= 0) return 1;
    return 1 - 0.5 * (lost / levels);
  }

  /** Whether the player has a finished capital standing. */
  hasCapital(player: PlayerLike): boolean {
    for (const capital of player.units(UnitType.Capital)) {
      if (capital.isActive() && !capital.isUnderConstruction()) return true;
    }
    return false;
  }

  /**
   * Income multiplier from the capital (+bonusPercent while one stands) and
   * from unrest (down to 1 − unrestMaxPenalty when all land is fresh).
   */
  capitalUnrestFactor(player: PlayerLike, bonusPercent: number): number {
    let factor = 1;
    if (this.hasCapital(player)) factor += bonusPercent / 100;
    const share = player.unrestShare?.() ?? 0;
    if (share > 0) factor *= 1 - this.unrestMaxPenalty() * share;
    return factor;
  }

  troopIncreaseRate(player: PlayerLike): number {
    const max = this.maxTroops(player);

    let toAdd = 10 + pow(player.troops(), 0.73) / 4;

    const ratio = 1 - player.troops() / max;
    toAdd *= ratio;

    // Damaged cities slow the regeneration down (see damagedCityRegenFactor).
    toAdd *= this.damagedCityRegenFactor(player);

    // A capital speeds it up, unrest in freshly conquered land slows it down.
    toAdd *= this.capitalUnrestFactor(player, this.capitalTroopBonusPercent());

    // Decrees of the world congress (pandemic, Marshall plan, …).
    toAdd *= player.politicsFactor?.(PoliticsFactor.TroopGrowth) ?? 1;

    if (player.type() === PlayerType.Bot) {
      toAdd *= 0.5;
    }

    if (player.type() === PlayerType.Nation) {
      switch (this._gameConfig.difficulty) {
        case Difficulty.Easy:
          toAdd *= 0.9;
          break;
        case Difficulty.Medium:
          toAdd *= 0.95;
          break;
        case Difficulty.Hard:
          toAdd *= 1; // Like humans
          break;
        case Difficulty.Impossible:
          toAdd *= 1.05;
          break;
        default:
          assertNever(this._gameConfig.difficulty);
      }
    }

    return Math.min(player.troops() + toAdd, max) - player.troops();
  }

  nukeMagnitudes(unitType: UnitType): NukeMagnitude {
    switch (unitType) {
      case UnitType.MIRVWarhead:
        return { inner: 12, outer: 18 };
      case UnitType.AtomBomb:
        // The onboarding tutorial's nukes hurt without wiping out a new
        // player's small territory.
        if (this._gameConfig.tutorial) return { inner: 8, outer: 16 };
        return { inner: 12, outer: 30 };
      case UnitType.HydrogenBomb:
        return { inner: 80, outer: 100 };
    }
    throw new Error(`Unknown nuke type: ${unitType}`);
  }

  nukeAllianceBreakThreshold(): number {
    return 100;
  }

  samRange(level: number): number {
    // rational growth function (level 1 = 70, level 5 just above hydro range, asymptotically approaches 150)
    return this.maxSamRange() - 480 / (level + 5);
  }

  maxSamRange(): number {
    return 150;
  }

  /**
   * Healing radius of a Repair Station at `level` (levels are stacked
   * stations). Level 1 is a fresh SAM's radius minus 10% (63); each stack
   * widens it only a little, far less than a SAM's (66, 69, 70, 72 ... at
   * most 83).
   */
  repairStationRange(level: number): number {
    return this.maxRepairStationRange() - 100 / (Math.max(1, level) + 4);
  }

  maxRepairStationRange(): number {
    return 83;
  }

  /**
   * Percent of a structure's max health a Repair Station at `level` mends
   * each second: 1% for one station, +1% per stacked level. Overlapping
   * stations do not add up; the best one in reach heals.
   */
  repairStationHealPercent(level: number): number {
    return Math.max(1, level);
  }

  structureMinDist(): number {
    return 15;
  }

  // --- Air warfare (all distances in tiles, all times in ticks) ---

  /** Aircraft a player may own per airfield level, of any mix of types. */
  aircraftPerAirfieldLevel(): number {
    return 5;
  }

  // --- Aircraft carrier ---

  /** Aircraft slots an aircraft carrier adds to the cap (like an airfield level). */
  carrierAircraftCapacity(): number {
    return 5;
  }

  /** How far a carrier's aircraft may operate from it (an airfield's is 300+). */
  carrierAirRange(): number {
    return 220;
  }

  /** Reach of a carrier's small SAM against nukes and cruise missiles (a SAM's is 70+). */
  carrierSamRange(): number {
    return 45;
  }

  /** Ticks a carrier's SAM takes to reload its one missile. */
  carrierSamCooldown(): number {
    return 150;
  }

  // --- Cruise missiles ---

  /** Tiles a cruise missile flies per tick (a nuke 10, along a higher arc). */
  cruiseMissileSpeed(): number {
    return 6;
  }

  /** A silo launches cruise missiles at targets up to this far away. */
  cruiseMissileRange(): number {
    return 500;
  }

  /** Damage to the structure (or unit) hit, and, halved, to the others in the blast. */
  cruiseMissileDamage(): number {
    return 220;
  }

  /** Radius of a cruise missile's blast. */
  cruiseMissileBlastRadius(): number {
    return 8;
  }

  // --- Paratroopers ---

  /** Tiles a transport plane flies per tick. */
  transportPlaneSpeed(): number {
    return 3;
  }

  /** Share of their troops a player drops when the order names none. */
  paradropDefaultTroopShare(): number {
    return 0.2;
  }

  // --- Capital ---

  /** Extra troop growth while a player's capital stands (percent). */
  capitalTroopBonusPercent(): number {
    return 25;
  }

  /** Extra gold while a player's capital stands (percent). */
  capitalGoldBonusPercent(): number {
    return 10;
  }

  /** Land within this range of a capital is defended like near a defense post. */
  capitalDefenseRange(): number {
    return 35;
  }

  /** Ticks without a capital (and its bonuses) after losing it: 3 minutes. */
  capitalLostTicks(): number {
    return 3 * 60 * 10;
  }

  // --- Unrest and secession ---

  /** Ticks for a player's unrest to halve (2 minutes). */
  unrestHalfLifeTicks(): number {
    return 2 * 60 * 10;
  }

  /** Troops and gold lost at most to unrest (when all land is fresh). */
  unrestMaxPenalty(): number {
    return 0.5;
  }

  /** Share of a player's land in unrest from which secession looms. */
  secessionUnrestShare(): number {
    return 0.5;
  }

  /** Smaller players never break apart. */
  secessionMinTiles(): number {
    return 4000;
  }

  /** No secession in the first 10 minutes, while empires are still forming. */
  secessionEarliestTick(): number {
    return 10 * 60 * 10;
  }

  /** Ticks of looming secession (with a warning) before land breaks away: 45 s. */
  secessionWarningTicks(): number {
    return 45 * 10;
  }

  /** Share of a player's land that breaks away, the part farthest from the capital. */
  secessionLandShare(): number {
    return 0.25;
  }

  /** Ticks after a secession before the same player can lose land again: 5 minutes. */
  secessionCooldownTicks(): number {
    return 5 * 60 * 10;
  }

  /**
   * How far from an airfield of this level its owner's aircraft may operate.
   * Stacking an airfield widens it; several airfields cover the union of
   * their circles.
   */
  airfieldRange(level: number): number {
    return 300 + 75 * (Math.max(1, level) - 1);
  }

  /** Health an aircraft without any airfield loses every second. */
  aircraftNoAirfieldDecayPercent(): number {
    return 5;
  }

  // --- Nuclear submarine ---

  /** Ticks from the order to surface until the submarine can fire. */
  submarineSurfaceTicks(): number {
    return 20 * 10;
  }

  /** Ticks a surfaced submarine stays up to fire before it dives again. */
  submarineFireWindowTicks(): number {
    return 30 * 10;
  }

  /**
   * Payload points of one surfacing: five atom bombs, two hydrogen bombs or
   * one MIRV fill it, and any smaller mix fits too.
   */
  submarinePayload(): number {
    return 10;
  }

  /** Payload points a nuke of this type takes up in a submarine. */
  nukePayloadCost(type: UnitType): number {
    switch (type) {
      case UnitType.AtomBomb:
        return 2;
      case UnitType.HydrogenBomb:
        return 5;
      case UnitType.MIRV:
        return 10;
      default:
        return Number.MAX_SAFE_INTEGER;
    }
  }

  /** A surfaced submarine sails at this percent of its submerged speed. */
  submarineSurfacedSpeedPercent(): number {
    return 40;
  }

  // --- Rail depot and tanks ---

  /** Tanks a player may own per factory level (tanks roll out of factories). */
  tanksPerFactoryLevel(): number {
    return 5;
  }

  /** A rail depot repairs its owner's tanks within this many tiles. */
  railDepotRepairRange(): number {
    return 40;
  }

  /** Health a rail depot gives back to each tank in reach per second, per depot level (a tank has 400). */
  railDepotRepairPerLevel(): number {
    return 8;
  }

  /** Tiles a tank covers per tick on a railway. Off the rails it drives 1. */
  tankRailSpeed(): number {
    return 3;
  }

  /** A tank shoots at enemy structures and tanks within this range. */
  tankRange(): number {
    return 20;
  }

  /** Ticks between a tank's shots. */
  tankAttackRate(): number {
    return 5;
  }

  /** Damage of one tank shot (8 per second, a fighter does 30). */
  tankShotDamage(): number {
    return 4;
  }

  /**
   * Attacks on its owner's tiles within this range of a tank cost the
   * attacker as much as next to a defense post.
   */
  tankDefenseRange(): number {
    return 30;
  }

  /** How far past its owner's border a tank may drive unharmed. */
  tankBorderBuffer(): number {
    return 30;
  }

  /** Percent of its max health a tank beyond that buffer loses per second. */
  tankOutsideDamagePercent(): number {
    return 5;
  }

  // --- Mines ---

  /** No mine may be placed this close to another. */
  mineMinDistance(): number {
    return 15;
  }

  /** Percent of an attack's troops a land mine kills when the attack takes its tile. */
  landMineTroopLossPercent(): number {
    return 5;
  }

  /** A foreign ship this close to a sea mine sets it off. */
  seaMineTriggerRange(): number {
    return 3;
  }

  /** Every ship this close to a sea mine that goes off sinks, its owner's too. */
  seaMineBlastRadius(): number {
    return 15;
  }

  /** Tiles an aircraft flies per tick. A warship sails 1. */
  aircraftSpeed(type: UnitType): number {
    return type === UnitType.FighterJet ? 4 : 2;
  }

  /** How far from its patrol tile an aircraft picks its waypoints. */
  aircraftPatrolRange(type: UnitType): number {
    return type === UnitType.FighterJet ? 45 : 25;
  }

  /** An aircraft within this range of one of its owner's airfields repairs. */
  airfieldRepairRange(): number {
    return 60;
  }

  /** Health an aircraft in repair range regains every 2 ticks. */
  airfieldRepairAmount(): number {
    return 1;
  }

  /**
   * A fighter or bomber below this percent of its max health breaks off and
   * flies back to its nearest airfield or carrier to be repaired, like a
   * warship to its port.
   */
  aircraftRetreatHealthPercent(): number {
    return 30;
  }

  /** A retreating plane within this range of its base is repaired there. */
  aircraftDockingRange(): number {
    return 20;
  }

  /** A fighter picks up enemy aircraft and ships within this range of itself. */
  fighterTargetingRange(): number {
    return 90;
  }

  /** A fighter breaks off a chase this far from its patrol tile. */
  fighterLeashRange(): number {
    return 160;
  }

  /**
   * The same for a fighter on guard over its owner's land: it does not
   * follow a threat far from its post (and into the enemy's AA Defenses).
   */
  fighterGuardRange(): number {
    return 80;
  }

  /** A fighter's guns reach this far. */
  fighterGunRange(): number {
    return 30;
  }

  /** Ticks between a fighter's shots at another aircraft (30 damage/s). */
  fighterAirAttackRate(): number {
    return 4;
  }

  /** Damage of one fighter shot. */
  fighterShotDamage(): number {
    return 12;
  }

  /**
   * Ticks between a fighter's shots at a ship. Boats have no health and sink
   * to one hit, so this is what paces a fighter against them.
   */
  fighterShipAttackRate(): number {
    return 15;
  }

  /** Damage of one fighter shot at a warship: a nuisance, not a threat. */
  fighterShipShotDamage(): number {
    return 40;
  }

  /** A bomber bombs enemy structures within this range of its patrol tile. */
  bomberTargetingRange(): number {
    return 60;
  }

  /** A bomber drops on a structure it is within this range of. */
  bomberBombRange(): number {
    return 10;
  }

  /** Ticks between a bomber's bombs. */
  bomberAttackRate(): number {
    return 15;
  }

  /** Damage of one bomb to every enemy structure in its blast (≈67/s). */
  bomberBombDamage(): number {
    return 100;
  }

  /** Blast radius of a bomb. structureMinDist is 15. */
  bomberBombRadius(): number {
    return 12;
  }

  /** An AA Defense engages enemy aircraft within this range. */
  aaDefenseRange(): number {
    return 60;
  }

  /** Ticks an AA Defense needs to reload one missile; it holds one per level. */
  aaDefenseCooldown(): number {
    return 15;
  }

  /**
   * Ticks between two launches of the same AA gun. Higher levels hold more
   * missiles but fire them one after another instead of all in the same
   * instant, so a stacked AA no longer erases a plane in one blink.
   */
  aaDefenseSalvoSpacing(): number {
    return 4;
  }

  /** Damage of one AA missile: two down a fighter, three a bomber. */
  aaMissileDamage(): number {
    return 110;
  }

  /** Tiles an AA missile flies per tick; it homes in on its target. */
  aaMissileSpeed(): number {
    return 12;
  }

  /** Max-health boost per veterancy level, as an integer percent of base max
   *  health. Integer-only to keep the engine deterministic (no float constants). */
  warshipVeterancyHealthBonus(): number {
    return 20;
  }

  allianceExtensionPromptOffset(): number {
    return 300; // 30 seconds before expiration
  }
}
