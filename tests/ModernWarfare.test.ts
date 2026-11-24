import {
  Difficulty,
  GameFeature,
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  CapitalExecution,
  CapitalSystemExecution,
} from "@openfront/engine/execution/CapitalExecution";
import {
  ConstructionExecution,
  structureExecution,
} from "@openfront/engine/execution/ConstructionExecution";
import { handleNationModernWarfare } from "@openfront/engine/execution/nation/NationModernWarfareBehavior";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { UnrestExecution } from "@openfront/engine/execution/UnrestExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

const MAP = "big_plains";

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

function build(owner: Player, type: UnitType, x: number, y: number) {
  game.addExecution(new ConstructionExecution(owner, type, game.ref(x, y)));
  executeTicks(game, 2);
}

function runUntil(done: () => boolean, maxTicks: number): number {
  for (let i = 0; i < maxTicks; i++) {
    if (done()) return i;
    game.executeNextTick();
  }
  return maxTicks;
}

/** Alice holds the west of the plains, Bob the east; they meet at x = 100. */
async function plains(config: Partial<GameConfig> = {}) {
  game = await setup(
    MAP,
    { instantBuild: true, spawnImmunityDuration: 0, ...config },
    [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ],
  );
  alice = game.player("alice");
  bob = game.player("bob");
  conquerRect(alice, 0, 40, 100, 100);
  conquerRect(bob, 100, 40, 200, 100);
  alice.addGold(100_000_000n);
  bob.addGold(100_000_000n);
  // The conquests above were from nobody, but start everyone calm anyway.
  alice.setUnrest(0);
  bob.setUnrest(0);
}

describe("cruise missiles", () => {
  test("need a ready missile silo and an enemy target", async () => {
    await plains();
    expect(alice.canBuild(UnitType.CruiseMissile, game.ref(150, 70))).toBe(
      false,
    );
    build(alice, UnitType.MissileSilo, 30, 70);
    expect(alice.canBuild(UnitType.CruiseMissile, game.ref(150, 70))).not.toBe(
      false,
    );
    // Not on its own land.
    expect(alice.canBuild(UnitType.CruiseMissile, game.ref(50, 70))).toBe(
      false,
    );
  });

  test("wear down the structure they hit, and half as much around it", async () => {
    await plains();
    build(alice, UnitType.MissileSilo, 30, 70);
    const city = bob.buildUnit(UnitType.City, game.ref(150, 70), {});
    const post = bob.buildUnit(UnitType.DefensePost, game.ref(153, 70), {});
    const far = bob.buildUnit(UnitType.City, game.ref(180, 70), {});
    const goldBefore = alice.gold();
    build(alice, UnitType.CruiseMissile, 150, 70);
    expect(alice.gold()).toBeLessThan(goldBefore);
    expect(game.units(UnitType.CruiseMissile).length).toBe(1);
    runUntil(() => game.units(UnitType.CruiseMissile).length === 0, 100);
    expect(game.units(UnitType.CruiseMissile).length).toBe(0);
    const damage = game.config().cruiseMissileDamage();
    expect(city.maxHealth() - city.health()).toBe(damage);
    expect(post.maxHealth() - post.health()).toBe(Math.floor(damage / 2));
    expect(far.health()).toBe(far.maxHealth());
    // It ruins no land.
    expect(game.owner(game.ref(150, 70))).toBe(bob);
  });

  test("a SAM can shoot one down", async () => {
    await plains();
    build(alice, UnitType.MissileSilo, 30, 70);
    const city = bob.buildUnit(UnitType.City, game.ref(150, 70), {});
    const sam = bob.buildUnit(UnitType.SAMLauncher, game.ref(146, 72), {});
    game.addExecution(structureExecution(sam));
    build(alice, UnitType.CruiseMissile, 150, 70);
    expect(game.units(UnitType.CruiseMissile).length).toBe(1);
    runUntil(() => game.units(UnitType.CruiseMissile).length === 0, 100);
    expect(city.health()).toBe(city.maxHealth());
  });
});

describe("paratroopers", () => {
  test("need an airfield or carrier within air range", async () => {
    await plains();
    expect(alice.canBuild(UnitType.TransportPlane, game.ref(150, 70))).toBe(
      false,
    );
    build(alice, UnitType.Airfield, 30, 70);
    expect(alice.canBuild(UnitType.TransportPlane, game.ref(150, 70))).not.toBe(
      false,
    );
    expect(alice.canBuild(UnitType.TransportPlane, game.ref(50, 70))).toBe(
      false,
    );
  });

  test("take the land they drop on and attack from there", async () => {
    await plains();
    alice.addTroops(200_000);
    build(alice, UnitType.Airfield, 30, 70);
    const before = alice.troops();
    game.addExecution(
      new ConstructionExecution(
        alice,
        UnitType.TransportPlane,
        game.ref(170, 70),
        undefined,
        undefined,
        50_000,
      ),
    );
    executeTicks(game, 2);
    const planes = alice.units(UnitType.TransportPlane);
    expect(planes.length).toBe(1);
    expect(planes[0].troops()).toBe(50_000);
    expect(alice.troops()).toBeLessThanOrEqual(before - 50_000 + 1000);
    runUntil(() => alice.units(UnitType.TransportPlane).length === 0, 200);
    expect(alice.units(UnitType.TransportPlane).length).toBe(0);
    expect(game.owner(game.ref(170, 70))).toBe(alice);
    expect(alice.outgoingAttacks().some((a) => a.target() === bob)).toBe(true);
  });

  test("are lost with their plane when it is shot down", async () => {
    await plains();
    alice.addTroops(200_000);
    build(alice, UnitType.Airfield, 30, 70);
    game.addExecution(
      new ConstructionExecution(
        alice,
        UnitType.TransportPlane,
        game.ref(170, 70),
        undefined,
        undefined,
        50_000,
      ),
    );
    executeTicks(game, 3);
    const plane = alice.units(UnitType.TransportPlane)[0];
    const troops = alice.troops();
    plane.delete(true, bob);
    executeTicks(game, 200);
    expect(game.owner(game.ref(170, 70))).toBe(bob);
    // Nothing came back.
    expect(alice.troops()).toBeLessThan(troops + 50_000);
  });
});

describe("aircraft carrier", () => {
  test("is built at a port, sails, and works as an airfield at sea", async () => {
    game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
    ]);
    alice = game.player("alice");
    alice.addGold(100_000_000n);
    conquerRect(alice, 0, 0, 8, 16);
    alice.buildUnit(UnitType.Port, game.ref(7, 8), {});
    expect(alice.canBuild(UnitType.FighterJet, game.ref(4, 4))).toBe(false);
    build(alice, UnitType.AircraftCarrier, 12, 8);
    const carriers = alice.units(UnitType.AircraftCarrier);
    expect(carriers.length).toBe(1);
    runUntil(
      () => game.euclideanDistSquared(carriers[0].tile(), game.ref(12, 8)) <= 4,
      200,
    );
    expect(
      game.euclideanDistSquared(carriers[0].tile(), game.ref(12, 8)),
    ).toBeLessThanOrEqual(4);
    // Aircraft take off from it.
    expect(alice.canBuild(UnitType.FighterJet, game.ref(4, 4))).not.toBe(false);
  });
});

describe("capital", () => {
  async function withCapitals(config: Partial<GameConfig> = {}) {
    await plains(config);
    alice.setSpawnTile(game.ref(30, 70));
    bob.setSpawnTile(game.ref(170, 70));
    game.addExecution(new PlayerExecution(alice), new PlayerExecution(bob));
    game.addExecution(new CapitalSystemExecution());
  }

  test("every player gets one for free at its spawn", async () => {
    await withCapitals();
    const gold = alice.gold();
    executeTicks(game, 12);
    const capital = alice.capital();
    expect(capital).not.toBeNull();
    expect(game.manhattanDist(capital!.tile(), game.ref(30, 70))).toBeLessThan(
      15,
    );
    expect(bob.capital()).not.toBeNull();
    // Free (gold only went up from income).
    expect(alice.gold()).toBeGreaterThanOrEqual(gold);
  });

  test("gives more troop growth and gold while it stands", async () => {
    await plains();
    alice.addTroops(50_000);
    const troopsWithout = game.config().troopIncreaseRate(alice);
    const goldWithout = game.config().goldAdditionRate(alice);
    const capital = alice.buildUnit(UnitType.Capital, game.ref(30, 70), {});
    expect(capital.isUnderConstruction()).toBe(false);
    const troopsWith = game.config().troopIncreaseRate(alice);
    const goldWith = game.config().goldAdditionRate(alice);
    expect(troopsWith / troopsWithout).toBeCloseTo(1.25, 2);
    expect(Number(goldWith) / Number(goldWithout)).toBeCloseTo(1.1, 1);
  });

  test("building a new one moves it, for a price", async () => {
    await withCapitals();
    executeTicks(game, 12);
    const old = alice.capital()!;
    const gold = alice.gold();
    build(alice, UnitType.Capital, 70, 50);
    executeTicks(game, 3);
    expect(old.isActive()).toBe(false);
    const moved = alice.capital();
    expect(moved).not.toBeNull();
    expect(game.manhattanDist(moved!.tile(), game.ref(70, 50))).toBeLessThan(
      15,
    );
    expect(alice.units(UnitType.Capital).length).toBe(1);
    expect(alice.gold()).toBeLessThan(gold);
    // A move is no loss.
    expect(alice.capitalLostUntil()).toBe(-1);
  });

  test("a fallen capital takes its bonuses away for a few minutes", async () => {
    await withCapitals();
    executeTicks(game, 12);
    const capital = alice.capital()!;
    bob.conquer(capital.tile());
    executeTicks(game, 3);
    expect(capital.isActive()).toBe(false);
    expect(alice.capital()).toBeNull();
    const until = alice.capitalLostUntil();
    expect(until).toBeGreaterThan(game.ticks());
    expect(alice.canBuild(UnitType.Capital, game.ref(30, 60))).toBe(false);
    executeTicks(game, 100);
    expect(alice.capital()).toBeNull();
    executeTicks(game, until - game.ticks() + 12);
    expect(alice.capital()).not.toBeNull();
  });

  test("can be switched off", async () => {
    await withCapitals({ disabledFeatures: [GameFeature.Capital] });
    executeTicks(game, 12);
    expect(alice.capital()).toBeNull();
    expect(game.config().isUnitDisabled(UnitType.Capital)).toBe(true);
    expect(alice.canBuild(UnitType.Capital, game.ref(30, 70))).toBe(false);
  });
});

describe("unrest", () => {
  test("comes with land taken from other players, not from tribes", async () => {
    await plains();
    game.addPlayer(new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"));
    const tribe = game.player("tribe");
    conquerRect(tribe, 0, 0, 20, 20);
    conquerRect(alice, 0, 0, 20, 20);
    expect(alice.unrest()).toBe(0);
    conquerRect(alice, 100, 40, 110, 100);
    expect(alice.unrest()).toBe(600);
    expect(alice.unrestShare()).toBeCloseTo(600 / alice.numTilesOwned(), 5);
  });

  test("costs troop growth and gold, and calms down over time", async () => {
    await plains();
    alice.addTroops(50_000);
    const calm = game.config().troopIncreaseRate(alice);
    const calmGold = game.config().goldAdditionRate(alice);
    alice.setUnrest(alice.numTilesOwned());
    expect(game.config().troopIncreaseRate(alice) / calm).toBeCloseTo(0.5, 2);
    expect(Number(game.config().goldAdditionRate(alice))).toBeLessThan(
      Number(calmGold),
    );
    game.addExecution(new UnrestExecution("game"));
    const start = alice.unrest();
    executeTicks(game, game.config().unrestHalfLifeTicks());
    expect(alice.unrest() / start).toBeGreaterThan(0.45);
    expect(alice.unrest() / start).toBeLessThan(0.55);
  });

  test("can be switched off", async () => {
    await plains({ disabledFeatures: [GameFeature.Unrest] });
    conquerRect(alice, 100, 40, 110, 100);
    expect(alice.unrest()).toBe(0);
  });

  test("at the extreme, a quarter of the empire breaks away as a new nation", async () => {
    await plains();
    game.addExecution(new PlayerExecution(alice), new PlayerExecution(bob));
    game.addExecution(new UnrestExecution("game"));
    executeTicks(game, game.config().secessionEarliestTick());
    const tiles = alice.numTilesOwned();
    expect(tiles).toBeGreaterThanOrEqual(game.config().secessionMinTiles());
    const players = game.players().length;
    // Keep the whole empire restless through the warning.
    for (
      let i = 0;
      i < game.config().secessionWarningTicks() + 20 &&
      game.players().length === players;
      i++
    ) {
      alice.setUnrest(alice.numTilesOwned());
      game.executeNextTick();
    }
    const rebels = game
      .players()
      .filter(
        (p) => p !== alice && p !== bob && p.type() === PlayerType.Nation,
      );
    expect(rebels.length).toBe(1);
    const rebel = rebels[0];
    const share = game.config().secessionLandShare();
    expect(rebel.numTilesOwned()).toBeGreaterThan(tiles * share * 0.9);
    expect(alice.numTilesOwned()).toBeLessThan(tiles * (1 - share * 0.9));
    expect(rebel.troops()).toBeGreaterThan(0);
    expect(rebel.unrest()).toBe(0);
    // It is an AI nation of its own, at war with nobody yet.
    expect(rebel.isFriendly(alice)).toBe(false);
  });

  test("no secession in team games", async () => {
    await plains({ gameMode: GameMode.Team, playerTeams: 2 });
    game.addExecution(new UnrestExecution("game"));
    executeTicks(game, game.config().secessionEarliestTick());
    const players = game.players().length;
    for (let i = 0; i < game.config().secessionWarningTicks() + 20; i++) {
      alice.setUnrest(alice.numTilesOwned());
      game.executeNextTick();
    }
    expect(game.players().length).toBe(players);
  });
});

describe("nations", () => {
  let nation: Player;

  async function nationVsBob(difficulty: Difficulty) {
    game = await setup(
      MAP,
      { difficulty, instantBuild: true, spawnImmunityDuration: 0 },
      [
        new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
        new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      ],
    );
    nation = game.player("nation");
    bob = game.player("bob");
    conquerRect(nation, 0, 40, 100, 100);
    conquerRect(bob, 100, 40, 200, 100);
    nation.addGold(1_000_000_000n);
    nation.addTroops(2_000_000);
    bob.addTroops(1_000_000);
    // Bob attacks: the nation is at war with him.
    game.addExecution(new AttackExecution(500_000, bob, nation.id(), null));
    executeTicks(game, 2);
  }

  function think(turns: number) {
    for (let i = 0; i < turns; i++) {
      handleNationModernWarfare(game, nation);
      executeTicks(game, 3);
    }
  }

  test("Easy fires no cruise missiles", async () => {
    await nationVsBob(Difficulty.Easy);
    build(nation, UnitType.MissileSilo, 20, 70);
    bob.buildUnit(UnitType.Factory, game.ref(160, 70), {});
    think(3);
    expect(nation.unitsConstructed(UnitType.CruiseMissile)).toBe(0);
  });

  test("Hard fires cruise missiles at the enemy's structures", async () => {
    await nationVsBob(Difficulty.Hard);
    build(nation, UnitType.MissileSilo, 20, 70);
    bob.buildUnit(UnitType.Factory, game.ref(160, 70), {});
    think(3);
    expect(nation.unitsConstructed(UnitType.CruiseMissile)).toBeGreaterThan(0);
  });

  test("no cruise missile into a loaded SAM, not even on Impossible", async () => {
    await nationVsBob(Difficulty.Impossible);
    build(nation, UnitType.MissileSilo, 20, 70);
    bob.buildUnit(UnitType.Factory, game.ref(160, 70), {});
    bob.buildUnit(UnitType.SAMLauncher, game.ref(165, 70), {});
    think(3);
    expect(nation.unitsConstructed(UnitType.CruiseMissile)).toBe(0);
  });

  test("Impossible fires while the SAM guarding the target reloads", async () => {
    await nationVsBob(Difficulty.Impossible);
    build(nation, UnitType.MissileSilo, 20, 70);
    bob.buildUnit(UnitType.Factory, game.ref(160, 70), {});
    const sam = bob.buildUnit(UnitType.SAMLauncher, game.ref(165, 70), {});
    // Its only missile just went.
    sam.launch();
    think(1);
    expect(nation.unitsConstructed(UnitType.CruiseMissile)).toBe(1);
  });

  test("Hard waits for a reloading SAM instead of gambling", async () => {
    await nationVsBob(Difficulty.Hard);
    build(nation, UnitType.MissileSilo, 20, 70);
    bob.buildUnit(UnitType.Factory, game.ref(160, 70), {});
    const sam = bob.buildUnit(UnitType.SAMLauncher, game.ref(165, 70), {});
    sam.launch();
    think(1);
    expect(nation.unitsConstructed(UnitType.CruiseMissile)).toBe(0);
  });

  test("no cruise missile into a carrier's SAM either", async () => {
    await nationVsBob(Difficulty.Impossible);
    build(nation, UnitType.MissileSilo, 20, 70);
    bob.buildUnit(UnitType.Factory, game.ref(160, 70), {});
    // Only where it is matters for its SAM (the plains have no sea).
    const carrier = bob.buildUnit(
      UnitType.AircraftCarrier,
      game.ref(170, 70),
      { patrolTile: game.ref(170, 70) },
    );
    think(3);
    expect(nation.unitsConstructed(UnitType.CruiseMissile)).toBe(0);
    // Without it, the factory is fair game.
    carrier.delete();
    think(3);
    expect(nation.unitsConstructed(UnitType.CruiseMissile)).toBeGreaterThan(0);
  });

  test("Impossible drops paratroopers on an enemy city", async () => {
    await nationVsBob(Difficulty.Impossible);
    build(nation, UnitType.Airfield, 20, 70);
    bob.buildUnit(UnitType.City, game.ref(170, 70), {});
    think(2);
    const planes = nation.units(UnitType.TransportPlane);
    expect(planes.length).toBe(1);
    expect(planes[0].targetTile()).toBe(game.ref(170, 70));
  });

  test("Medium drops no paratroopers", async () => {
    await nationVsBob(Difficulty.Medium);
    build(nation, UnitType.Airfield, 20, 70);
    bob.buildUnit(UnitType.City, game.ref(170, 70), {});
    think(2);
    expect(nation.units(UnitType.TransportPlane).length).toBe(0);
  });

  test("Hard moves its capital away from the front", async () => {
    await nationVsBob(Difficulty.Hard);
    const capital = nation.buildUnit(UnitType.Capital, game.ref(95, 70), {});
    game.addExecution(new CapitalExecution(capital));
    build(nation, UnitType.City, 10, 70);
    think(2);

    executeTicks(game, 5);
    expect(capital.isActive()).toBe(false);
    const moved = nation.capital();
    expect(moved).not.toBeNull();
    expect(game.x(moved!.tile())).toBeLessThan(40);
  });
});

test("snapshots keep carriers, missiles, planes, capitals and unrest", async () => {
  await plains();
  alice.addTroops(200_000);
  alice.setSpawnTile(game.ref(30, 70));
  bob.setSpawnTile(game.ref(170, 70));
  game.addExecution(new PlayerExecution(alice), new PlayerExecution(bob));
  game.addExecution(new CapitalSystemExecution(), new UnrestExecution("game"));
  build(alice, UnitType.MissileSilo, 30, 50);
  build(alice, UnitType.Airfield, 30, 90);
  executeTicks(game, 12);
  bob.buildUnit(UnitType.City, game.ref(150, 70), {});
  build(alice, UnitType.CruiseMissile, 150, 70);
  game.addExecution(
    new ConstructionExecution(
      alice,
      UnitType.TransportPlane,
      game.ref(170, 60),
      undefined,
      undefined,
      20_000,
    ),
  );
  conquerRect(alice, 100, 40, 105, 100);
  executeTicks(game, 2);
  expect(game.units(UnitType.CruiseMissile).length).toBe(1);
  expect(game.units(UnitType.TransportPlane).length).toBe(1);
  expect(alice.unrest()).toBeGreaterThan(0);
  await expectSnapshotRoundTrip(game, MAP, 20);
});
