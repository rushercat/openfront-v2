import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";

import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { FactoryExecution } from "@openfront/engine/execution/FactoryExecution";
import { MineExecution } from "@openfront/engine/execution/MineExecution";
import { MoveWarshipExecution } from "@openfront/engine/execution/MoveWarshipExecution";
import { SurfaceSubmarineExecution } from "@openfront/engine/execution/NuclearSubmarineExecution";
import { RailDepotExecution } from "@openfront/engine/execution/RailDepotExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
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

/** Buys a unit the way the build menu does and returns the new one. */
function buy(
  owner: Player,
  type: UnitType,
  x: number,
  y: number,
): Unit | undefined {
  const before = new Set(owner.units(type));
  game.addExecution(new ConstructionExecution(owner, type, game.ref(x, y)));
  executeTicks(game, 3);
  return owner.units(type).find((u) => !before.has(u));
}

function runUntil(done: () => boolean, maxTicks: number): number {
  for (let i = 0; i < maxTicks; i++) {
    if (done()) return i;
    game.executeNextTick();
  }
  return maxTicks;
}

async function plains() {
  game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true, spawnImmunityDuration: 0 },
    [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ],
  );
  alice = game.player("alice");
  bob = game.player("bob");
  // Alice holds the west, Bob the east; their land meets at x = 120.
  conquerRect(alice, 0, 40, 120, 80);
  conquerRect(bob, 120, 40, 200, 80);
}

/** 16x16: land at x 0-7, water at x 8-15. */
async function coast() {
  game = await setup(
    "half_land_half_ocean",
    { infiniteGold: true, instantBuild: true, spawnImmunityDuration: 0 },
    [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ],
  );
  alice = game.player("alice");
  bob = game.player("bob");
  conquerRect(alice, 0, 0, 8, 8);
  conquerRect(bob, 0, 8, 8, 16);
  executeTicks(game, 5);
}

describe("airfield range and cap", () => {
  beforeEach(plains);

  test("an airfield level holds five aircraft of any mix", () => {
    const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
    expect(game.config().aircraftPerAirfieldLevel()).toBe(5);
    for (let i = 0; i < 2; i++) {
      expect(buy(alice, UnitType.FighterJet, 40, 50)).toBeDefined();
    }
    for (let i = 0; i < 3; i++) {
      expect(buy(alice, UnitType.Bomber, 40, 50)).toBeDefined();
    }
    expect(buy(alice, UnitType.FighterJet, 40, 50)).toBeUndefined();
    airfield.increaseLevel();
    expect(buy(alice, UnitType.FighterJet, 40, 50)).toBeDefined();
  });

  test("stacking an airfield widens its range", () => {
    const config = game.config();
    expect(config.airfieldRange(1)).toBe(300);
    expect(config.airfieldRange(2)).toBeGreaterThan(config.airfieldRange(1));
    expect(config.airfieldRange(5)).toBeGreaterThan(config.airfieldRange(2));
  });

  describe("with a short range", () => {
    beforeEach(() => {
      // big_plains is narrower than a real airfield's reach.
      vi.spyOn(game.config(), "airfieldRange").mockImplementation(
        (level: number) => 40 + 20 * (level - 1),
      );
    });

    test("an order beyond the range ends at its edge", () => {
      const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const fighter = buy(alice, UnitType.FighterJet, 150, 50)!;
      const patrol = fighter.warshipState().patrolTile!;
      expect(
        game.euclideanDistSquared(patrol, airfield.tile()),
      ).toBeLessThanOrEqual(40 ** 2);
      expect(game.x(patrol)).toBeGreaterThan(50);

      // A stacked airfield reaches further.
      airfield.increaseLevel();
      game.addExecution(
        new MoveWarshipExecution(alice, [fighter.id()], game.ref(150, 50)),
      );
      executeTicks(game, 1);
      expect(game.x(fighter.warshipState().patrolTile!)).toBeGreaterThan(70);
    });

    test("a fighter does not chase targets outside the range", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const fighter = buy(alice, UnitType.FighterJet, 55, 50)!;
      const bomber = bob.buildUnit(UnitType.Bomber, game.ref(100, 50), {
        patrolTile: game.ref(100, 50),
      });
      for (let i = 0; i < 60; i++) {
        game.executeNextTick();
        expect(fighter.targetUnit()).not.toBe(bomber);
      }
      expect(bomber.health()).toBe(bomber.maxHealth());
    });

    test("a plane whose airfield is lost flies back into the range of another", () => {
      const west = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      alice.buildUnit(UnitType.Airfield, game.ref(100, 50), {});
      const bomber = buy(alice, UnitType.Bomber, 20, 60)!;
      west.delete();
      executeTicks(game, 15);
      const patrol = bomber.warshipState().patrolTile!;
      expect(
        game.euclideanDistSquared(patrol, game.ref(100, 50)),
      ).toBeLessThanOrEqual(40 ** 2);
    });
  });

  test("without any airfield a plane runs dry", () => {
    const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
    const fighter = buy(alice, UnitType.FighterJet, 40, 50)!;
    airfield.delete();
    executeTicks(game, 50);
    expect(fighter.health()).toBeLessThan(fighter.maxHealth());
    executeTicks(game, 250);
    expect(fighter.isActive()).toBe(false);
  });
});

describe("mines", () => {
  describe("land mine", () => {
    beforeEach(plains);

    test("goes on its owner's land only, and not next to another mine", () => {
      expect(alice.canBuild(UnitType.LandMine, game.ref(50, 50))).not.toBe(
        false,
      );
      expect(alice.canBuild(UnitType.LandMine, game.ref(150, 50))).toBe(false);
      expect(buy(alice, UnitType.LandMine, 50, 50)).toBeDefined();
      expect(alice.canBuild(UnitType.LandMine, game.ref(55, 55))).toBe(false);
      expect(alice.canBuild(UnitType.LandMine, game.ref(70, 50))).not.toBe(
        false,
      );
    });

    test("costs 125k, doubling with each mine, at most 1M", () => {
      const cost = (n: number) =>
        game.config().unitInfo(UnitType.LandMine).cost(game, alice, n);
      // infiniteGold makes the cost 0 for humans; ask as a nation.
      vi.spyOn(alice, "type").mockReturnValue(PlayerType.Nation);
      expect(cost(0)).toBe(125_000n);
      expect(cost(1)).toBe(250_000n);
      expect(cost(3)).toBe(1_000_000n);
      expect(cost(6)).toBe(1_000_000n);
    });

    test("kills 5% of the attack that takes its tile", () => {
      const mineTile = game.ref(119, 60);
      const mine = alice.buildUnit(UnitType.LandMine, mineTile, {});
      const exec = new MineExecution(mine);
      exec.init(game, game.ticks());
      game.addExecution(new AttackExecution(10_000, bob, alice.id(), null));
      executeTicks(game, 2);
      const attack = bob.outgoingAttacks().find((a) => a.target() === alice)!;
      expect(attack).toBeDefined();

      const before = attack.troops();
      bob.conquer(mineTile);
      exec.tick(game.ticks());
      expect(attack.troops()).toBe(before - Math.floor(before * 0.05));
      expect(mine.isActive()).toBe(false);
    });
  });

  describe("sea mine", () => {
    beforeEach(coast);

    test("goes on water, and only one fits on this small sea", () => {
      expect(alice.canBuild(UnitType.SeaMine, game.ref(2, 2))).toBe(false);
      expect(buy(alice, UnitType.SeaMine, 12, 8)).toBeDefined();
      expect(alice.canBuild(UnitType.SeaMine, game.ref(15, 15))).toBe(false);
    });

    test("its owner's ships pass, a foreign one sets it off and it sinks everything around", () => {
      const mine = buy(alice, UnitType.SeaMine, 12, 8)!;
      const own = alice.buildUnit(UnitType.Warship, game.ref(12, 9), {
        patrolTile: game.ref(12, 9),
      });
      const far = alice.buildUnit(UnitType.Warship, game.ref(15, 15), {
        patrolTile: game.ref(15, 15),
      });
      executeTicks(game, 5);
      expect(mine.isActive()).toBe(true);
      expect(own.isActive()).toBe(true);

      const enemy = bob.buildUnit(UnitType.Warship, game.ref(12, 11), {
        patrolTile: game.ref(12, 11),
      });
      executeTicks(game, 2);
      expect(mine.isActive()).toBe(false);
      expect(enemy.isActive()).toBe(false);
      // The blast takes its owner's ships too.
      expect(own.isActive()).toBe(false);
      // Radius 15 covers this whole sea.
      expect(far.isActive()).toBe(false);
    });

    test("an ally's ships pass too", () => {
      const mine = buy(alice, UnitType.SeaMine, 12, 8)!;
      vi.spyOn(alice, "isFriendly").mockImplementation((p) => p === bob);
      bob.buildUnit(UnitType.TransportShip, game.ref(12, 9), {});
      executeTicks(game, 5);
      expect(mine.isActive()).toBe(true);
    });
  });
});

describe("nuclear submarine", () => {
  beforeEach(coast);

  function buySub(): Unit {
    alice.buildUnit(UnitType.Port, game.ref(7, 4), {});
    const sub = buy(alice, UnitType.NuclearSubmarine, 12, 4);
    expect(sub).toBeDefined();
    return sub!;
  }

  function surface(sub: Unit): void {
    game.addExecution(new SurfaceSubmarineExecution(alice, sub.id()));
    executeTicks(game, 1);
  }

  function launch(type: UnitType): void {
    // Construction, then the nuke's init, then its launch tick.
    game.addExecution(new ConstructionExecution(alice, type, game.ref(2, 12)));
    executeTicks(game, 3);
  }

  test("submerged, it cannot fire and no warship goes for it", () => {
    const sub = buySub();
    expect(sub.isSubmerged()).toBe(true);
    expect(alice.canBuild(UnitType.AtomBomb, game.ref(2, 12))).toBe(false);
    const enemy = bob.buildUnit(UnitType.Warship, game.ref(13, 6), {
      patrolTile: game.ref(13, 6),
    });
    game.addExecution(new WarshipExecution(enemy));
    executeTicks(game, 50);
    expect(sub.health()).toBe(sub.maxHealth());
  });

  test("surfaced, it is a target", () => {
    const sub = buySub();
    surface(sub);
    const enemy = bob.buildUnit(UnitType.Warship, game.ref(13, 6), {
      patrolTile: game.ref(13, 6),
    });
    game.addExecution(new WarshipExecution(enemy));
    executeTicks(game, 50);
    expect(sub.health()).toBeLessThan(sub.maxHealth());
  });

  test("it fires 20s after surfacing, whatever mix fits its payload, then dives", () => {
    const sub = buySub();
    surface(sub);
    expect(sub.submarineState()!.mode).toBe("surfacing");
    executeTicks(game, 150);
    expect(alice.canBuild(UnitType.AtomBomb, game.ref(2, 12))).toBe(false);
    executeTicks(game, 60);
    expect(sub.submarineState()!.mode).toBe("surfaced");
    expect(alice.canBuild(UnitType.AtomBomb, game.ref(2, 12))).toBe(sub.tile());

    // 1 hydrogen bomb (5) + 2 atom bombs (2 each) out of 10 points.
    launch(UnitType.HydrogenBomb);
    expect(sub.submarineState()!.payloadLeft).toBe(5);
    expect(alice.canBuild(UnitType.HydrogenBomb, game.ref(2, 12))).toBe(
      sub.tile(),
    );
    launch(UnitType.AtomBomb);
    launch(UnitType.AtomBomb);
    expect(sub.submarineState()!.payloadLeft).toBe(1);
    // Nothing fits anymore: it dives.
    executeTicks(game, 1);
    expect(sub.isSubmerged()).toBe(true);
    expect(alice.canBuild(UnitType.AtomBomb, game.ref(2, 12))).toBe(false);
  });

  test("three atom bombs are fine too, and it dives when its window closes", () => {
    const sub = buySub();
    surface(sub);
    executeTicks(game, 201);
    for (let i = 0; i < 3; i++) launch(UnitType.AtomBomb);
    expect(sub.submarineState()!.payloadLeft).toBe(4);
    expect(sub.isSubmerged()).toBe(false);
    executeTicks(game, game.config().submarineFireWindowTicks());
    expect(sub.isSubmerged()).toBe(true);
  });

  test("a MIRV takes the whole payload", () => {
    const sub = buySub();
    surface(sub);
    executeTicks(game, 201);
    // A MIRV needs an owned target.
    expect(alice.canBuild(UnitType.MIRV, game.ref(2, 12))).toBe(sub.tile());
  });

  test("surfaced, it sails slower", () => {
    const sub = buySub();
    executeTicks(game, 30);
    const order = (x: number, y: number) => {
      game.addExecution(
        new MoveWarshipExecution(alice, [sub.id()], game.ref(x, y)),
      );
      executeTicks(game, 1);
    };
    order(12, 15);
    const submerged = runUntil(
      () => game.euclideanDistSquared(sub.tile(), game.ref(12, 15)) <= 4,
      100,
    );
    surface(sub);
    order(12, 1);
    const surfaced = runUntil(
      () => game.euclideanDistSquared(sub.tile(), game.ref(12, 1)) <= 4,
      100,
    );
    expect(surfaced).toBeGreaterThan(submerged * 2);
  });
});

describe("rail depot and tanks", () => {
  beforeEach(plains);

  test("a depot must be within reach of a factory", () => {
    expect(alice.canBuild(UnitType.RailDepot, game.ref(30, 60))).toBe(false);
    alice.buildUnit(UnitType.Factory, game.ref(20, 60), {});
    expect(alice.canBuild(UnitType.RailDepot, game.ref(40, 60))).not.toBe(
      false,
    );
  });

  test("tanks roll out of the nearest factory, five per factory level", () => {
    expect(buy(alice, UnitType.Tank, 50, 60)).toBeUndefined();
    // A depot alone doesn't build tanks
    alice.buildUnit(UnitType.RailDepot, game.ref(45, 60), {});
    expect(buy(alice, UnitType.Tank, 50, 60)).toBeUndefined();
    const factory = alice.buildUnit(UnitType.Factory, game.ref(40, 60), {});
    alice.buildUnit(UnitType.Factory, game.ref(5, 45), {});
    expect(alice.canBuild(UnitType.Tank, game.ref(50, 60))).toBe(
      factory.tile(),
    );
    for (let i = 0; i < 10; i++) {
      expect(buy(alice, UnitType.Tank, 50, 60)).toBeDefined();
    }
    expect(buy(alice, UnitType.Tank, 50, 60)).toBeUndefined();
    factory.increaseLevel();
    expect(buy(alice, UnitType.Tank, 50, 60)).toBeDefined();
  });

  test("a rail depot repairs the tanks around it, faster per level", () => {
    alice.buildUnit(UnitType.Factory, game.ref(40, 60), {});
    const tank = buy(alice, UnitType.Tank, 40, 60)!;
    const far = buy(alice, UnitType.Tank, 100, 60)!;
    executeTicks(game, 80);
    tank.modifyHealth(-300);
    far.modifyHealth(-300);
    executeTicks(game, 10);
    // No depot: no repair
    expect(tank.health()).toBe(100);

    const depot = alice.buildUnit(UnitType.RailDepot, game.ref(50, 60), {});
    executeTicks(game, 50);
    // 5 seconds at 8 health per second
    expect(tank.health()).toBeGreaterThanOrEqual(130);
    expect(tank.health()).toBeLessThanOrEqual(150);
    // 50 tiles away: out of reach
    expect(far.health()).toBe(100);

    depot.increaseLevel();
    const before = tank.health();
    executeTicks(game, 50);
    expect(tank.health() - before).toBeGreaterThanOrEqual(70);
  });

  test("a tank rides the railway, faster than it drives", () => {
    alice.buildUnit(UnitType.City, game.ref(105, 60), {});
    const factory = alice.buildUnit(UnitType.Factory, game.ref(10, 60), {});
    const depot = alice.buildUnit(UnitType.RailDepot, game.ref(10, 76), {});
    game.addExecution(
      new FactoryExecution(factory),
      new RailDepotExecution(depot),
    );
    executeTicks(game, 20);
    const stations = game.railNetwork().stationManager();
    const depotStation = stations.findStation(depot);
    expect(depotStation?.getCluster()?.size()).toBeGreaterThanOrEqual(3);

    const tank = buy(alice, UnitType.Tank, 105, 66)!;
    const ticks = runUntil(
      () => game.euclideanDistSquared(tank.tile(), game.ref(105, 66)) <= 2,
      200,
    );
    // About 100 tiles away: driving would take about 100 ticks.
    expect(ticks).toBeLessThan(70);
  });

  test("a tank drives over land to a place off the railway", () => {
    alice.buildUnit(UnitType.Factory, game.ref(40, 60), {});
    const tank = buy(alice, UnitType.Tank, 60, 60)!;
    const ticks = runUntil(() => tank.tile() === game.ref(60, 60), 100);
    expect(ticks).toBeLessThan(100);
  });

  test("a tank across the border attacks structures; at home it does not", () => {
    alice.buildUnit(UnitType.Factory, game.ref(100, 60), {});
    const city = bob.buildUnit(UnitType.City, game.ref(132, 60), {});
    const tank = buy(alice, UnitType.Tank, 117, 60)!;
    executeTicks(game, 60);
    expect(city.health()).toBe(city.maxHealth());

    game.addExecution(
      new MoveWarshipExecution(alice, [tank.id()], game.ref(125, 60)),
    );
    executeTicks(game, 60);
    expect(city.health()).toBeLessThan(city.maxHealth());
    // Within the border buffer it takes no harm.
    expect(tank.health()).toBe(tank.maxHealth());
  });

  test("a tank deep in enemy land wears down", () => {
    alice.buildUnit(UnitType.Factory, game.ref(100, 60), {});
    const tank = buy(alice, UnitType.Tank, 190, 60)!;
    executeTicks(game, 150);
    expect(tank.health()).toBeLessThan(tank.maxHealth());
    executeTicks(game, 300);
    expect(tank.isActive()).toBe(false);
  });

  test("a tank defends the land around it like a defense post", () => {
    const attackCost = (withTank: boolean) => {
      const exec = new AttackExecution(1000, bob, alice.id(), null);
      exec.init(game, game.ticks());
      if (withTank) {
        alice.buildUnit(UnitType.Tank, game.ref(110, 60), {
          patrolTile: game.ref(110, 60),
        });
      }
      // attackLogicInput is what the attack hands the rules for a tile.
      const input = (
        exec as unknown as {
          attackLogicInput: (
            t: number,
            tile: number,
            b: number,
          ) => { defenderHasDefensePost: boolean };
        }
      ).attackLogicInput(1000, game.ref(119, 60), 10);
      return input.defenderHasDefensePost;
    };
    expect(attackCost(false)).toBe(false);
    expect(attackCost(true)).toBe(true);
  });
});

test("a game with subs, tanks and mines snapshots and restores", async () => {
  await plains();
  alice.buildUnit(UnitType.Factory, game.ref(100, 60), {});
  alice.buildUnit(UnitType.RailDepot, game.ref(90, 60), {});
  buy(alice, UnitType.Tank, 125, 60);
  buy(alice, UnitType.LandMine, 50, 50);
  bob.buildUnit(UnitType.City, game.ref(132, 60), {});
  executeTicks(game, 30);
  await expectSnapshotRoundTrip(game, "big_plains", 40);

  await coast();
  alice.buildUnit(UnitType.Port, game.ref(7, 4), {});
  const sub = buy(alice, UnitType.NuclearSubmarine, 12, 4)!;
  buy(alice, UnitType.SeaMine, 12, 12);
  game.addExecution(new SurfaceSubmarineExecution(alice, sub.id()));
  executeTicks(game, 20);
  await expectSnapshotRoundTrip(game, "half_land_half_ocean", 40);
});
