import { GameFeature, UnitType } from "@openfront/engine-api/game/GameTypes";

/**
 * One-click complexity levels for the lobby. They only touch the units and
 * mechanics openfront v2 added; what the host chose for the classic units
 * (cities, nukes, SAMs …) stays as it is.
 */
export type ComplexityLevel = "classic" | "modern" | "total";

export const COMPLEXITY_LEVELS: ComplexityLevel[] = [
  "classic",
  "modern",
  "total",
];

/** Units openfront v2 added on top of the original game. */
export const V2_UNITS: UnitType[] = [
  UnitType.AADefense,
  UnitType.Airfield,
  UnitType.FighterJet,
  UnitType.Bomber,
  UnitType.AircraftCarrier,
  UnitType.RepairStation,
  UnitType.NuclearSubmarine,
  UnitType.RailDepot,
  UnitType.Tank,
  UnitType.LandMine,
  UnitType.SeaMine,
  UnitType.CruiseMissile,
  UnitType.TransportPlane,
];

export const V2_FEATURES: GameFeature[] = [
  GameFeature.Capital,
  GameFeature.Unrest,
  GameFeature.Secession,
  GameFeature.Politics,
];

/** What each level switches on (everything else from V2_* is off). */
const ENABLED: Record<
  ComplexityLevel,
  { units: UnitType[]; features: GameFeature[] }
> = {
  classic: { units: [], features: [] },
  modern: {
    units: [
      UnitType.AADefense,
      UnitType.Airfield,
      UnitType.FighterJet,
      UnitType.Bomber,
      UnitType.AircraftCarrier,
      // Buildings no longer heal on their own, so bombers need an answer.
      UnitType.RepairStation,
    ],
    features: [GameFeature.Capital],
  },
  total: { units: [...V2_UNITS], features: [...V2_FEATURES] },
};

/** New disabled lists for a level, keeping the host's classic-unit choices. */
export function applyComplexity(
  level: ComplexityLevel,
  disabledUnits: UnitType[],
  disabledFeatures: GameFeature[],
): { disabledUnits: UnitType[]; disabledFeatures: GameFeature[] } {
  const on = ENABLED[level];
  const classicChoices = disabledUnits.filter((u) => !V2_UNITS.includes(u));
  const otherFeatures = disabledFeatures.filter(
    (f) => !V2_FEATURES.includes(f),
  );
  return {
    disabledUnits: [
      ...classicChoices,
      ...V2_UNITS.filter((u) => !on.units.includes(u)),
    ],
    disabledFeatures: [
      ...otherFeatures,
      ...V2_FEATURES.filter((f) => !on.features.includes(f)),
    ],
  };
}

/** The level matching the current lists, or null when it's a custom mix. */
export function detectComplexity(
  disabledUnits: UnitType[],
  disabledFeatures: GameFeature[] | undefined,
): ComplexityLevel | null {
  for (const level of COMPLEXITY_LEVELS) {
    const on = ENABLED[level];
    const unitsMatch = V2_UNITS.every(
      (u) => on.units.includes(u) === !disabledUnits.includes(u),
    );
    const featuresMatch =
      disabledFeatures === undefined ||
      V2_FEATURES.every(
        (f) => on.features.includes(f) === !disabledFeatures.includes(f),
      );
    if (unitsMatch && featuresMatch) return level;
  }
  return null;
}
