import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { structureHealthFraction } from "@openfront/engine-lib/game/UnitHealth";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

let game: Game;
let alice: Player;
let bob: Player;

function conquerRect(
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      p.conquer(game.ref(x, y));
    }
  }
}

describe("structure damage and repair stations", () => {
  beforeEach(async () => {
    game = await setup(
      "big_plains",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
        new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      ],
    );
    alice = game.player("alice");
    bob = game.player("bob");
    conquerRect(alice, 0, 0, 120, 100);
    conquerRect(bob, 150, 0, 200, 100);
  });

  test("health fraction follows the structure's level", () => {
    const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
    expect(structureHealthFraction(city)).toBe(1);
    city.modifyHealth(-city.maxHealth() / 2, bob);
    expect(structureHealthFraction(city)).toBeCloseTo(0.5, 2);
    // Units without structure health always count as intact.
    const warshipLike = {
      type: () => UnitType.Warship,
      hasHealth: () => true,
      health: () => 1,
      level: () => 1,
    } as unknown as Parameters<typeof structureHealthFraction>[0];
    expect(structureHealthFraction(warshipLike)).toBe(1);
  });

  test("a damaged city holds fewer troops", () => {
    const config = game.config();
    const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
    const full = config.maxTroops(alice);
    const withoutCities = config.maxTroopsWithoutCities(alice);
    expect(full - withoutCities).toBeCloseTo(config.cityTroopIncrease(), 0);
    city.modifyHealth(-city.maxHealth() / 2, bob);
    expect(config.maxTroops(alice) - withoutCities).toBeCloseTo(
      config.cityTroopIncrease() / 2,
      -2,
    );
  });

  test("a damaged city slows troop regeneration", () => {
    const config = game.config();
    const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
    expect(config.damagedCityRegenFactor(alice)).toBe(1);
    city.modifyHealth(-city.maxHealth() / 2, bob);
    expect(config.damagedCityRegenFactor(alice)).toBeCloseTo(0.75, 2);
    // A second, intact city of the same level halves the penalty.
    alice.buildUnit(UnitType.City, game.ref(60, 30), {});
    expect(config.damagedCityRegenFactor(alice)).toBeCloseTo(0.875, 2);
  });

  test("factories produce gold, less when damaged", () => {
    const config = game.config();
    expect(config.factoryGoldRate(alice)).toBe(0n);
    const factory = alice.buildUnit(UnitType.Factory, game.ref(10, 30), {});
    expect(config.factoryGoldRate(alice)).toBe(50n);
    factory.increaseLevel();
    expect(config.factoryGoldRate(alice)).toBe(100n);
    factory.modifyHealth(-factory.maxHealth() / 2, bob);
    expect(Number(config.factoryGoldRate(alice))).toBeCloseTo(50, -1);
  });

  test("a repair station mends damaged structures in its radius", () => {
    game.addExecution(new PlayerExecution(alice));
    const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
    city.modifyHealth(-150, bob);
    const damaged = city.health();
    alice.buildUnit(UnitType.RepairStation, game.ref(40, 30), {});
    executeTicks(game, 25);
    expect(city.health()).toBeGreaterThan(damaged);
    executeTicks(game, 2000);
    expect(city.health()).toBe(city.maxHealth());
  });

  test("a repair station does not reach beyond its radius", () => {
    game.addExecution(new PlayerExecution(alice));
    const range = game.config().repairStationRange(1);
    expect(range).toBe(63);
    const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
    city.modifyHealth(-150, bob);
    const damaged = city.health();
    alice.buildUnit(UnitType.RepairStation, game.ref(10 + 70, 30), {});
    executeTicks(game, 100);
    expect(city.health()).toBe(damaged);
  });

  test("stacking a repair station heals faster and reaches a little further", () => {
    const config = game.config();
    expect(config.repairStationHealPercent(1)).toBe(1);
    expect(config.repairStationHealPercent(3)).toBe(3);
    const r1 = config.repairStationRange(1);
    const r2 = config.repairStationRange(2);
    const r5 = config.repairStationRange(5);
    expect(r2).toBeGreaterThan(r1);
    expect(r5).toBeGreaterThan(r2);
    // Grows only a little with every stack (a SAM gains about 11 at level 2).
    expect(r2 - r1).toBeLessThan(5);
    expect(r5).toBeLessThan(config.maxRepairStationRange());

    game.addExecution(new PlayerExecution(alice));
    // Far enough apart (95 tiles) that each station reaches only its own city.
    const a = alice.buildUnit(UnitType.City, game.ref(5, 2), {});
    const b = alice.buildUnit(UnitType.City, game.ref(100, 2), {});
    a.modifyHealth(-200, bob);
    b.modifyHealth(-200, bob);
    const slow = alice.buildUnit(UnitType.RepairStation, game.ref(5, 10), {});
    const fast = alice.buildUnit(UnitType.RepairStation, game.ref(100, 10), {});
    fast.increaseLevel();
    fast.increaseLevel();
    expect(slow.level()).toBe(1);
    const aBefore = a.health();
    const bBefore = b.health();
    executeTicks(game, 31);
    // 1% vs 3% of 300 health a second, for three seconds.
    expect(a.health() - aBefore).toBe(9);
    expect(b.health() - bBefore).toBe(27);
  });

  test("an enemy repair station does not heal my structures", () => {
    game.addExecution(new PlayerExecution(alice));
    const city = alice.buildUnit(UnitType.City, game.ref(110, 30), {});
    city.modifyHealth(-150, bob);
    const damaged = city.health();
    bob.buildUnit(UnitType.RepairStation, game.ref(160, 30), {});
    executeTicks(game, 100);
    expect(city.health()).toBe(damaged);
  });

  test("repair stations survive a snapshot round trip", async () => {
    game.addExecution(new PlayerExecution(alice));
    const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
    city.modifyHealth(-150, bob);
    alice.buildUnit(UnitType.RepairStation, game.ref(40, 30), {});
    executeTicks(game, 5);
    await expectSnapshotRoundTrip(game, "big_plains", 40);
  });
});

describe("nations and repair stations", () => {
  let nation: Player;
  let behavior: NationStructureBehavior;

  beforeEach(async () => {
    game = await setup(
      "big_plains",
      { instantBuild: true, difficulty: Difficulty.Hard },
      [
        new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
        new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      ],
    );
    nation = game.player("nation");
    bob = game.player("bob");
    conquerRect(nation, 0, 0, 200, 100);
    nation.addGold(1_000_000_000n);
    behavior = new NationStructureBehavior(new PseudoRandom(1), game, nation);
  });

  function think(turns: number) {
    for (let i = 0; i < turns; i++) {
      behavior.handleStructures();
      executeTicks(game, 2);
    }
  }

  test("a station that can't reach the damage is never stacked up", () => {
    // Far beyond any station's reach, even at its maximum.
    const station = nation.buildUnit(
      UnitType.RepairStation,
      game.ref(10, 10),
      {},
    );
    const city = nation.buildUnit(UnitType.City, game.ref(190, 90), {});
    city.modifyHealth(-city.maxHealth() / 2, bob);
    think(40);
    expect(station.level()).toBe(1);
    // It builds a new one by the damage instead (one per 4 cities, plus one).
    for (const s of nation.units(UnitType.RepairStation)) {
      expect(s.level()).toBeLessThanOrEqual(3);
    }
  });

  test("a damaged structure gets a station nearby, and only one", () => {
    const city = nation.buildUnit(UnitType.City, game.ref(100, 50), {});
    city.modifyHealth(-city.maxHealth() / 2, bob);
    think(40);
    const stations = nation.units(UnitType.RepairStation);
    expect(stations.length).toBe(1);
    const range = game.config().repairStationRange(stations[0].level());
    expect(
      game.euclideanDistSquared(stations[0].tile(), city.tile()),
    ).toBeLessThanOrEqual(range * range);
    expect(stations[0].level()).toBeLessThanOrEqual(3);
  });
});
