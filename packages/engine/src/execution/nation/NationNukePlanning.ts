import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Structures, UnitType } from "@openfront/engine-api/game/GameTypes";
import { Game, Player, Unit } from "../../game/Game";
import { UniversalPathFinding } from "../../pathfinding/PathFinder";
import { aiUnitDisabled } from "./NationUtils";

export type NukeType = UnitType.AtomBomb | UnitType.HydrogenBomb;

/** Cap on silo levels reachable via the SAM salvo's upgrade fallback. */
const MAX_NATION_SILO_UPGRADE_LEVEL = 5;

/** Whether our inner blast would overlap the inner blast of any player's nuke in flight. */
export function isNukeAlreadyLandingNear(
  game: Game,
  tile: TileRef,
  nukeType: NukeType,
): boolean {
  const config = game.config();
  const ourInnerRadius = config.nukeMagnitudes(nukeType).inner;
  const nukesInFlight = game.units(
    UnitType.AtomBomb,
    UnitType.HydrogenBomb,
    UnitType.MIRVWarhead,
  );
  for (const nuke of nukesInFlight) {
    const targetTile = nuke.targetTile();
    if (targetTile === undefined) continue;
    const sumRadius = ourInnerRadius + config.nukeMagnitudes(nuke.type()).inner;
    if (game.euclideanDistSquared(tile, targetTile) <= sumRadius * sumRadius) {
      return true;
    }
  }
  return false;
}

/**
 * Grid-sampled share of the blast that hits land of players not friendly to
 * player. Inner radius tiles count double, as the outer ring is only
 * partially destroyed.
 */
export function enemyLandBlastCoverage(
  game: Game,
  player: Player,
  center: TileRef,
  nukeType: NukeType,
): number {
  const { inner, outer } = game.config().nukeMagnitudes(nukeType);
  const step = Math.max(1, Math.floor(outer / 10));
  const cx = game.x(center);
  const cy = game.y(center);
  let total = 0;
  let enemyLand = 0;
  for (let dy = -outer; dy <= outer; dy += step) {
    for (let dx = -outer; dx <= outer; dx += step) {
      const distSquared = dx * dx + dy * dy;
      if (distSquared > outer * outer) continue;
      const weight = distSquared <= inner * inner ? 2 : 1;
      total += weight;
      if (!game.isValidCoord(cx + dx, cy + dy)) continue;
      // Water, fallout and unowned land have no player owner
      const owner = game.owner(game.ref(cx + dx, cy + dy));
      if (owner.isPlayer() && !player.isFriendly(owner, true)) {
        enemyLand += weight;
      }
    }
  }
  return enemyLand / total;
}

/** Whether any tile in the blast, widened by margin, belongs to player, a teammate or an ally (even AFK ones). */
export function blastHitsFriendlyLand(
  game: Game,
  player: Player,
  center: TileRef,
  nukeType: NukeType,
  margin = 0,
): boolean {
  const friendlyIds = new Set(
    game
      .players()
      .filter((p) => player.isFriendly(p, true))
      .map((p) => p.smallID()),
  );
  const outer = game.config().nukeMagnitudes(nukeType).outer + margin;
  const cx = game.x(center);
  const cy = game.y(center);
  for (let dy = -outer; dy <= outer; dy++) {
    for (let dx = -outer; dx <= outer; dx++) {
      if (dx * dx + dy * dy > outer * outer) continue;
      if (!game.isValidCoord(cx + dx, cy + dy)) continue;
      const ownerId = game.ownerID(game.ref(cx + dx, cy + dy));
      if (friendlyIds.has(ownerId)) return true;
    }
  }
  return false;
}

/** The tiles, one per tick, a nation's atom or hydrogen bomb flies from spawnTile to targetTile. */
export function nukeTrajectory(
  game: Game,
  spawnTile: TileRef,
  targetTile: TileRef,
): TileRef[] {
  const pathFinder = UniversalPathFinding.Parabola(game, {
    increment: game.config().nukeSpeed(UnitType.AtomBomb),
    distanceBasedHeight: true, // Atom/Hydrogen bombs use distance-based height
    directionUp: true, // AI nukes always go "up" for now
  });
  return pathFinder.findPath(spawnTile, targetTile) ?? [];
}

// Whether a SAM hostile to player can shoot down a bomb flying from spawnTile
// to targetTile; mirroring NukeTrajectoryPreviewLayer.ts logic a bit
export function isTrajectoryInterceptableBySam(
  game: Game,
  player: Player,
  spawnTile: TileRef,
  targetTile: TileRef,
  excludedSamIds?: Set<number>,
): boolean {
  const trajectory = nukeTrajectory(game, spawnTile, targetTile);
  if (trajectory.length === 0) {
    return false;
  }
  // Carriers' small SAMs (the launchers are checked below).
  if (
    isPathInterceptable(game, player, trajectory, {
      excludedSamIds,
      types: [UnitType.AircraftCarrier],
    })
  ) {
    return true;
  }

  const targetRangeSquared = game.config().defaultNukeTargetableRange() ** 2;

  let untargetableStart = -1;
  let untargetableEnd = -1;
  for (let i = 0; i < trajectory.length; i++) {
    const tile = trajectory[i];
    if (untargetableStart === -1) {
      if (game.euclideanDistSquared(tile, spawnTile) > targetRangeSquared) {
        if (game.euclideanDistSquared(tile, targetTile) < targetRangeSquared) {
          // Overlapping spawn & target range – no untargetable segment.
          break;
        } else {
          untargetableStart = i;
        }
      }
    } else if (
      game.euclideanDistSquared(tile, targetTile) < targetRangeSquared
    ) {
      untargetableEnd = i;
      break;
    }
  }

  for (let i = 0; i < trajectory.length; i++) {
    // Skip the mid-air untargetable portion
    if (
      untargetableStart !== -1 &&
      untargetableEnd !== -1 &&
      i === untargetableStart
    ) {
      i = untargetableEnd - 1;
      continue;
    }

    const tile = trajectory[i];
    const nearbySams = game.nearbyUnits(
      tile,
      game.config().maxSamRange(),
      UnitType.SAMLauncher,
    );

    for (const sam of nearbySams) {
      const owner = sam.unit.owner();
      if (owner === player || player.isFriendly(owner)) {
        continue;
      }
      // Skip SAMs we're intentionally overwhelming
      if (excludedSamIds?.has(sam.unit.id())) {
        continue;
      }
      const rangeSquared = game.config().samRange(sam.unit.level()) ** 2;
      if (sam.distSquared <= rangeSquared) {
        return true;
      }
    }
  }

  return false;
}

/** What can shoot down a nuke or cruise missile: SAM launchers and aircraft carriers' small SAMs. */
const INTERCEPTOR_TYPES: readonly UnitType[] = [
  UnitType.SAMLauncher,
  UnitType.AircraftCarrier,
];

/** Range of a SAM launcher or a carrier's small SAM at `tick`. */
export function interceptorRange(game: Game, sam: Unit, tick: number): number {
  return game.config().dynamicSamRange(sam, tick);
}

/** Missiles a SAM launcher (its level) or a carrier (one) holds. */
export function interceptorMissiles(sam: Unit): number {
  return sam.type() === UnitType.AircraftCarrier ? 1 : sam.level();
}

/** Ticks a SAM launcher or a carrier's small SAM takes to reload a missile. */
export function interceptorCooldown(game: Game, sam: Unit): number {
  return sam.type() === UnitType.AircraftCarrier
    ? game.config().carrierSamCooldown()
    : game.config().SAMCooldown();
}

/**
 * Launch ticks of the interceptor's missiles still reloading. A carrier's
 * reload is kept inside its execution, so it counts as always loaded.
 */
function interceptorQueue(sam: Unit): number[] {
  return sam.type() === UnitType.AircraftCarrier ? [] : sam.missileTimerQueue();
}

/**
 * Whether a hostile SAM (launcher or carrier) could shoot down something
 * flying along `trajectory` (one tile per tick, launched now), like
 * SAMTargetingSystem: only near the launch or the target, within the SAM's
 * range.
 *
 * With `useReloadState` it reads the SAMs as they are right now: a SAM
 * whose missiles are all reloading only counts if one is back before the
 * flight passes it, and its missile has to be able to reach the flight in
 * time. Without, any SAM in reach counts (as if every one were loaded).
 */
export function isPathInterceptable(
  game: Game,
  player: Player,
  trajectory: readonly TileRef[],
  options: {
    useReloadState?: boolean;
    excludedSamIds?: Set<number>;
    /** Which interceptors to consider (default: SAM launchers and carriers). */
    types?: readonly UnitType[];
  } = {},
): boolean {
  const useReloadState = options.useReloadState ?? false;
  const excludedSamIds = options.excludedSamIds;
  const types = options.types ?? INTERCEPTOR_TYPES;
  if (trajectory.length < 2) return false;
  const config = game.config();
  const src = trajectory[0];
  const dst = trajectory[trajectory.length - 1];
  const targetable = config.defaultNukeTargetableRange();
  const targetableSquared = targetable * targetable;
  const now = game.ticks();
  const missileSpeed = config.defaultSamMissileSpeed();

  const sams = new Map<number, Unit>();
  for (const end of [src, dst]) {
    for (const { unit } of game.nearbyUnits(
      end,
      config.maxSamRange() + targetable,
      types,
    )) {
      const owner = unit.owner();
      if (owner === player || player.isFriendly(owner)) continue;
      if (excludedSamIds?.has(unit.id())) continue;
      sams.set(unit.id(), unit);
    }
  }

  for (const sam of sams.values()) {
    // Ticks from now until the SAM has a missile to fire.
    let readyIn = 0;
    if (useReloadState) {
      const queue = interceptorQueue(sam);
      if (queue.length >= interceptorMissiles(sam)) {
        readyIn = Math.min(...queue) + interceptorCooldown(game, sam) - now;
      }
    }
    const samTile = sam.tile();
    for (let i = 0; i <= trajectory.length - 2; i++) {
      const tile = trajectory[i];
      if (
        game.euclideanDistSquared(tile, src) >= targetableSquared &&
        game.euclideanDistSquared(tile, dst) >= targetableSquared
      ) {
        continue;
      }
      const range = interceptorRange(game, sam, now + i);
      if (game.euclideanDistSquared(samTile, tile) > range * range) continue;
      if (!useReloadState) return true;
      const fireTick =
        i - Math.ceil(game.manhattanDist(samTile, tile) / missileSpeed);
      if (fireTick >= 0 && fireTick >= readyIn) return true;
    }
  }
  return false;
}

/** Atom bombs aimed at targetTile, each launched after its wait so all arrive within one SAM cooldown. */
export interface SamSalvo {
  targetTile: TileRef;
  waitTicks: number[];
}

/** A SAM salvo our silos lacked the capacity for. */
export interface FailedSamSalvo {
  targetTile: TileRef;
  coveringSamIds: Set<number>;
  totalBombs: number;
}

/**
 * An atom bomb salvo from player that destroys one of target's SAMs, trying
 * the easiest (lowest level) first. A SAM of level N can intercept N nukes
 * before going on cooldown, so it takes N+1 bombs (accounting for all
 * covering SAMs). Without one, `failed` is the first SAM our silos lacked
 * the capacity for; a SAM we only lack the gold for leaves it null.
 */
export function planSamSalvo(
  game: Game,
  player: Player,
  target: Player,
): { salvo: SamSalvo | null; failed: FailedSamSalvo | null } {
  const atomCost = game.unitInfo(UnitType.AtomBomb).cost(game, player);
  const enemySams = target.units(UnitType.SAMLauncher);
  if (enemySams.length === 0) {
    return { salvo: null, failed: null };
  }

  const ourSilos = player
    .units(UnitType.MissileSilo)
    .filter((silo) => !silo.isUnderConstruction());
  if (ourSilos.length === 0) {
    return { salvo: null, failed: null };
  }

  // Try each enemy SAM as a target, easiest (lowest level) first
  const sortedSams = enemySams.slice().sort((a, b) => a.level() - b.level());
  // Track the first failed attempt so we can upgrade a silo that would
  // actually have helped that plan (rather than an unrelated silo).
  let failed: FailedSamSalvo | null = null;

  for (const targetSam of sortedSams) {
    const targetTile = targetSam.tile();
    // Hitting an ally's land would break the alliance
    if (blastHitsFriendlyLand(game, player, targetTile, UnitType.AtomBomb)) {
      continue;
    }

    // Find all enemy SAMs whose range covers the target tile (they will all try to intercept)
    const coveringSams = findEnemySamsCoveringTile(game, player, targetTile);
    const coveringSamIds = new Set(coveringSams.map((s) => s.id()));

    // Total interception capacity = sum of covering SAM levels (a carrier: one)
    const totalInterceptions = coveringSams.reduce(
      (sum, sam) => sum + interceptorMissiles(sam),
      0,
    );
    const bombsNeeded = totalInterceptions + 1;

    // NukeExecution always picks the closest non-cooldown silo by Manhattan
    // distance to target (via nukeSpawn). Our planning must mirror that order.
    // Silos with interceptable trajectories will still be picked first by
    // NukeExecution — their bombs launch but get intercepted, "wasting" slots.
    const nukeSpeed = game.config().nukeSpeed(UnitType.AtomBomb);
    const allAvailableSilos: {
      silo: Unit;
      slots: number;
      flightTicks: number;
      interceptable: boolean;
    }[] = [];
    for (const silo of ourSilos) {
      const availableSlots = silo.level() - silo.missileTimerQueue().length;
      if (availableSlots <= 0) {
        continue;
      }
      const interceptable = isTrajectoryInterceptableBySam(
        game,
        player,
        silo.tile(),
        targetTile,
        coveringSamIds,
      );
      // Compute actual parabolic flight time in ticks
      const pathFinder = UniversalPathFinding.Parabola(game, {
        increment: nukeSpeed,
        distanceBasedHeight: true,
        directionUp: true,
      });
      const trajectory = pathFinder.findPath(silo.tile(), targetTile) ?? [];
      if (trajectory.length === 0) continue;
      allAvailableSilos.push({
        silo,
        slots: availableSlots,
        flightTicks: trajectory.length,
        interceptable,
      });
    }

    // Sort by Manhattan distance to target (matching nukeSpawn's pick order)
    allAvailableSilos.sort(
      (a, b) =>
        game.manhattanDist(a.silo.tile(), targetTile) -
        game.manhattanDist(b.silo.tile(), targetTile),
    );

    // Flatten into a per-bomb launch sequence matching NukeExecution's order.
    // Each silo contributes `slots` consecutive bombs before NukeExecution
    // moves to the next silo.
    const launchSequence: {
      flightTicks: number;
      interceptable: boolean;
    }[] = [];
    for (const entry of allAvailableSilos) {
      for (let s = 0; s < entry.slots; s++) {
        launchSequence.push({
          flightTicks: entry.flightTicks,
          interceptable: entry.interceptable,
        });
      }
    }

    // Use half the SAM cooldown as the max total arrival spread to be safe.
    const samCooldown = game.config().SAMCooldown();
    const maxTotalArrivalSpread = Math.floor(samCooldown / 2);

    // Add extra bombs: 1 for every 5 to account for enemy building more SAMs
    // while our bombs are in flight
    const extraBombs = Math.floor(bombsNeeded / 5);
    const totalBombs = bombsNeeded + extraBombs;

    // Collect bombs from silos whose trajectory to the target is NOT blocked
    // by enemy SAMs other than the covering SAMs we're trying to overwhelm.
    const unblockedBombs: { index: number; flightTicks: number }[] = [];
    for (let i = 0; i < launchSequence.length; i++) {
      if (!launchSequence[i].interceptable) {
        unblockedBombs.push({
          index: i,
          flightTicks: launchSequence[i].flightTicks,
        });
      }
    }

    if (unblockedBombs.length < totalBombs) {
      failed ??= { targetTile, coveringSamIds, totalBombs };
      continue;
    }

    // Sort unblocked bombs by flight time to find a sliding window
    // of maxTotalArrivalSpread that captures the most bombs.
    const sortedByFlight = [...unblockedBombs].sort(
      (a, b) => a.flightTicks - b.flightTicks,
    );

    let bestWindowStart = 0;
    let bestWindowCount = 0;
    for (let start = 0; start < sortedByFlight.length; start++) {
      let end = start;
      while (
        end < sortedByFlight.length &&
        sortedByFlight[end].flightTicks - sortedByFlight[start].flightTicks <=
          maxTotalArrivalSpread
      ) {
        end++;
      }
      if (end - start > bestWindowCount) {
        bestWindowCount = end - start;
        bestWindowStart = start;
      }
    }

    if (bestWindowCount < totalBombs) {
      failed ??= { targetTile, coveringSamIds, totalBombs };
      continue;
    }

    // From the window, pick totalBombs with the lowest launch-sequence
    // indices to minimise how many bombs we need to fire (minimise gold cost).
    const windowBombs = sortedByFlight.slice(
      bestWindowStart,
      bestWindowStart + bestWindowCount,
    );
    const windowByIndex = [...windowBombs].sort((a, b) => a.index - b.index);
    const selected = windowByIndex.slice(0, totalBombs);
    const selectedSet = new Set(selected.map((b) => b.index));
    const lastSelectedIndex = selected[selected.length - 1].index;
    const bombsToFire = lastSelectedIndex + 1;

    // Compute per-bomb waitTicks so all selected bombs arrive in the window.
    // Target: spread arrivals evenly, anchored at the earliest flight time
    // in the selected set.
    const selectedFlightMin = Math.min(...selected.map((b) => b.flightTicks));
    const staggerInterval = Math.max(
      1,
      Math.floor(maxTotalArrivalSpread / totalBombs),
    );
    let selectedIdx = 0;
    const waitTicksPerBomb: number[] = [];
    for (let i = 0; i < bombsToFire; i++) {
      if (selectedSet.has(i)) {
        const targetArrival = selectedFlightMin + selectedIdx * staggerInterval;
        waitTicksPerBomb.push(
          Math.max(0, targetArrival - launchSequence[i].flightTicks),
        );
        selectedIdx++;
      } else {
        // Wasted bomb (interceptable or out-of-window) — launch immediately
        waitTicksPerBomb.push(0);
      }
    }

    // Check gold for all fired bombs (including wasted ones)
    const totalCost = atomCost * BigInt(bombsToFire);
    if (player.gold() < totalCost) {
      continue;
    }

    // NukeExecution will pick silos in the same Manhattan distance order we planned.
    return { salvo: { targetTile, waitTicks: waitTicksPerBomb }, failed };
  }

  return { salvo: null, failed };
}

/**
 * Find all SAMs hostile to player whose range covers a given tile.
 */
export function findEnemySamsCoveringTile(
  game: Game,
  player: Player,
  tile: TileRef,
): Unit[] {
  const nearbySams = game.nearbyUnits(
    tile,
    game.config().maxSamRange(),
    INTERCEPTOR_TYPES,
  );

  const result: Unit[] = [];
  for (const sam of nearbySams) {
    const owner = sam.unit.owner();
    if (owner === player || player.isFriendly(owner)) {
      continue;
    }
    const range = interceptorRange(game, sam.unit, game.ticks());
    if (sam.distSquared <= range * range) {
      result.push(sam.unit);
    }
  }
  return result;
}

/**
 * A missile silo whose upgrade would actually have helped the failed
 * salvo: trajectory to the failed target is not blocked by non-covering
 * enemy SAMs, and the silo is below the upgrade cap. Among those, picks the
 * one best protected by our own SAMs.
 */
export function siloToUpgradeForSalvo(
  game: Game,
  player: Player,
  failed: FailedSamSalvo,
): Unit | null {
  const silos = player.units(UnitType.MissileSilo);
  if (silos.length === 0) return null;

  // First pass: find silos with an unblocked trajectory to the failed
  // target. Only these contribute slots to the overwhelm plan.
  // "Unblocked" means not interceptable by non-covering enemy SAMs.
  const unblockedSilos: Unit[] = [];
  for (const silo of silos) {
    if (
      !isTrajectoryInterceptableBySam(
        game,
        player,
        silo.tile(),
        failed.targetTile,
        failed.coveringSamIds,
      )
    ) {
      unblockedSilos.push(silo);
    }
  }
  if (unblockedSilos.length === 0) return null;

  // Bail out if the target is unreachable even at max silo level —
  // crazy amounts of covering SAMs, upgrading is wasted gold.
  const maxAchievableSlots =
    unblockedSilos.length * MAX_NATION_SILO_UPGRADE_LEVEL;
  if (maxAchievableSlots < failed.totalBombs) return null;

  const ourSams = player.units(UnitType.SAMLauncher);
  let bestSilo: Unit | null = null;
  let bestProtection = -1;

  for (const silo of unblockedSilos) {
    if (silo.level() >= MAX_NATION_SILO_UPGRADE_LEVEL) continue;
    if (!player.canUpgradeUnit(silo)) continue;

    let protection = 0;
    for (const sam of ourSams) {
      const range = game.config().samRange(sam.level());
      const distSquared = game.euclideanDistSquared(silo.tile(), sam.tile());
      if (distSquared <= range * range) {
        protection += sam.level();
      }
    }

    if (protection > bestProtection) {
      bestProtection = protection;
      bestSilo = silo;
    }
  }

  return bestSilo;
}

/** One bomb of a SAM saturation strike, in launch order: decoys first, the payload last. */
export interface SalvoLaunch {
  type: NukeType;
  waitTicks: number;
}

/** How cleverly a nation saturates the SAMs guarding a target. */
export interface SaturationStyle {
  /**
   * Time the launches so every SAM meets the decoys before the payload, and
   * check the plan by playing the interception through. Untimed salvos just
   * send one decoy per SAM covering the target and hold the payload back a
   * moment.
   */
  timed: boolean;
  /** Plan as if every SAM had all its missiles loaded (ignores ones still reloading). */
  assumeReloaded: boolean;
  /** Decoys on top of the fewest that get the payload through, for SAMs built or upgraded while the bombs fly. */
  spareDecoys: number;
  maxDecoys: number;
}

/** Ticks between two planned SAM engagements; a SAM may fire a tick early, so they stay in order. */
const SALVO_SPACING_TICKS = 3;

/** Ticks an untimed salvo holds its payload on the pad, so the SAMs see the decoys first. */
const UNTIMED_PAYLOAD_DELAY = 6;

interface Launcher {
  tile: TileRef;
  /** A silo's missile queue (launch ticks), null for a submarine. */
  siloQueue: number[] | null;
  slots: number;
  payload: number;
}

interface AssignedLaunch {
  type: NukeType;
  tile: TileRef;
  /** Ticks NukeExecution itself holds the bomb back, queued behind the silo's other launches. */
  queueWait: number;
}

/**
 * A salvo of atom bomb decoys followed by payload, all aimed at targetTile,
 * that soaks up the missiles of every hostile SAM able to intercept them so
 * the payload gets through. Null if our launchers, the gold budget (for the
 * decoys and the payload together) or maxDecoys don't allow one.
 */
export function planSaturationStrike(
  game: Game,
  player: Player,
  targetTile: TileRef,
  payload: NukeType,
  budget: bigint,
  style: SaturationStyle,
): SalvoLaunch[] | null {
  if (aiUnitDisabled(game, player, UnitType.AtomBomb)) return null;
  const atomCost = game.unitInfo(UnitType.AtomBomb).cost(game, player);
  const payloadCost = game.unitInfo(payload).cost(game, player);
  const launchers = readyLaunchers(player);
  const affordable = (decoys: number) =>
    atomCost * BigInt(decoys) + payloadCost <= budget;

  if (!style.timed) {
    const decoys = findEnemySamsCoveringTile(game, player, targetTile).length;
    if (decoys > style.maxDecoys || !affordable(decoys)) return null;
    const types = salvoTypes(decoys, payload);
    if (assignLaunchers(game, launchers, targetTile, types) === null) {
      return null;
    }
    return types.map((type, i) => ({
      type,
      waitTicks: i === types.length - 1 ? UNTIMED_PAYLOAD_DELAY : 0,
    }));
  }

  const planner = new SalvoPlanner(game, player, targetTile, style);
  let fewest = -1;
  for (let decoys = 0; decoys <= style.maxDecoys; decoys++) {
    if (!affordable(decoys)) return null;
    const result = planner.plan(launchers, decoys, payload);
    if (result === "no launchers") return null;
    if (result !== null) {
      fewest = decoys;
      break;
    }
  }
  if (fewest === -1) return null;
  // Spare decoys where the launchers and the gold allow them
  for (
    let decoys = Math.min(fewest + style.spareDecoys, style.maxDecoys);
    decoys > fewest;
    decoys--
  ) {
    if (!affordable(decoys)) continue;
    const result = planner.plan(launchers, decoys, payload);
    if (result !== null && result !== "no launchers") return result;
  }
  const result = planner.plan(launchers, fewest, payload);
  return result === "no launchers" ? null : result;
}

function salvoTypes(decoys: number, payload: NukeType): NukeType[] {
  const types: NukeType[] = [];
  for (let i = 0; i < decoys; i++) types.push(UnitType.AtomBomb);
  types.push(payload);
  return types;
}

/** Silos with a free missile and surfaced submarines, as Player.nukeSpawn lists them. */
function readyLaunchers(player: Player): Launcher[] {
  const launchers: Launcher[] = [];
  for (const silo of player.units(UnitType.MissileSilo)) {
    if (!silo.isActive() || silo.isUnderConstruction()) continue;
    const queue = silo.missileTimerQueue();
    const slots = silo.level() - queue.length;
    if (slots <= 0) continue;
    launchers.push({
      tile: silo.tile(),
      siloQueue: [...queue],
      slots,
      payload: 0,
    });
  }
  for (const sub of player.units(UnitType.NuclearSubmarine)) {
    const state = sub.submarineState();
    if (!sub.isActive() || state?.mode !== "surfaced") continue;
    launchers.push({
      tile: sub.tile(),
      siloQueue: null,
      slots: 0,
      payload: state.payloadLeft,
    });
  }
  return launchers;
}

/**
 * Where each bomb launches from, the way NukeExecution picks it: the nearest
 * launcher with room (Player.nukeSpawn), a silo queueing its launches a tick
 * apart. Null if the launchers run out.
 */
function assignLaunchers(
  game: Game,
  ready: Launcher[],
  targetTile: TileRef,
  types: NukeType[],
): AssignedLaunch[] | null {
  const launchers = ready.map((l) => ({
    ...l,
    siloQueue: l.siloQueue === null ? null : [...l.siloQueue],
  }));
  // Stable sort: on ties silos come first, like in Player.nukeSpawn
  const order = launchers
    .map((_, i) => i)
    .sort(
      (a, b) =>
        game.manhattanDist(launchers[a].tile, targetTile) -
        game.manhattanDist(launchers[b].tile, targetTile),
    );
  const now = game.ticks();
  const assigned: AssignedLaunch[] = [];
  for (const type of types) {
    const cost = game.config().nukePayloadCost(type);
    const index = order.find((i) =>
      launchers[i].siloQueue !== null
        ? launchers[i].slots > 0
        : launchers[i].payload >= cost,
    );
    if (index === undefined) return null;
    const launcher = launchers[index];
    let queueWait = 0;
    if (launcher.siloQueue !== null) {
      let lastDeparture = 0;
      for (const launchTick of launcher.siloQueue) {
        lastDeparture = Math.max(launchTick + 1, lastDeparture + 1);
      }
      queueWait = Math.max(0, lastDeparture - now);
      launcher.siloQueue.push(now);
      launcher.slots--;
    } else {
      launcher.payload -= cost;
    }
    assigned.push({ type, tile: launcher.tile, queueWait });
  }
  return assigned;
}

/**
 * Plans timed salvos at one target and plays each through against the
 * hostile SAMs, mirroring SAMLauncherExecution: a SAM shoots a bomb once its
 * missile can meet it near the bomb's launch or target tile, hydrogen bombs
 * before atom bombs, one SAM per bomb, and reloads each missile after
 * SAMCooldown ticks.
 */
class SalvoPlanner {
  private readonly trajectories = new Map<TileRef, TileRef[]>();
  // Ticks after launch at which a SAM can fire at a bomb from a launcher, by launcher tile and SAM id
  private readonly fireTicks = new Map<string, number[]>();
  private readonly sams = new Map<number, Unit>();

  constructor(
    private readonly game: Game,
    private readonly player: Player,
    private readonly targetTile: TileRef,
    private readonly style: SaturationStyle,
  ) {
    this.addSamsNear(targetTile);
  }

  /** The salvo's launches, null if the payload would be shot down, "no launchers" if they run out. */
  plan(
    launchers: Launcher[],
    decoys: number,
    payload: NukeType,
  ): SalvoLaunch[] | null | "no launchers" {
    const assigned = assignLaunchers(
      this.game,
      launchers,
      this.targetTile,
      salvoTypes(decoys, payload),
    );
    if (assigned === null) return "no launchers";
    for (const launch of assigned) this.addSamsNear(launch.tile);

    // Line the bombs up: decoy k meets its first SAM k spacings after the
    // first decoy, the payload two spacings after the last decoy
    const firstContact = assigned.map((launch) =>
      this.firstContact(launch.tile, launch.queueWait),
    );
    const offset = (i: number) =>
      i === assigned.length - 1
        ? (decoys + 1) * SALVO_SPACING_TICKS
        : i * SALVO_SPACING_TICKS;
    let start = 0;
    for (let i = 0; i < assigned.length; i++) {
      const contact = firstContact[i];
      if (contact !== null) start = Math.max(start, contact - offset(i));
    }
    const waits = assigned.map((_, i) => {
      const contact = firstContact[i];
      return contact === null ? 0 : start + offset(i) - contact;
    });
    if (!this.payloadSurvives(assigned, waits)) return null;
    return assigned.map((launch, i) => ({
      type: launch.type,
      waitTicks: waits[i],
    }));
  }

  private addSamsNear(tile: TileRef): void {
    const config = this.game.config();
    const reach = config.maxSamRange() + config.defaultNukeTargetableRange();
    const nearby = this.game.nearbyUnits(
      tile,
      reach,
      INTERCEPTOR_TYPES,
      undefined,
      // SAMs still being built may well be up before our bombs arrive
      this.style.assumeReloaded,
    );
    for (const { unit } of nearby) {
      const owner = unit.owner();
      if (owner === this.player || this.player.isFriendly(owner)) continue;
      this.sams.set(unit.id(), unit);
    }
  }

  private trajectory(from: TileRef): TileRef[] {
    let trajectory = this.trajectories.get(from);
    if (trajectory === undefined) {
      const pathFinder = UniversalPathFinding.Parabola(this.game, {
        increment: this.game.config().nukeSpeed(UnitType.AtomBomb),
        distanceBasedHeight: true,
        directionUp: true,
      });
      trajectory = pathFinder.findPath(from, this.targetTile) ?? [];
      this.trajectories.set(from, trajectory);
    }
    return trajectory;
  }

  /** Ascending ticks after launch at which sam can fire at a bomb from `from`. */
  private samFireTicks(from: TileRef, sam: Unit): number[] {
    const key = `${from}:${sam.id()}`;
    let ticks = this.fireTicks.get(key);
    if (ticks !== undefined) return ticks;
    ticks = [];
    const config = this.game.config();
    const trajectory = this.trajectory(from);
    const src = trajectory[0];
    const dst = trajectory[trajectory.length - 1];
    const targetableSquared = config.defaultNukeTargetableRange() ** 2;
    const range = interceptorRange(this.game, sam, this.game.ticks());
    const missileSpeed = config.defaultSamMissileSpeed();
    const samTile = sam.tile();
    for (let i = 0; i <= trajectory.length - 2; i++) {
      const tile = trajectory[i];
      if (this.game.euclideanDistSquared(samTile, tile) > range * range) {
        continue;
      }
      if (
        this.game.euclideanDistSquared(tile, dst) >= targetableSquared &&
        this.game.euclideanDistSquared(tile, src) >= targetableSquared
      ) {
        continue;
      }
      const missileTicks = Math.ceil(
        this.game.manhattanDist(samTile, tile) / missileSpeed,
      );
      ticks.push(i - missileTicks);
    }
    ticks.sort((a, b) => a - b);
    this.fireTicks.set(key, ticks);
    return ticks;
  }

  /** [first, last] tick (after the salvo's launch) a SAM can fire at a bomb from `from` held back `wait` ticks. */
  private window(
    from: TileRef,
    sam: Unit,
    wait: number,
  ): [number, number] | null {
    const ticks = this.samFireTicks(from, sam);
    // A SAM only fires at bombs it can still catch: not before the bomb's launch
    const first = ticks.find((t) => t + wait >= 0);
    if (first === undefined) return null;
    return [first + wait, ticks[ticks.length - 1] + wait];
  }

  private firstContact(from: TileRef, wait: number): number | null {
    let first: number | null = null;
    for (const sam of this.sams.values()) {
      const window = this.window(from, sam, wait);
      if (window !== null && (first === null || window[0] < first)) {
        first = window[0];
      }
    }
    return first;
  }

  private payloadSurvives(
    assigned: AssignedLaunch[],
    waits: number[],
  ): boolean {
    const now = this.game.ticks();
    const sams = [...this.sams.values()];
    // Carriers reload their small SAM slower than launchers
    const cooldowns = sams.map((sam) => interceptorCooldown(this.game, sam));
    // Ticks (after the salvo's launch) each SAM's missiles are loaded again
    const missiles = sams.map((sam, s) => {
      const loaded: number[] = [];
      const queue = this.style.assumeReloaded ? [] : interceptorQueue(sam);
      for (let i = queue.length; i < interceptorMissiles(sam); i++) {
        loaded.push(0);
      }
      for (const launchTick of queue) {
        loaded.push(launchTick + cooldowns[s] - now);
      }
      return loaded;
    });
    // A SAM may fire a tick early (SAMTargetingSystem accepts tick and tick + 1)
    const windows = assigned.map((launch, i) =>
      sams.map((sam) => {
        const window = this.window(
          launch.tile,
          sam,
          launch.queueWait + waits[i],
        );
        return window === null
          ? null
          : ([window[0] - 1, window[1]] as [number, number]);
      }),
    );
    let firstTick = Infinity;
    let lastTick = -Infinity;
    for (const perSam of windows) {
      for (const window of perSam) {
        if (window === null) continue;
        firstTick = Math.min(firstTick, window[0]);
        lastTick = Math.max(lastTick, window[1]);
      }
    }
    const alive = assigned.map(() => true);
    const payloadIndex = assigned.length - 1;
    for (let tick = firstTick; tick <= lastTick; tick++) {
      for (let s = 0; s < sams.length; s++) {
        const targets: number[] = [];
        for (let j = 0; j < assigned.length; j++) {
          const window = windows[j][s];
          if (
            alive[j] &&
            window !== null &&
            window[0] <= tick &&
            tick <= window[1]
          ) {
            targets.push(j);
          }
        }
        if (targets.length === 0) continue;
        // Hydrogen bombs first, then the one about to slip out of range
        targets.sort(
          (a, b) =>
            Number(assigned[b].type === UnitType.HydrogenBomb) -
              Number(assigned[a].type === UnitType.HydrogenBomb) ||
            windows[a][s]![1] - windows[b][s]![1] ||
            a - b,
        );
        for (const target of targets) {
          const missile = missiles[s].findIndex((loaded) => loaded <= tick);
          if (missile === -1) break;
          missiles[s][missile] = tick + cooldowns[s];
          alive[target] = false;
        }
      }
      if (!alive[payloadIndex]) return false;
    }
    return alive[payloadIndex];
  }
}

/** How much a nation wants a structure gone. */
export function structureNukeValue(unit: Unit): number {
  const level = unit.level();
  switch (unit.type()) {
    case UnitType.City:
      return 25_000 * level;
    case UnitType.DefensePost:
      return 5_000 * level;
    case UnitType.MissileSilo:
      return 50_000 * level;
    case UnitType.Port:
      return 15_000 * level;
    case UnitType.Factory:
      return 15_000 * level;
    case UnitType.Airfield:
      return 30_000 * level;
    case UnitType.AADefense:
      return 10_000 * level;
    case UnitType.RailDepot:
      return 15_000 * level;
    default:
      return 0;
  }
}

/** Mean-shift steps that pull a blast centre onto a cluster of structures. */
const CLUSTER_STEPS = 2;

/**
 * Blast centres that catch as much as possible at once: from each of
 * owner's structures, moved CLUSTER_STEPS times to the value-weighted centre
 * of owner's structures within radius.
 */
export function structureClusterCentres(
  game: Game,
  owner: Player,
  structures: Unit[],
  radius: number,
): TileRef[] {
  const centres = new Set<TileRef>();
  for (const structure of structures) {
    let centre = structure.tile();
    for (let step = 0; step < CLUSTER_STEPS; step++) {
      let weight = 0;
      let x = 0;
      let y = 0;
      for (const { unit } of game.nearbyUnits(
        centre,
        radius,
        Structures.types,
        ({ unit }) => unit.owner() === owner,
      )) {
        const value = structureNukeValue(unit);
        weight += value;
        x += game.x(unit.tile()) * value;
        y += game.y(unit.tile()) * value;
      }
      if (weight === 0) break;
      const next = game.ref(Math.round(x / weight), Math.round(y / weight));
      if (next === centre) break;
      centre = next;
    }
    centres.add(centre);
  }
  return [...centres];
}
