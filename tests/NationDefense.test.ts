import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { landingAttackShare } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

let game: Game;
let nation: Player;
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

async function coast(difficulty: Difficulty) {
  // Land at x < 8, sea beyond: the nation holds the north, Bob the south.
  game = await setup(
    "half_land_half_ocean",
    { difficulty, instantBuild: true, spawnImmunityDuration: 0 },
    [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ],
  );
  nation = game.player("nation");
  bob = game.player("bob");
  conquerRect(nation, 0, 0, 8, 8);
  conquerRect(bob, 0, 8, 8, 16);
  nation.addGold(1_000_000_000n);
}

describe("a nation's transport boats", () => {
  test("carry a token crew; the rest follows on landing", async () => {
    await coast(Difficulty.Hard);
    nation.addTroops(100_000 - nation.troops());
    bob.addTroops(1_000);
    game.addExecution(
      new TransportShipExecution(nation, game.ref(7, 13), 50_000),
    );
    executeTicks(game, 2);
    const boats = nation.units(UnitType.TransportShip);
    expect(boats).toHaveLength(1);
    // 1 % at sea, the rest still at home.
    expect(boats[0].troops()).toBe(500);
    expect(nation.troops()).toBeGreaterThan(99_000);

    for (let i = 0; i < 200 && boats[0].isActive(); i++) {
      game.executeNextTick();
    }
    expect(boats[0].isActive()).toBe(false);
    // On landing the other 49 500 joined the attack.
    expect(nation.troops()).toBeLessThan(60_000);
  });

  test("a player's boat still carries everyone", async () => {
    await coast(Difficulty.Hard);
    bob.addTroops(100_000 - bob.troops());
    game.addExecution(new TransportShipExecution(bob, game.ref(7, 3), 50_000));
    executeTicks(game, 2);
    const boats = bob.units(UnitType.TransportShip);
    expect(boats).toHaveLength(1);
    expect(boats[0].troops()).toBe(50_000);
  });
});

describe("a nation guards its stacks", () => {
  let behavior: NationStructureBehavior;

  beforeEach(async () => {
    game = await setup(
      "big_plains",
      { difficulty: Difficulty.Hard, instantBuild: true },
      [
        new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
        new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      ],
    );
    nation = game.player("nation");
    bob = game.player("bob");
    conquerRect(nation, 0, 0, 120, 200);
    conquerRect(bob, 150, 0, 200, 200);
    nation.addGold(1_000_000_000n);
    behavior = new NationStructureBehavior(new PseudoRandom(3), game, nation);
  });

  function think(turns: number) {
    for (let i = 0; i < turns; i++) {
      behavior.handleStructures();
      executeTicks(game, 2);
    }
  }

  function bigCity(x: number, y: number) {
    const city = nation.buildUnit(UnitType.City, game.ref(x, y), {});
    for (let l = 1; l < 12; l++) city.increaseLevel();
    return city;
  }

  test("nothing to guard against while nobody else can nuke", () => {
    const sam = nation.buildUnit(UnitType.SAMLauncher, game.ref(50, 50), {});
    bigCity(55, 50);
    think(5);
    expect(sam.level()).toBe(1);
  });

  test("a big stack gets its SAM stacked once someone has a silo", () => {
    bob.buildUnit(UnitType.MissileSilo, game.ref(180, 100), {});
    const sam = nation.buildUnit(UnitType.SAMLauncher, game.ref(50, 50), {});
    bigCity(55, 50);
    think(10);
    // 12 city levels at 8 per SAM level on Hard: 2 levels wanted.
    expect(sam.level()).toBeGreaterThanOrEqual(2);
    expect(sam.level()).toBeLessThanOrEqual(6);
  });

  test("an unguarded stack gets a SAM of its own", () => {
    bob.buildUnit(UnitType.MissileSilo, game.ref(180, 100), {});
    const city = bigCity(60, 100);
    think(10);
    const range = game.config().samRange(1);
    expect(
      nation
        .units(UnitType.SAMLauncher)
        .some(
          (s) =>
            game.euclideanDistSquared(s.tile(), city.tile()) <= range * range,
        ),
    ).toBe(true);
    // And only as many as it takes, no SAM spam.
    expect(nation.units(UnitType.SAMLauncher).length).toBeLessThanOrEqual(4);
  });
});

describe("a nation defends its waters", () => {
  test("Hard sends a warship at an enemy fleet off its port", async () => {
    await coast(Difficulty.Hard);
    nation.buildUnit(UnitType.Port, game.ref(7, 4), {});
    bob.buildUnit(UnitType.Port, game.ref(7, 12), {});
    bob.buildUnit(UnitType.Warship, game.ref(10, 4), {
      patrolTile: game.ref(10, 4),
    });
    const random = new PseudoRandom(1);
    const warships = new NationWarshipBehavior(
      random,
      game,
      nation,
      new NationEmojiBehavior(random, game, nation),
    );
    warships.defendWaters();
    executeTicks(game, 3);
    expect(nation.unitsConstructed(UnitType.Warship)).toBeGreaterThanOrEqual(1);
  });

  test("Medium leaves it to its usual retaliation", async () => {
    await coast(Difficulty.Medium);
    nation.buildUnit(UnitType.Port, game.ref(7, 4), {});
    bob.buildUnit(UnitType.Port, game.ref(7, 12), {});
    bob.buildUnit(UnitType.Warship, game.ref(10, 4), {
      patrolTile: game.ref(10, 4),
    });
    const random = new PseudoRandom(1);
    const warships = new NationWarshipBehavior(
      random,
      game,
      nation,
      new NationEmojiBehavior(random, game, nation),
    );
    warships.defendWaters();
    executeTicks(game, 3);
    expect(nation.unitsConstructed(UnitType.Warship)).toBe(0);
  });
});

describe("a landed nation boat follows up with a normal attack", () => {
  const home = 100_000;
  test("20-40 % against an enemy it can't simply overrun", () => {
    // Much stronger enemy: 40 %, not everything
    expect(landingAttackShare(home, 3 * home, false)).toBeCloseTo(0.4);
    // Equal enemy: 40 % (overrunning it would take 125 %)
    expect(landingAttackShare(home, home, false)).toBeCloseTo(0.4);
    // Free land: 20 %
    expect(landingAttackShare(home, null, false)).toBeCloseTo(0.2);
  });

  test("up to 80 % to overrun a weaker enemy whole, never 100 %", () => {
    // 60k defenders: 75k overruns them
    expect(landingAttackShare(home, 60_000, false)).toBeCloseTo(0.75);
    // A tiny enemy needs little, but at least 20 % goes
    expect(landingAttackShare(home, 5_000, false)).toBeCloseTo(0.21);
    for (const enemy of [0, 1_000, 30_000, 63_000, 64_000, 70_000, 1e7]) {
      const share = landingAttackShare(home, enemy, false);
      expect(share).toBeGreaterThanOrEqual(0.2);
      expect(share).toBeLessThanOrEqual(0.8);
    }
  });

  test("keeps troops home while someone else attacks it", () => {
    expect(landingAttackShare(home, 60_000, true)).toBeCloseTo(0.3);
  });
});
