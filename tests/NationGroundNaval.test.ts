import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { handleNationGroundAndNaval } from "@openfront/engine/execution/nation/NationGroundNavalBehavior";
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

function build(owner: Player, type: UnitType, x: number, y: number) {
  game.addExecution(new ConstructionExecution(owner, type, game.ref(x, y)));
  executeTicks(game, 3);
}

/** Runs the nation's ground & naval turn `turns` times, a few ticks apart. */
function think(turns: number) {
  for (let i = 0; i < turns; i++) {
    handleNationGroundAndNaval(game, nation);
    executeTicks(game, 5);
  }
}

/** Bob keeps a big attack going on the nation's land. */
function bobAttacks() {
  bob.addTroops(1_000_000);
  game.addExecution(new AttackExecution(500_000, bob, nation.id(), null));
  executeTicks(game, 2);
  expect(nation.incomingAttacks().length).toBeGreaterThan(0);
}

/** Nation in the west, Bob in the east of the plains; their land meets at x = 120. */
async function plains(difficulty: Difficulty) {
  game = await setup(
    "big_plains",
    { difficulty, instantBuild: true, spawnImmunityDuration: 0 },
    [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ],
  );
  nation = game.player("nation");
  bob = game.player("bob");
  conquerRect(nation, 0, 40, 120, 80);
  conquerRect(bob, 120, 40, 200, 80);
  nation.addGold(1_000_000_000n);
  nation.addTroops(100_000);
  build(nation, UnitType.Factory, 60, 60);
  expect(nation.units(UnitType.Factory).length).toBe(1);
}

describe("nation ground forces", () => {
  test("Easy never builds a rail depot in peacetime", async () => {
    await plains(Difficulty.Easy);
    for (let i = 0; i < 10; i++) build(nation, UnitType.City, 10 + 8 * i, 45);
    think(3);
    expect(nation.units(UnitType.RailDepot).length).toBe(0);
  });

  test("Impossible builds a depot in peacetime once it has enough cities", async () => {
    await plains(Difficulty.Impossible);
    think(2);
    expect(nation.units(UnitType.RailDepot).length).toBe(0);
    for (let i = 0; i < 4; i++) build(nation, UnitType.City, 10 + 8 * i, 45);
    think(2);
    expect(nation.units(UnitType.RailDepot).length).toBeGreaterThanOrEqual(1);
  });

  test("at war, the depot goes up on the enemy's side of the factory", async () => {
    await plains(Difficulty.Medium);
    bob.buildUnit(UnitType.City, game.ref(160, 60), {});
    bobAttacks();
    think(2);
    const depots = nation.units(UnitType.RailDepot);
    expect(depots.length).toBe(1);
    expect(game.x(depots[0].tile())).toBeGreaterThan(60);
  });

  test.each([
    [Difficulty.Easy, 1],
    [Difficulty.Medium, 2],
    [Difficulty.Hard, 3],
    [Difficulty.Impossible, 5],
  ])(
    "%s fields %i tanks per factory level against an attack, along the front, and builds a depot to repair them",
    async (difficulty, tanks) => {
      await plains(difficulty);
      bobAttacks();
      think(30);
      const own = nation.units(UnitType.Tank);
      expect(nation.units(UnitType.RailDepot).length).toBeGreaterThanOrEqual(1);
      // The one level 1 factory
      expect(own.length).toBe(tanks);
      // Every tank is posted at the front facing Bob (x = 120, Bob pushes it back a little)
      for (const tank of own) {
        const post = tank.warshipState().patrolTile!;
        expect(game.x(post)).toBeGreaterThanOrEqual(100);
        expect(game.x(post)).toBeLessThanOrEqual(121);
      }
    },
  );

  test("lays a land mine on the front in front of a strong attack", async () => {
    await plains(Difficulty.Hard);
    bobAttacks();
    think(1);
    const mines = nation.units(UnitType.LandMine);
    expect(mines.length).toBe(1);
    expect(game.owner(mines[0].tile()) === nation).toBe(true);
    expect(game.x(mines[0].tile())).toBe(119);
  });

  test("no ground forces without a war or the gold", async () => {
    await plains(Difficulty.Impossible);
    nation.removeGold(nation.gold());
    bobAttacks();
    think(5);
    expect(nation.units(UnitType.RailDepot).length).toBe(0);
    expect(nation.units(UnitType.LandMine).length).toBe(0);
  });
});

/** 16x16: land at x 0-7, water at x 8-15. The nation holds the north, Bob the south. */
async function coast(difficulty: Difficulty) {
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
  nation.addTroops(100_000);
  bob.addTroops(100_000);
  executeTicks(game, 5);
  // Bob's attack on the nation, frozen in place (never ticked) so the war lasts
  new AttackExecution(1_000, bob, nation.id(), null).init(game, game.ticks());
  expect(nation.incomingAttacks().length).toBe(1);
  build(nation, UnitType.Port, 7, 2);
  bob.buildUnit(UnitType.Port, game.ref(7, 13), {});
  expect(nation.units(UnitType.Port).length).toBe(1);
}

describe("nation navy", () => {
  test("Easy has no nuclear submarine or sea mines", async () => {
    await coast(Difficulty.Easy);
    think(10);
    expect(nation.units(UnitType.NuclearSubmarine).length).toBe(0);
    expect(nation.units(UnitType.SeaMine).length).toBe(0);
  });

  test("Hard builds a nuclear submarine, takes it off the enemy coast and surfaces it to fire", async () => {
    await coast(Difficulty.Hard);
    let surfaced = false;
    for (let i = 0; i < 100 && !surfaced; i++) {
      think(1);
      surfaced = nation
        .units(UnitType.NuclearSubmarine)
        .some((s) => s.submarineState()?.mode !== "submerged");
    }
    const subs = nation.units(UnitType.NuclearSubmarine);
    expect(subs.length).toBe(1);
    expect(surfaced).toBe(true);
    // Stationed off Bob's coast, not its own
    expect(game.y(subs[0].warshipState().patrolTile!)).toBeGreaterThanOrEqual(
      6,
    );
  });

  test("Medium mines the water off the enemy's port", async () => {
    await coast(Difficulty.Medium);
    think(3);
    const mines = nation.units(UnitType.SeaMine);
    expect(mines.length).toBe(1);
    expect(game.isWater(mines[0].tile())).toBe(true);
    expect(
      game.euclideanDistSquared(mines[0].tile(), game.ref(7, 13)),
    ).toBeLessThanOrEqual(10 * 10 * 2);
  });
});
