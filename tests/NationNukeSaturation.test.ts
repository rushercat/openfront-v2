import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  Config,
  NukeMagnitude,
} from "@openfront/engine-lib/configuration/Config";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationNukeBehavior } from "@openfront/engine/execution/nation/NationNukeBehavior";
import {
  planSaturationStrike,
  SalvoLaunch,
  SaturationStyle,
  structureClusterCentres,
} from "@openfront/engine/execution/nation/NationNukePlanning";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { TestConfig } from "./util/TestConfig";

/** Real nuke, SAM and flight numbers, so the SAMs behave like in a game. */
class RealSamConfig extends TestConfig {
  nukeMagnitudes(unitType: UnitType): NukeMagnitude {
    return Config.prototype.nukeMagnitudes.call(this, unitType);
  }
  nukeSpeed(unitType: UnitType): number {
    return EngineConfig.prototype.nukeSpeed.call(this, unitType);
  }
  defaultNukeTargetableRange(): number {
    return EngineConfig.prototype.defaultNukeTargetableRange.call(this);
  }
  defaultSamRange(): number {
    return EngineConfig.prototype.defaultSamRange.call(this);
  }
  samRange(level: number): number {
    return Config.prototype.samRange.call(this, level);
  }
}

const HARD: SaturationStyle = {
  timed: true,
  assumeReloaded: true,
  spareDecoys: 1,
  maxDecoys: 8,
};
const IMPOSSIBLE: SaturationStyle = { ...HARD, assumeReloaded: false };
const MEDIUM: SaturationStyle = {
  timed: false,
  assumeReloaded: true,
  spareDecoys: 0,
  maxDecoys: 2,
};
const PLENTY = 1_000_000_000n;

function conquerRect(
  game: Game,
  player: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      player.conquer(game.ref(x, y));
    }
  }
}

/** A nation in the top-left corner with silos, a human in the bottom-right. */
async function setupDuel(difficulty = Difficulty.Hard) {
  const game = await setup(
    "big_plains",
    { difficulty },
    [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
      new PlayerInfo("human", PlayerType.Human, null, "human_id"),
    ],
    undefined,
    RealSamConfig,
  );
  const nation = game.player("nation_id");
  const human = game.player("human_id");
  conquerRect(game, nation, 0, 0, 30, 30);
  conquerRect(game, human, 100, 100, 200, 200);
  nation.addGold(100_000_000n);
  return { game, nation, human };
}

function buildSilos(game: Game, nation: Player, count: number, level = 1) {
  for (let i = 0; i < count; i++) {
    const silo = nation.buildUnit(
      UnitType.MissileSilo,
      game.ref(5 + 5 * i, 5),
      {},
    );
    silo.placeAtLevel(level);
  }
}

function buildSam(game: Game, owner: Player, tile: TileRef, level = 1): Unit {
  const sam = owner.buildUnit(UnitType.SAMLauncher, tile, {});
  sam.placeAtLevel(level);
  game.addExecution(new SAMLauncherExecution(owner, null, sam));
  return sam;
}

/** Launches the salvo and flies it out; whether its payload reached the target. */
function flySalvo(
  game: Game,
  nation: Player,
  target: TileRef,
  salvo: SalvoLaunch[],
): boolean {
  for (const launch of salvo) {
    game.addExecution(
      new NukeExecution(
        launch.type,
        nation,
        target,
        null,
        -1,
        launch.waitTicks,
      ),
    );
  }
  game.executeNextTick();
  game.executeNextTick();
  const bombs = nation.units(UnitType.AtomBomb, UnitType.HydrogenBomb);
  expect(bombs).toHaveLength(salvo.length);
  const payload = bombs.reduce((a, b) => (b.id() > a.id() ? b : a));
  expect(payload.type()).toBe(salvo[salvo.length - 1].type);
  for (let i = 0; i < 600 && payload.isActive(); i++) game.executeNextTick();
  expect(payload.isActive()).toBe(false);
  return payload.reachedTarget();
}

function nukeBehavior(game: Game, nation: Player): NationNukeBehavior {
  const emojiBehavior = new NationEmojiBehavior(
    new PseudoRandom(1),
    game,
    nation,
  );
  const attackBehavior = new NationAttackBehavior(
    new PseudoRandom(1),
    game,
    nation,
    0.5,
    0.3,
    0.2,
    new NationAllianceBehavior(
      new PseudoRandom(1),
      game,
      nation,
      emojiBehavior,
    ),
    emojiBehavior,
    new NationWarshipBehavior(new PseudoRandom(1), game, nation, emojiBehavior),
  );
  return new NationNukeBehavior(
    new PseudoRandom(2),
    game,
    nation,
    attackBehavior,
    emojiBehavior,
  );
}

describe("SAM saturation strikes", () => {
  it("a lone hydrogen bomb at a SAM-guarded city is shot down", async () => {
    const { game, nation, human } = await setupDuel();
    buildSilos(game, nation, 1);
    const target = game.ref(150, 150);
    human.buildUnit(UnitType.City, target, {});
    buildSam(game, human, game.ref(160, 150));

    expect(
      flySalvo(game, nation, target, [
        { type: UnitType.HydrogenBomb, waitTicks: 0 },
      ]),
    ).toBe(false);
  });

  it.each([1, 3])(
    "Hard gets a hydrogen bomb past a level %i SAM with atom bomb decoys",
    async (samLevel) => {
      const { game, nation, human } = await setupDuel();
      buildSilos(game, nation, 3, 3);
      const target = game.ref(150, 150);
      human.buildUnit(UnitType.City, target, {});
      buildSam(game, human, game.ref(160, 150), samLevel);

      const salvo = planSaturationStrike(
        game,
        nation,
        target,
        UnitType.HydrogenBomb,
        PLENTY,
        HARD,
      );
      expect(salvo).not.toBeNull();
      const decoys = salvo!.slice(0, -1);
      // One decoy per SAM missile, plus a spare
      expect(decoys.length).toBe(samLevel + 1);
      expect(decoys.every((d) => d.type === UnitType.AtomBomb)).toBe(true);
      expect(salvo![salvo!.length - 1].type).toBe(UnitType.HydrogenBomb);

      expect(flySalvo(game, nation, target, salvo!)).toBe(true);
      expect(human.units(UnitType.City)).toHaveLength(0);
    },
  );

  it("Hard saturates two SAMs covering the same city", async () => {
    const { game, nation, human } = await setupDuel();
    buildSilos(game, nation, 3, 3);
    const target = game.ref(150, 150);
    human.buildUnit(UnitType.City, target, {});
    buildSam(game, human, game.ref(160, 150), 2);
    buildSam(game, human, game.ref(150, 165), 2);

    const salvo = planSaturationStrike(
      game,
      nation,
      target,
      UnitType.HydrogenBomb,
      PLENTY,
      HARD,
    );
    expect(salvo).not.toBeNull();
    expect(salvo!.length - 1).toBeGreaterThanOrEqual(4);
    expect(flySalvo(game, nation, target, salvo!)).toBe(true);
  });

  it("Impossible exploits SAMs that are still reloading, Hard plays it safe", async () => {
    const { game, nation, human } = await setupDuel(Difficulty.Impossible);
    buildSilos(game, nation, 3, 3);
    const target = game.ref(150, 150);
    human.buildUnit(UnitType.City, target, {});
    const sam = buildSam(game, human, game.ref(160, 150), 2);
    // Both missiles just fired at something else
    sam.launch();
    sam.launch();

    const plan = (style: SaturationStyle) =>
      planSaturationStrike(
        game,
        nation,
        target,
        UnitType.HydrogenBomb,
        PLENTY,
        style,
      )!;
    expect(plan(HARD).length - 1).toBe(3);
    const impossible = plan(IMPOSSIBLE);
    expect(impossible.length - 1).toBeLessThan(3);
    expect(flySalvo(game, nation, target, impossible)).toBe(true);
  });

  it("Medium sends one decoy per covering SAM and holds the payload back", async () => {
    const { game, nation, human } = await setupDuel(Difficulty.Medium);
    buildSilos(game, nation, 3);
    const target = game.ref(130, 130);
    buildSam(game, human, game.ref(140, 130));
    buildSam(game, human, game.ref(120, 130));
    // Too far away to cover the target
    buildSam(game, human, game.ref(195, 195));

    const salvo = planSaturationStrike(
      game,
      nation,
      target,
      UnitType.AtomBomb,
      PLENTY,
      MEDIUM,
    );
    expect(salvo).toEqual([
      { type: UnitType.AtomBomb, waitTicks: 0 },
      { type: UnitType.AtomBomb, waitTicks: 0 },
      { type: UnitType.AtomBomb, waitTicks: 6 },
    ]);
  });

  it("plans nothing it can't pay for or launch", async () => {
    const { game, nation, human } = await setupDuel();
    const target = game.ref(150, 150);
    buildSam(game, human, game.ref(160, 150));
    // A single silo can't fire a decoy and the payload at once
    buildSilos(game, nation, 1);
    expect(
      planSaturationStrike(
        game,
        nation,
        target,
        UnitType.HydrogenBomb,
        PLENTY,
        HARD,
      ),
    ).toBeNull();

    buildSilos(game, nation, 3);
    const cost = (type: UnitType) => game.unitInfo(type).cost(game, nation);
    expect(
      planSaturationStrike(
        game,
        nation,
        target,
        UnitType.HydrogenBomb,
        cost(UnitType.HydrogenBomb) + cost(UnitType.AtomBomb) - 1n,
        HARD,
      ),
    ).toBeNull();
  });

  it("aims at the middle of a cluster of structures", async () => {
    const { game, human } = await setupDuel();
    human.buildUnit(UnitType.City, game.ref(120, 150), {});
    human.buildUnit(UnitType.City, game.ref(140, 150), {});
    human.buildUnit(UnitType.Factory, game.ref(130, 160), {});

    const centres = structureClusterCentres(
      game,
      human,
      human.units(UnitType.City, UnitType.Factory),
      30,
    );
    const best = centres.map((t) => [game.x(t), game.y(t)]);
    // City value 25k, factory 15k: pulled between the cities, toward the factory
    expect(best).toContainEqual([130, 152]);
  });
});

describe("Nation nukes past SAMs", () => {
  async function setupGuardedCity(difficulty: Difficulty, wideLand = true) {
    const { game, nation, human } = await setupDuel(difficulty);
    // Enough land around the cities for a hydrogen bomb's blast
    if (wideLand) conquerRect(game, human, 40, 40, 200, 200);
    buildSilos(game, nation, 3, 3);
    for (const [x, y] of [
      [140, 140],
      [150, 140],
      [140, 150],
      [150, 150],
    ]) {
      human.buildUnit(UnitType.City, game.ref(x, y), {});
    }
    buildSam(game, human, game.ref(145, 145), 2);
    nation.updateRelation(human, -100);
    return { game, nation, human };
  }

  function launch(game: Game, nation: Player): Unit[] {
    nukeBehavior(game, nation).maybeSendNuke();
    game.executeNextTick();
    game.executeNextTick();
    return nation.units(UnitType.AtomBomb, UnitType.HydrogenBomb);
  }

  it("Hard sends decoys ahead of a hydrogen bomb at a SAM-guarded city cluster", async () => {
    const { game, nation } = await setupGuardedCity(Difficulty.Hard);
    const bombs = launch(game, nation);

    // A level 2 SAM: two decoys for its missiles, one spare
    expect(bombs).toHaveLength(4);
    const target = bombs[0].targetTile();
    expect(bombs.every((b) => b.targetTile() === target)).toBe(true);
    const payload = bombs.reduce((a, b) => (b.id() > a.id() ? b : a));
    expect(payload.type()).toBe(UnitType.HydrogenBomb);
    expect(bombs.filter((b) => b !== payload).map((b) => b.type())).toEqual([
      UnitType.AtomBomb,
      UnitType.AtomBomb,
      UnitType.AtomBomb,
    ]);
  });

  it("Impossible outranges the SAM with a hydrogen bomb when it can, instead of paying for decoys", async () => {
    const { game, nation } = await setupGuardedCity(Difficulty.Impossible);
    const bombs = launch(game, nation);

    expect(bombs).toHaveLength(1);
    expect(bombs[0].type()).toBe(UnitType.HydrogenBomb);
    const samRange = game.config().samRange(2);
    expect(
      game.euclideanDistSquared(bombs[0].targetTile()!, game.ref(145, 145)),
    ).toBeGreaterThan(samRange * samRange);
  });

  it("Impossible saturates the SAM when the land is too small to outrange it", async () => {
    const { game, nation } = await setupGuardedCity(
      Difficulty.Impossible,
      false,
    );
    const bombs = launch(game, nation);

    expect(bombs.length).toBeGreaterThanOrEqual(3);
    const target = bombs[0].targetTile();
    expect(bombs.every((b) => b.targetTile() === target)).toBe(true);
  });

  it("Easy still sends a single bomb into the SAM", async () => {
    const { game, nation } = await setupGuardedCity(Difficulty.Easy);
    const bombs = launch(game, nation);
    expect(bombs.length).toBeLessThanOrEqual(1);
  });
});
