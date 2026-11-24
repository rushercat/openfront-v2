import { GameFeature, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  DecreeType,
  decreeFactor,
  PoliticsFactor,
} from "@openfront/engine-api/game/Politics";
import { describe, expect, it } from "vitest";
import {
  applyComplexity,
  detectComplexity,
  V2_FEATURES,
  V2_UNITS,
} from "../../src/client/utilities/ComplexityPresets";

describe("complexity presets", () => {
  it("classic switches off every v2 unit and mechanic", () => {
    const r = applyComplexity("classic", [], []);
    expect(new Set(r.disabledUnits)).toEqual(new Set(V2_UNITS));
    expect(new Set(r.disabledFeatures)).toEqual(new Set(V2_FEATURES));
    expect(detectComplexity(r.disabledUnits, r.disabledFeatures)).toBe(
      "classic",
    );
  });

  it("modern keeps air force, carrier, repair and capital", () => {
    const r = applyComplexity("modern", [], []);
    for (const on of [
      UnitType.Airfield,
      UnitType.FighterJet,
      UnitType.Bomber,
      UnitType.AADefense,
      UnitType.AircraftCarrier,
      UnitType.RepairStation,
    ]) {
      expect(r.disabledUnits).not.toContain(on);
    }
    expect(r.disabledUnits).toContain(UnitType.Tank);
    expect(r.disabledFeatures).not.toContain(GameFeature.Capital);
    expect(r.disabledFeatures).toContain(GameFeature.Politics);
    expect(detectComplexity(r.disabledUnits, r.disabledFeatures)).toBe(
      "modern",
    );
  });

  it("keeps the host's choices for the classic units", () => {
    const r = applyComplexity("total", [UnitType.MIRV, UnitType.Tank], []);
    expect(r.disabledUnits).toEqual([UnitType.MIRV]);
    expect(detectComplexity(r.disabledUnits, r.disabledFeatures)).toBe("total");
  });

  it("reports a custom mix as null", () => {
    expect(detectComplexity([UnitType.Tank], [])).toBeNull();
  });
});

describe("decreeFactor", () => {
  it("multiplies the decrees that affect a player", () => {
    const decrees = [
      { decree: DecreeType.WorldBoom, target: null },
      { decree: DecreeType.Scapegoat, target: 7 },
      { decree: DecreeType.FreeTrade, target: null },
      { decree: DecreeType.MarshallPlan, target: null },
    ];
    const weak = new Set([7]);
    expect(decreeFactor(decrees, 7, weak, PoliticsFactor.GoldIncome)).toBe(
      1.25 * 0.8,
    );
    expect(decreeFactor(decrees, 7, weak, PoliticsFactor.TradeGold)).toBe(
      1.25 * 0.8 * 1.5,
    );
    expect(decreeFactor(decrees, 7, weak, PoliticsFactor.TroopGrowth)).toBe(
      0.8 * 1.3,
    );
    expect(decreeFactor(decrees, 3, weak, PoliticsFactor.TroopGrowth)).toBe(1);
  });

  it("sanctions zero the target's trade gold", () => {
    const decrees = [
      { decree: DecreeType.FreeTrade, target: null },
      { decree: DecreeType.Sanctions, target: 2 },
    ];
    expect(decreeFactor(decrees, 2, new Set(), PoliticsFactor.TradeGold)).toBe(
      0,
    );
    expect(decreeFactor(decrees, 1, new Set(), PoliticsFactor.TradeGold)).toBe(
      1.5,
    );
  });
});
