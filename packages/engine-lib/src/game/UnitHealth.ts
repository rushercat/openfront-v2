// Shared structure-health math. Lives in engine-lib so the engine and the
// renderer derive the same effective max health for an upgraded structure.

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import type { UnitLike } from "@openfront/engine-api/game/ReadViews";
import { pow } from "../DetMath";

/**
 * Max health of each structure at level 1. Aircraft wear a structure down;
 * a nuke still destroys it outright.
 */
export const STRUCTURE_BASE_HEALTH = {
  [UnitType.City]: 300,
  // Factories got sturdier with their buff: they are worth bombing now.
  [UnitType.Factory]: 400,
  [UnitType.Port]: 300,
  [UnitType.SAMLauncher]: 300,
  [UnitType.MissileSilo]: 400,
  [UnitType.AADefense]: 400,
  [UnitType.Airfield]: 400,
  [UnitType.RailDepot]: 400,
  [UnitType.RepairStation]: 400,
  [UnitType.DefensePost]: 500,
  [UnitType.Capital]: 800,
} as const satisfies Partial<Record<UnitType, number>>;

/** Level 1 max health of a structure type, undefined for anything else. */
export function structureBaseHealth(type: UnitType): number | undefined {
  return (STRUCTURE_BASE_HEALTH as Partial<Record<UnitType, number>>)[type];
}

/**
 * How fast a structure's max health grows with its level: base * level^0.6.
 * Every level adds health, but each one adds less than the one before
 * (level 2 = 1.5x, level 5 = 2.6x, level 10 = 4x, level 20 = 6x).
 */
const LEVEL_HEALTH_EXPONENT = 0.6;

/**
 * Effective max health of a structure of `baseMaxHealth` at `level`. Returns
 * `baseMaxHealth` unchanged at level 1 (and therefore for every unit that has
 * no levels). Uses DetMath.pow, so every client floors the same value.
 */
export function maxHealthAtLevel(baseMaxHealth: number, level: number): number {
  if (level <= 1) {
    return baseMaxHealth;
  }
  return Math.floor(baseMaxHealth * pow(level, LEVEL_HEALTH_EXPONENT));
}

/**
 * How intact a structure is, from 0 (about to fall) to 1 (full health).
 * Damaged structures earn and hold less in proportion (cities hold fewer
 * troops, factories spawn fewer trains, ports and stations pay out less), and
 * they no longer heal on their own: only a Repair Station mends them.
 * Anything without structure health counts as intact.
 */
export function structureHealthFraction(unit: UnitLike): number {
  const base = structureBaseHealth(unit.type());
  if (base === undefined || !unit.hasHealth()) {
    return 1;
  }
  const max = maxHealthAtLevel(base, unit.level());
  if (max <= 0) return 1;
  const fraction = unit.health() / max;
  return fraction >= 1 ? 1 : fraction <= 0 ? 0 : fraction;
}
