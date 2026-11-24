import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { maxHealthAtLevel } from "@openfront/engine-lib/game/UnitHealth";
import { AADefenseExecution } from "@openfront/engine/execution/AADefenseExecution";
import { AircraftExecution } from "@openfront/engine/execution/AircraftExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { MoveWarshipExecution } from "@openfront/engine/execution/MoveWarshipExecution";
import { handleNationAircraft } from "@openfront/engine/execution/nation/NationAircraftBehavior";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
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

/** Buys an aircraft the way the build menu does and returns it. */
function buyAircraft(
  owner: Player,
  type: UnitType.FighterJet | UnitType.Bomber,
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

describe("air warfare", () => {
  beforeEach(async () => {
    game = await setup(MAP, { infiniteGold: true, instantBuild: true }, [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ]);
    alice = game.player("alice");
    bob = game.player("bob");
    // Alice holds the west, Bob the east, with empty land in between.
    conquerRect(alice, 0, 20, 60, 80);
    conquerRect(bob, 140, 20, 200, 80);
  });

  describe("structure health", () => {
    test("every structure has health, and a level adds less than the one before", () => {
      const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
      const base = game.config().unitInfo(UnitType.City).maxHealth!;
      expect(city.hasHealth()).toBe(true);
      expect(city.maxHealth()).toBe(base);
      expect(city.health()).toBe(base);

      let lastGain = Infinity;
      for (let level = 2; level <= 12; level++) {
        const before = city.maxHealth();
        city.increaseLevel();
        const gain = city.maxHealth() - before;
        expect(city.maxHealth()).toBe(maxHealthAtLevel(base, level));
        expect(gain).toBeGreaterThan(0);
        expect(gain).toBeLessThanOrEqual(lastGain);
        // An upgrade arrives with its health.
        expect(city.health()).toBe(city.maxHealth());
        lastGain = gain;
      }
      // Level 12 is far from 12 times the health.
      expect(city.maxHealth()).toBeLessThan(base * 5);
    });

    test("an upgrade keeps the damage already taken", () => {
      const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
      city.modifyHealth(-100, bob);
      const missing = city.maxHealth() - city.health();
      city.increaseLevel();
      expect(city.maxHealth() - city.health()).toBe(missing);
    });

    test("health reaching zero destroys the structure whatever its level", () => {
      const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
      city.increaseLevel();
      city.increaseLevel();
      city.modifyHealth(-city.maxHealth(), bob);
      expect(city.isActive()).toBe(false);
      expect(city.destroyer()).toBe(bob);
    });

    test("a damaged structure no longer repairs on its own", () => {
      game.addExecution(new PlayerExecution(alice));
      const city = alice.buildUnit(UnitType.City, game.ref(10, 30), {});
      city.modifyHealth(-150, bob);
      const damaged = city.health();
      executeTicks(game, 200);
      expect(city.health()).toBe(damaged);
    });
  });

  describe("airfield", () => {
    test("aircraft need a finished airfield", () => {
      expect(buyAircraft(alice, UnitType.FighterJet, 50, 50)).toBeUndefined();
      const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      airfield.setUnderConstruction(true);
      expect(buyAircraft(alice, UnitType.FighterJet, 50, 50)).toBeUndefined();
      airfield.setUnderConstruction(false);
      const fighter = buyAircraft(alice, UnitType.FighterJet, 50, 50);
      expect(fighter).toBeDefined();
      // It takes off from the airfield and patrols where it was sent.
      expect(fighter!.warshipState().patrolTile).toBe(game.ref(50, 50));
    });

    test("an airfield holds a limited number of aircraft per level", () => {
      const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const cap = game.config().aircraftPerAirfieldLevel();
      for (let i = 0; i < cap + 2; i++) {
        buyAircraft(
          alice,
          i % 2 === 0 ? UnitType.FighterJet : UnitType.Bomber,
          30,
          50,
        );
      }
      expect(alice.units(UnitType.FighterJet, UnitType.Bomber)).toHaveLength(
        cap,
      );
      airfield.increaseLevel();
      expect(buyAircraft(alice, UnitType.Bomber, 30, 50)).toBeDefined();
    });

    test("a damaged aircraft repairs near its airfield", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const fighter = buyAircraft(alice, UnitType.FighterJet, 25, 50)!;
      fighter.modifyHealth(-50, bob);
      executeTicks(game, 20);
      expect(fighter.health()).toBeGreaterThan(fighter.maxHealth() - 50);
    });
  });

  describe("retreat for repairs", () => {
    const dist = (a: Unit, b: Unit) =>
      Math.sqrt(game.euclideanDistSquared(a.tile(), b.tile()));

    test("a badly damaged bomber flies home, is repaired and returns", () => {
      const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const bomber = buyAircraft(alice, UnitType.Bomber, 120, 50)!;
      runUntil(() => dist(bomber, airfield) > 90, 200);
      // Down to a quarter: below the retreat threshold.
      bomber.modifyHealth(-(bomber.maxHealth() * 3) / 4, bob);
      game.executeNextTick();
      expect(bomber.warshipState().state).toBe("retreating");

      runUntil(() => bomber.warshipState().state === "docked", 300);
      expect(bomber.warshipState().state).toBe("docked");
      expect(dist(bomber, airfield)).toBeLessThanOrEqual(
        game.config().aircraftDockingRange(),
      );

      runUntil(() => bomber.health() >= bomber.maxHealth(), 600);
      expect(bomber.health()).toBe(bomber.maxHealth());
      executeTicks(game, 2);
      expect(bomber.warshipState().state).toBe("patrolling");
      // Back to its patrol.
      runUntil(() => dist(bomber, airfield) > 80, 300);
      expect(dist(bomber, airfield)).toBeGreaterThan(80);
    });

    test("over its base it heals as fast as a warship in a port, relatively", () => {
      const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const fighter = buyAircraft(alice, UnitType.FighterJet, 22, 50)!;
      fighter.modifyHealth(-(fighter.maxHealth() * 3) / 4, bob);
      runUntil(() => fighter.warshipState().state === "docked", 50);
      expect(fighter.warshipState().state).toBe("docked");
      expect(dist(fighter, airfield)).toBeLessThanOrEqual(
        game.config().aircraftDockingRange(),
      );

      const before = fighter.health();
      executeTicks(game, 20);
      const config = game.config();
      // A warship docked alone at a level 1 port heals passive + bonus per
      // tick out of its max health; the fighter the same share of its own.
      const perTick =
        ((config.warshipPassiveHealing() +
          config.warshipPortHealingBonusPerLevel()) *
          fighter.maxHealth()) /
        config.unitInfo(UnitType.Warship).maxHealth!;
      expect(fighter.health() - before).toBeGreaterThanOrEqual(
        Math.floor(perTick * 20) - 1,
      );
      expect(fighter.health() - before).toBeLessThanOrEqual(
        Math.ceil(perTick * 20),
      );
    });

    test("a new order overrides the retreat", () => {
      const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const bomber = buyAircraft(alice, UnitType.Bomber, 120, 50)!;
      runUntil(() => dist(bomber, airfield) > 90, 200);
      bomber.modifyHealth(-(bomber.maxHealth() * 3) / 4, bob);
      game.executeNextTick();
      expect(bomber.warshipState().state).toBe("retreating");
      game.addExecution(
        new MoveWarshipExecution(alice, [bomber.id()], game.ref(130, 50)),
      );
      executeTicks(game, 3);
      expect(bomber.warshipState().state).toBe("patrolling");
      expect(bomber.warshipState().patrolTile).toBe(game.ref(130, 50));
    });

    test("without an airfield there is nowhere to retreat to", () => {
      const airfield = alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const bomber = buyAircraft(alice, UnitType.Bomber, 120, 50)!;
      airfield.delete();
      bomber.modifyHealth(-(bomber.maxHealth() * 3) / 4, bob);
      executeTicks(game, 2);
      expect(bomber.warshipState().state).toBe("patrolling");
    });
  });

  describe("bomber", () => {
    test("destroys the enemy structure it is sent to and damages its neighbours", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const aliceCity = alice.buildUnit(UnitType.City, game.ref(40, 50), {});
      const city = bob.buildUnit(UnitType.City, game.ref(150, 50), {});
      const neighbour = bob.buildUnit(UnitType.Factory, game.ref(156, 50), {});
      const farAway = bob.buildUnit(UnitType.City, game.ref(190, 30), {});

      const bomber = buyAircraft(alice, UnitType.Bomber, 150, 50)!;
      expect(bomber.health()).toBe(bomber.maxHealth());
      const ticks = runUntil(() => !city.isActive(), 600);

      expect(ticks).toBeLessThan(600);
      expect(city.isActive()).toBe(false);
      expect(city.destroyer()).toBe(alice);
      // The blast reached the factory next door, not the city across the map.
      expect(
        !neighbour.isActive() || neighbour.health() < neighbour.maxHealth(),
      ).toBe(true);
      expect(farAway.health()).toBe(farAway.maxHealth());
      expect(aliceCity.health()).toBe(aliceCity.maxHealth());
      expect(bomber.isActive()).toBe(true);
    });

    test("leaves an ally's structures alone", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const city = bob.buildUnit(UnitType.City, game.ref(150, 50), {});
      const request = alice.createAllianceRequest(bob);
      request!.accept();
      expect(alice.isFriendly(bob)).toBe(true);

      buyAircraft(alice, UnitType.Bomber, 150, 50);
      executeTicks(game, 200);
      expect(city.health()).toBe(city.maxHealth());
    });
  });

  describe("flight", () => {
    /** Turn between consecutive moves, in degrees (0..180). */
    function turns(plane: Unit, ticks: number): number[] {
      const out: number[] = [];
      let last: [number, number] | null = null;
      let tile = plane.tile();
      for (let i = 0; i < ticks; i++) {
        game.executeNextTick();
        const next = plane.tile();
        if (next === tile) continue;
        const move: [number, number] = [
          game.x(next) - game.x(tile),
          game.y(next) - game.y(tile),
        ];
        if (last !== null) {
          const dot = last[0] * move[0] + last[1] * move[1];
          const len = Math.hypot(...last) * Math.hypot(...move);
          out.push(
            (Math.acos(Math.max(-1, Math.min(1, dot / len))) * 180) / Math.PI,
          );
        }
        last = move;
        tile = next;
      }
      return out;
    }

    test("a patrolling bomber flies curves instead of zigzagging", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const bomber = buyAircraft(alice, UnitType.Bomber, 30, 50)!;
      const t = turns(bomber, 300);
      expect(t.length).toBeGreaterThan(200);
      // Moves snap to whole tiles, so allow for that on top of the 30° turn.
      expect(Math.max(...t)).toBeLessThan(80);
      // Mostly straight: it is not picking a new waypoint every tick (before
      // the fix it turned ~90° per tick on average).
      const mean = t.reduce((a, b) => a + b, 0) / t.length;
      expect(mean).toBeLessThan(30);
    });

    test("a patrolling fighter never turns around on the spot", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      // Sent out over the empty middle: hunting, not on guard.
      const fighter = buyAircraft(alice, UnitType.FighterJet, 100, 50)!;
      const t = turns(fighter, 300);
      expect(t.length).toBeGreaterThan(200);
      expect(Math.max(...t)).toBeLessThan(90);
    });

    test("keeps its course through a snapshot", async () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      buyAircraft(alice, UnitType.Bomber, 30, 50);
      buyAircraft(alice, UnitType.FighterJet, 30, 50);
      executeTicks(game, 37);
      await expectSnapshotRoundTrip(game, MAP, 30);
    });
  });

  describe("fighter", () => {
    test("shoots down an enemy bomber and cannot hurt structures", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      bob.buildUnit(UnitType.Airfield, game.ref(180, 50), {});
      const bobCity = bob.buildUnit(UnitType.City, game.ref(150, 50), {});

      const bomber = buyAircraft(bob, UnitType.Bomber, 100, 50)!;
      const fighter = buyAircraft(alice, UnitType.FighterJet, 100, 50)!;
      const ticks = runUntil(() => !bomber.isActive(), 600);

      expect(ticks).toBeLessThan(600);
      expect(bomber.isActive()).toBe(false);
      expect(bomber.destroyer()).toBe(alice);
      expect(fighter.isActive()).toBe(true);

      // With nothing left to shoot it patrols over Bob's city, harmlessly.
      game.addExecution(
        new MoveWarshipExecution(alice, [fighter.id()], game.ref(150, 50)),
      );
      executeTicks(game, 150);
      expect(bobCity.health()).toBe(bobCity.maxHealth());
    });
  });

  describe("fighter on guard", () => {
    beforeEach(() => {
      // Aircraft only operate within the range of their airfields.
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
    });

    test("over its own land it ignores a neighbour's aircraft outside the border", () => {
      const guard = alice.buildUnit(UnitType.FighterJet, game.ref(50, 50), {
        patrolTile: game.ref(50, 50),
      });
      game.addExecution(new AircraftExecution(guard));
      // Bob's bomber idles over nobody's land, in the fighter's range.
      const bomber = bob.buildUnit(UnitType.Bomber, game.ref(90, 50), {
        patrolTile: game.ref(90, 50),
      });
      executeTicks(game, 40);
      expect(guard.targetUnit()).toBeUndefined();
      expect(bomber.health()).toBe(bomber.maxHealth());

      // Once the bomber is over Alice's land the guard goes for it.
      bomber.move(game.ref(55, 50));
      executeTicks(game, 3);
      expect(guard.targetUnit()).toBe(bomber);
    });

    test("stays over its owner's land", () => {
      // Posted right at Alice's eastern border.
      const guard = alice.buildUnit(UnitType.FighterJet, game.ref(58, 50), {
        patrolTile: game.ref(58, 50),
      });
      game.addExecution(new AircraftExecution(guard));
      for (let i = 0; i < 400; i++) {
        game.executeNextTick();
        expect(game.owner(guard.tile())).toBe(alice);
      }
    });

    test("sent beyond its own land it hunts", () => {
      const hunter = alice.buildUnit(UnitType.FighterJet, game.ref(70, 50), {
        patrolTile: game.ref(90, 50),
      });
      game.addExecution(new AircraftExecution(hunter));
      const bomber = bob.buildUnit(UnitType.Bomber, game.ref(100, 50), {
        patrolTile: game.ref(100, 50),
      });
      executeTicks(game, 3);
      expect(hunter.targetUnit()).toBe(bomber);
    });
  });

  describe("AA defense", () => {
    test("shoots a bomber down before it levels the city it guards", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const city = bob.buildUnit(UnitType.City, game.ref(150, 50), {});
      const aa = bob.buildUnit(UnitType.AADefense, game.ref(150, 53), {});
      game.addExecution(new AADefenseExecution(aa));

      const bomber = buyAircraft(alice, UnitType.Bomber, 150, 50)!;
      // Badly hit, it breaks off and flies home before the city falls.
      const ticks = runUntil(
        () => bomber.warshipState().state === "retreating",
        600,
      );
      expect(ticks).toBeLessThan(600);
      expect(bomber.isActive()).toBe(true);
      expect(city.isActive()).toBe(true);
      // The AA does not waste missiles on it as it leaves.
      executeTicks(game, 20);
      expect(game.units(UnitType.SAMMissile)).toHaveLength(0);
    });

    test("fires one missile per level before it has to reload", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const aa = bob.buildUnit(UnitType.AADefense, game.ref(150, 50), {});
      aa.increaseLevel();
      // The upgrade starts with its new missile on cooldown; let it reload.
      executeTicks(game, game.config().aaDefenseCooldown() + 1);
      game.addExecution(new AADefenseExecution(aa));

      // Three intruders over Bob's land, in range.
      const bombers = [0, 1, 2].map((i) =>
        alice.buildUnit(UnitType.Bomber, game.ref(160, 48 + i), {
          patrolTile: game.ref(160, 48 + i),
        }),
      );
      // A stacked gun fires its missiles one after another, not at once.
      executeTicks(game, 2);
      expect(aa.missileTimerQueue()).toHaveLength(1);
      executeTicks(game, game.config().aaDefenseSalvoSpacing());
      expect(aa.isInCooldown()).toBe(true);
      expect(aa.missileTimerQueue()).toHaveLength(2);
      expect(bombers.every((b) => b.isActive())).toBe(true);
    });

    test("two AA guns don't both fire a full salvo at the same plane", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const guns = [150, 160].map((x) => {
        const aa = bob.buildUnit(UnitType.AADefense, game.ref(x, 50), {});
        for (let l = 1; l < 4; l++) aa.increaseLevel();
        return aa;
      });
      // Let the upgrades' missiles reload first.
      for (const aa of guns) game.addExecution(new AADefenseExecution(aa));
      executeTicks(game, game.config().aaDefenseCooldown() + 2);
      expect(guns.every((aa) => aa.missileTimerQueue().length === 0)).toBe(
        true,
      );

      const bomber = alice.buildUnit(UnitType.Bomber, game.ref(155, 52), {
        patrolTile: game.ref(155, 52),
      });
      let fired = 0;
      let biggestHit = 0;
      let last = bomber.health();
      for (let i = 0; i < 100 && bomber.isActive(); i++) {
        game.executeNextTick();
        fired = Math.max(
          fired,
          guns.reduce((n, aa) => n + aa.missileTimerQueue().length, 0),
        );
        const now = bomber.isActive() ? bomber.health() : 0;
        biggestHit = Math.max(biggestHit, last - now);
        last = now;
      }
      expect(bomber.isActive()).toBe(false);
      // Just enough missiles to bring it down, no second salvo on top.
      const damage = game.config().aaMissileDamage();
      const needed = Math.ceil(
        game.config().unitInfo(UnitType.Bomber).maxHealth! / damage,
      );
      expect(fired).toBe(needed);
      // At most one missile from each gun lands in the same tick.
      expect(biggestHit).toBeLessThanOrEqual(2 * damage);
    });

    test("five bombers take out a level 3 AA Defense on their own", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const aa = bob.buildUnit(UnitType.AADefense, game.ref(170, 50), {});
      aa.increaseLevel();
      aa.increaseLevel();
      game.addExecution(new AADefenseExecution(aa));
      // Its upgrades' missiles reload first.
      executeTicks(game, game.config().aaDefenseCooldown() + 2);
      // Bought together, they fly in together.
      for (let i = 0; i < 5; i++) {
        game.addExecution(
          new ConstructionExecution(alice, UnitType.Bomber, game.ref(170, 50)),
        );
      }
      executeTicks(game, 3);
      const bombers = alice.units(UnitType.Bomber);
      expect(bombers).toHaveLength(5);
      runUntil(() => !aa.isActive(), 600);
      expect(aa.isActive()).toBe(false);
      // Hit badly, they flew home instead of being shot down.
      expect(bombers.filter((b) => b.isActive()).length).toBeGreaterThanOrEqual(
        4,
      );
    });

    test("leaves a neighbour's aircraft alone until it intrudes or attacks", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      // On Bob's border, so the land between the two is in its range.
      const aa = bob.buildUnit(UnitType.AADefense, game.ref(141, 50), {});
      game.addExecution(new AADefenseExecution(aa));

      // Alice's fighter circles over nobody's land, well within range.
      const fighter = alice.buildUnit(UnitType.FighterJet, game.ref(130, 50), {
        patrolTile: game.ref(130, 50),
      });
      for (let i = 0; i < 30; i++) {
        fighter.move(game.ref(130 + (i % 2), 50));
        game.executeNextTick();
      }
      expect(aa.missileTimerQueue()).toHaveLength(0);
      expect(fighter.health()).toBe(fighter.maxHealth());

      // Over Bob's land it is an intruder.
      fighter.move(game.ref(145, 50));
      executeTicks(game, 2);
      expect(aa.missileTimerQueue()).toHaveLength(1);
    });

    test("ignores its owner's and an ally's aircraft", () => {
      bob.buildUnit(UnitType.Airfield, game.ref(180, 50), {});
      const aa = bob.buildUnit(UnitType.AADefense, game.ref(150, 50), {});
      game.addExecution(new AADefenseExecution(aa));
      const own = buyAircraft(bob, UnitType.FighterJet, 150, 50)!;
      executeTicks(game, 100);
      expect(own.health()).toBe(own.maxHealth());
      expect(aa.missileTimerQueue()).toHaveLength(0);
    });
  });

  describe("orders", () => {
    test("a move order sends aircraft to patrol a new tile", () => {
      alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
      const fighter = buyAircraft(alice, UnitType.FighterJet, 30, 50)!;
      const bomber = buyAircraft(alice, UnitType.Bomber, 30, 50)!;
      const destination = game.ref(100, 150);

      // Bob cannot order Alice's aircraft around.
      game.addExecution(
        new MoveWarshipExecution(bob, [fighter.id()], destination),
      );
      executeTicks(game, 2);
      expect(fighter.warshipState().patrolTile).toBe(game.ref(30, 50));

      game.addExecution(
        new MoveWarshipExecution(
          alice,
          [fighter.id(), bomber.id()],
          destination,
        ),
      );
      executeTicks(game, 2);
      expect(fighter.warshipState().patrolTile).toBe(destination);
      expect(bomber.warshipState().patrolTile).toBe(destination);

      // Both get there and stay around it.
      const patrolRange = game
        .config()
        .aircraftPatrolRange(UnitType.FighterJet);
      executeTicks(game, 150);
      for (const plane of [fighter, bomber]) {
        expect(
          game.euclideanDistSquared(plane.tile(), destination),
        ).toBeLessThanOrEqual(2 * patrolRange * patrolRange);
      }
    });

    test("a fighter is much faster than a bomber", () => {
      const config = game.config();
      expect(config.aircraftSpeed(UnitType.FighterJet)).toBeGreaterThan(
        config.aircraftSpeed(UnitType.Bomber),
      );
      const fighter = alice.buildUnit(UnitType.FighterJet, game.ref(10, 50), {
        patrolTile: game.ref(190, 50),
      });
      const bomber = alice.buildUnit(UnitType.Bomber, game.ref(10, 50), {
        patrolTile: game.ref(190, 50),
      });
      game.addExecution(
        new AircraftExecution(fighter),
        new AircraftExecution(bomber),
      );
      executeTicks(game, 20);
      expect(game.x(fighter.tile())).toBeGreaterThan(game.x(bomber.tile()));
    });
  });

  describe("nation air force", () => {
    let nation: Player;

    beforeEach(() => {
      nation = game.addPlayer(
        new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      );
      conquerRect(nation, 80, 100, 120, 160);
      nation.addGold(50_000_000n);
      nation.buildUnit(UnitType.Airfield, game.ref(100, 130), {});
    });

    test("keeps a small fighter guard in peace and buys no bombers", () => {
      for (let i = 0; i < 20; i++) {
        handleNationAircraft(game, nation);
        executeTicks(game, 3);
      }
      expect(nation.units(UnitType.Bomber)).toHaveLength(0);
      expect(nation.units(UnitType.FighterJet)).toHaveLength(1);
    });

    test("at war it buys bombers and bombs the enemy's structures", () => {
      const city = bob.buildUnit(UnitType.City, game.ref(150, 70), {});
      // A bad relation is no reason to bomb...
      nation.updateRelation(bob, -1000);
      handleNationAircraft(game, nation);
      executeTicks(game, 3);
      expect(nation.units(UnitType.Bomber)).toHaveLength(0);
      // ...a war is.
      nation.createAttack(bob, 1000, null, new Set());
      for (let i = 0; i < 20; i++) {
        handleNationAircraft(game, nation);
        executeTicks(game, 3);
      }
      const bombers = nation.units(UnitType.Bomber);
      const fighters = nation.units(UnitType.FighterJet);
      // Medium difficulty: one bomber per airfield level, and its fighters.
      expect(bombers).toHaveLength(1);
      expect(fighters).toHaveLength(1);
      for (const bomber of bombers) {
        expect(bomber.warshipState().patrolTile).toBe(city.tile());
      }

      const ticks = runUntil(() => {
        if (game.ticks() % 30 === 0) handleNationAircraft(game, nation);
        return !city.isActive();
      }, 800);
      expect(ticks).toBeLessThan(800);
      expect(city.destroyer()).toBe(nation);
      // With nothing left to bomb the bombers come home.
      executeTicks(game, 2);
      handleNationAircraft(game, nation);
      executeTicks(game, 2);
      for (const bomber of nation.units(UnitType.Bomber)) {
        expect(bomber.warshipState().patrolTile).toBe(game.ref(100, 130));
      }
    });

    test("its fighters go after bombers working on its structures", () => {
      const fighter = nation.buildUnit(
        UnitType.FighterJet,
        game.ref(100, 130),
        {
          patrolTile: game.ref(100, 150),
        },
      );
      game.addExecution(new AircraftExecution(fighter));
      const nationCity = nation.buildUnit(UnitType.City, game.ref(90, 110), {});
      bob.buildUnit(UnitType.Airfield, game.ref(180, 50), {});
      const bomber = buyAircraft(bob, UnitType.Bomber, 90, 110)!;
      executeTicks(game, 2);
      expect(bomber.targetUnit()).toBe(nationCity);

      handleNationAircraft(game, nation);
      executeTicks(game, 2);
      expect(fighter.warshipState().patrolTile).toBe(nationCity.tile());
      // Shot down, or badly hit and driven off home.
      const ticks = runUntil(
        () =>
          !bomber.isActive() || bomber.warshipState().state !== "patrolling",
        600,
      );
      expect(ticks).toBeLessThan(600);
      if (!bomber.isActive()) {
        expect(bomber.destroyer()).toBe(nation);
      } else {
        expect(bomber.health()).toBeLessThan(bomber.maxHealth());
      }
    });
  });

  test("a game with air combat under way snapshots and restores", async () => {
    alice.buildUnit(UnitType.Airfield, game.ref(20, 50), {});
    bob.buildUnit(UnitType.Airfield, game.ref(180, 50), {});
    bob.buildUnit(UnitType.City, game.ref(150, 50), {});
    const aa = bob.buildUnit(UnitType.AADefense, game.ref(150, 60), {});
    game.addExecution(
      new AADefenseExecution(aa),
      new PlayerExecution(alice),
      new PlayerExecution(bob),
    );
    buyAircraft(alice, UnitType.Bomber, 150, 50);
    buyAircraft(alice, UnitType.Bomber, 150, 50);
    buyAircraft(alice, UnitType.FighterJet, 140, 50);
    buyAircraft(bob, UnitType.FighterJet, 140, 50);
    // Snapshot with a shot or a bomb, and an AA missile, in the air.
    const inFlight = () =>
      game.units(UnitType.Shell).length > 0 &&
      game.units(UnitType.SAMMissile).length > 0;
    expect(runUntil(inFlight, 400)).toBeLessThan(400);
    await expectSnapshotRoundTrip(game, MAP, 80);
  });
});
