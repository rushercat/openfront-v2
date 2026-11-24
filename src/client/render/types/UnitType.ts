/**
 * Canonical unit type string constants.
 *
 * These match the strings the upstream game sends in UnitEventUpdate.unitType.
 * Use these instead of raw string literals to prevent typos and enable
 * find-all-references.
 */

// ---------------------------------------------------------------------------
// Individual unit type constants
// ---------------------------------------------------------------------------

// Mobile units
export const UT_TRANSPORT = "Transport" as const;
export const UT_TRADE_SHIP = "Trade Ship" as const;
export const UT_WARSHIP = "Warship" as const;
export const UT_ATOM_BOMB = "Atom Bomb" as const;
export const UT_HYDROGEN_BOMB = "Hydrogen Bomb" as const;
export const UT_MIRV = "MIRV" as const;
export const UT_SAM_MISSILE = "SAMMissile" as const;
export const UT_SHELL = "Shell" as const;
export const UT_MIRV_WARHEAD = "MIRV Warhead" as const;
export const UT_TRAIN = "Train" as const;
export const UT_FIGHTER_JET = "Fighter Jet" as const;
export const UT_BOMBER = "Bomber" as const;
export const UT_NUCLEAR_SUBMARINE = "Nuclear Submarine" as const;
export const UT_TANK = "Tank" as const;
export const UT_LAND_MINE = "Land Mine" as const;
export const UT_SEA_MINE = "Sea Mine" as const;
export const UT_AIRCRAFT_CARRIER = "Aircraft Carrier" as const;
export const UT_CRUISE_MISSILE = "Cruise Missile" as const;
export const UT_TRANSPORT_PLANE = "Transport Plane" as const;

// Structures
export const UT_CITY = "City" as const;
export const UT_PORT = "Port" as const;
export const UT_FACTORY = "Factory" as const;
export const UT_DEFENSE_POST = "Defense Post" as const;
export const UT_SAM_LAUNCHER = "SAM Launcher" as const;
export const UT_MISSILE_SILO = "Missile Silo" as const;
export const UT_AA_DEFENSE = "AA Defense" as const;
export const UT_AIRFIELD = "Airfield" as const;
export const UT_RAIL_DEPOT = "Rail Depot" as const;
export const UT_REPAIR_STATION = "Repair Station" as const;
export const UT_CAPITAL = "Capital" as const;

// ---------------------------------------------------------------------------
// Derived sets
// ---------------------------------------------------------------------------

export const STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_AA_DEFENSE,
  UT_AIRFIELD,
  UT_RAIL_DEPOT,
  UT_REPAIR_STATION,
  UT_CAPITAL,
]);

/** Units whose sprite is turned to face where they move (UnitPass). */
export const HEADING_TYPES: ReadonlySet<string> = new Set([
  UT_FIGHTER_JET,
  UT_BOMBER,
  UT_TANK,
  UT_CRUISE_MISSILE,
  UT_TRANSPORT_PLANE,
]);

/**
 * Units no one but their owner sees: mines always, a nuclear submarine while
 * submerged (GameView keeps them out of the renderer's unit map).
 */
export const HIDDEN_UNIT_TYPES: ReadonlySet<string> = new Set([
  UT_LAND_MINE,
  UT_SEA_MINE,
  UT_NUCLEAR_SUBMARINE,
]);

/** Planes: drawn above structures, turned to face where they fly, and
 *  interpolated lastPos→pos each render frame (UnitPass). */
export const AIRCRAFT_TYPES: ReadonlySet<string> = new Set([
  UT_FIGHTER_JET,
  UT_BOMBER,
  UT_CRUISE_MISSILE,
  UT_TRANSPORT_PLANE,
]);

export const NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
]);

/** Nuke types whose rendered position is interpolated lastPos→pos each render
 *  frame (UnitPass). Their trails stamp only up to lastPos so the tail never
 *  leads the smoothly-moving missile. */
export const SMOOTHED_NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
]);

/** Units that leave a trail on the map (TrailManager). */
export const TRAIL_TYPES: ReadonlySet<string> = new Set([
  UT_TRANSPORT,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
]);

/** Blast radii (in tiles) matching upstream DefaultConfig.nukeMagnitudes(). */
export const NUKE_MAGNITUDES: Readonly<
  Record<string, { inner: number; outer: number }>
> = {
  [UT_ATOM_BOMB]: { inner: 12, outer: 30 },
  [UT_HYDROGEN_BOMB]: { inner: 80, outer: 100 },
  [UT_MIRV_WARHEAD]: { inner: 12, outer: 18 },
};

// ---------------------------------------------------------------------------
// Ordered lists (atlas column order — used by GPU passes + header)
// ---------------------------------------------------------------------------

/** All unit type strings in the canonical order used by RendererConfig.unitTypes. */
export const ALL_UNIT_TYPES = [
  UT_TRANSPORT,
  UT_TRADE_SHIP,
  UT_WARSHIP,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_MIRV_WARHEAD,
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_TRAIN,
  UT_AA_DEFENSE,
  UT_AIRFIELD,
  UT_FIGHTER_JET,
  UT_BOMBER,
  UT_NUCLEAR_SUBMARINE,
  UT_RAIL_DEPOT,
  UT_TANK,
  UT_LAND_MINE,
  UT_SEA_MINE,
  UT_REPAIR_STATION,
  UT_AIRCRAFT_CARRIER,
  UT_CRUISE_MISSILE,
  UT_TRANSPORT_PLANE,
  UT_CAPITAL,
] as const;
