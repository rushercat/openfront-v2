import {
  GameFeature,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  DecreeType,
  PoliticsFactor,
  VoteChoice,
} from "@openfront/engine-api/game/Politics";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import {
  CastVoteExecution,
  PoliticsExecution,
  ProposeDecreeExecution,
} from "@openfront/engine/execution/PoliticsExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

const MAP = "big_plains";

let game: Game;
let alice: Player;
let bob: Player;
let carol: Player;
let politics: PoliticsExecution;

/** The congress's private state, for steering rounds in tests. */
interface Internals {
  phase: "idle" | "proposing" | "voting";
  nextRoundTick: number;
  offers: Map<number, DecreeType[]>;
  proposals: { id: number; decree: DecreeType }[];
}
const internals = () => politics as unknown as Internals;

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
  p.setSpawnTile(game.ref(x0, y0));
}

async function world(config: Partial<GameConfig> = {}) {
  game = await setup(
    MAP,
    { instantBuild: true, spawnImmunityDuration: 0, ...config },
    [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      new PlayerInfo("carol", PlayerType.Human, "client_c", "carol"),
    ],
  );
  alice = game.player("alice");
  bob = game.player("bob");
  carol = game.player("carol");
  conquerRect(alice, 0, 40, 100, 100); // 6000 tiles
  conquerRect(bob, 100, 40, 160, 100); // 3600 tiles
  conquerRect(carol, 160, 40, 200, 100); // 2400 tiles
  for (const p of [alice, bob, carol]) {
    p.addGold(1_000_000n);
    p.setUnrest(0);
  }
  politics = new PoliticsExecution("game");
  game.addExecution(politics);
  game.executeNextTick();
}

/** Skips the wait and opens a round in which `player` is offered `decree`. */
function openRound(player: Player, decree: DecreeType) {
  internals().nextRoundTick = game.ticks();
  game.executeNextTick();
  expect(internals().phase).toBe("proposing");
  internals().offers.set(player.smallID(), [decree]);
}

function vote(player: Player, proposalId: number, choice: VoteChoice) {
  game.addExecution(new CastVoteExecution(player, proposalId, choice));
}

/** Runs a whole round: `player` proposes `decree`, the others vote. */
function passDecree(
  decree: DecreeType,
  votes: Partial<Record<"alice" | "bob" | "carol", VoteChoice>> = {
    alice: "yes",
    bob: "yes",
    carol: "yes",
  },
  target: Player | null = null,
) {
  openRound(alice, decree);
  game.addExecution(
    new ProposeDecreeExecution(alice, decree, target?.id() ?? null),
  );
  // Everyone has proposed or the time ran out: voting starts.
  executeTicks(game, game.config().politicsProposalTicks() + 2);
  expect(internals().phase).toBe("voting");
  const id = internals().proposals[0].id;
  for (const [name, choice] of Object.entries(votes)) {
    vote(game.player(name), id, choice!);
  }
  executeTicks(game, game.config().politicsVotingTicks() + 2);
  expect(internals().phase).toBe("idle");
}

describe("world congress", () => {
  test("voting weight is the square root of the land plus a little gold", async () => {
    await world();
    const config = game.config();
    const withoutGold = Math.sqrt(alice.numTilesOwned());
    const weight = config.politicsVoteWeight(alice, false);
    expect(weight).toBeGreaterThan(withoutGold);
    // 1M gold → 0.25 × √1000 ≈ 7.9 on top.
    expect(weight - withoutGold).toBeCloseTo(
      config.politicsGoldWeight() * Math.sqrt(1000),
      0,
    );
    expect(config.politicsVoteWeight(alice, true)).toBeCloseTo(weight / 2, 1);
  });

  test("the first round opens after the wait and offers three decrees", async () => {
    await world();
    const first = internals().nextRoundTick;
    expect(first - game.ticks()).toBeGreaterThan(1000);
    executeTicks(game, first - game.ticks() + 1);
    expect(internals().phase).toBe("proposing");
    for (const p of [alice, bob, carol]) {
      const offers = internals().offers.get(p.smallID()) ?? [];
      expect(offers.length).toBe(3);
      expect(new Set(offers).size).toBe(3);
    }
  });

  test("a proposal costs a share of the proposer's gold", async () => {
    await world();
    openRound(alice, DecreeType.WorldBoom);
    const before = alice.gold();
    game.addExecution(
      new ProposeDecreeExecution(alice, DecreeType.WorldBoom, null),
    );
    game.executeNextTick();
    expect(internals().proposals.length).toBe(1);
    const percent = game.config().politicsProposalCostPercent();
    expect(Number(before - alice.gold())).toBeCloseTo(
      (Number(before) * percent) / 100,
      -1,
    );
  });

  test("decrees not on offer can't be proposed", async () => {
    await world();
    openRound(alice, DecreeType.WorldBoom);
    game.addExecution(
      new ProposeDecreeExecution(alice, DecreeType.Pandemic, null),
    );
    game.executeNextTick();
    expect(internals().proposals.length).toBe(0);
  });

  test("the same decree can't be proposed twice in one round", async () => {
    await world();
    openRound(alice, DecreeType.WorldBoom);
    internals().offers.set(bob.smallID(), [DecreeType.WorldBoom]);
    game.addExecution(
      new ProposeDecreeExecution(alice, DecreeType.WorldBoom, null),
      new ProposeDecreeExecution(bob, DecreeType.WorldBoom, null),
    );
    const bobGold = bob.gold();
    game.executeNextTick();
    expect(internals().proposals.length).toBe(1);
    // Bob paid nothing for the rejected proposal.
    expect(bob.gold()).toBeGreaterThanOrEqual(bobGold);
  });

  test("the game freezes while the congress votes", async () => {
    await world();
    game.addExecution(
      new PlayerExecution(alice),
      new PlayerExecution(bob),
      new PlayerExecution(carol),
    );
    openRound(alice, DecreeType.WorldBoom);
    game.addExecution(
      new ProposeDecreeExecution(alice, DecreeType.WorldBoom, null),
    );
    executeTicks(game, game.config().politicsProposalTicks() + 2);
    expect(internals().phase).toBe("voting");
    expect(game.isFrozen()).toBe(true);
    const troops = bob.troops();
    const gold = bob.gold();
    executeTicks(game, 20);
    expect(bob.troops()).toBe(troops);
    expect(bob.gold()).toBe(gold);
    // Votes still count while frozen; once everyone voted the game goes on.
    const id = internals().proposals[0].id;
    vote(alice, id, "yes");
    vote(bob, id, "yes");
    vote(carol, id, "abstain");
    executeTicks(game, 3);
    expect(internals().phase).toBe("idle");
    expect(game.isFrozen()).toBe(false);
    executeTicks(game, 20);
    expect(bob.troops()).toBeGreaterThan(troops);
  });

  test("a passed decree goes into force and runs out", async () => {
    await world();
    const calm = alice.politicsFactor(PoliticsFactor.GoldIncome);
    passDecree(DecreeType.WorldBoom);
    expect(politics.isDecreeActive(DecreeType.WorldBoom)).toBe(true);
    expect(alice.politicsFactor(PoliticsFactor.GoldIncome)).toBeCloseTo(
      calm * 1.25,
    );
    executeTicks(game, 180 * 10 + 5);
    expect(politics.isDecreeActive(DecreeType.WorldBoom)).toBe(false);
  });

  test("a majority of no sinks it", async () => {
    await world();
    passDecree(DecreeType.WorldBoom, {
      alice: "no",
      bob: "yes",
      carol: "no",
    });
    expect(politics.isDecreeActive(DecreeType.WorldBoom)).toBe(false);
  });

  test("a single veto sinks it and costs the vetoing player gold", async () => {
    await world();
    const before = carol.gold();
    passDecree(DecreeType.WorldBoom, {
      alice: "yes",
      bob: "yes",
      carol: "veto",
    });
    expect(politics.isDecreeActive(DecreeType.WorldBoom)).toBe(false);
    const percent = game.config().politicsVetoCostPercent();
    expect(Number(before - carol.gold())).toBeCloseTo(
      (Number(before) * percent) / 100,
      -1,
    );
  });

  test("without a quorum nothing passes", async () => {
    await world();
    passDecree(DecreeType.WorldBoom, {
      alice: "abstain",
      bob: "abstain",
      carol: "yes",
    });
    expect(politics.isDecreeActive(DecreeType.WorldBoom)).toBe(false);
  });

  test("the target of a decree can't vote on it", async () => {
    await world();
    passDecree(
      DecreeType.Scapegoat,
      { alice: "yes", bob: "yes", carol: "veto" },
      carol,
    );
    // Carol's veto didn't count.
    expect(politics.isDecreeActive(DecreeType.Scapegoat)).toBe(true);
    expect(carol.politicsFactor(PoliticsFactor.TroopGrowth)).toBeCloseTo(0.8);
    expect(bob.politicsFactor(PoliticsFactor.TroopGrowth)).toBeCloseTo(1);
  });

  test("ceasefire: no attacks between players, ongoing ones stop", async () => {
    await world();
    expect(alice.canAttackPlayer(bob)).toBe(true);
    passDecree(DecreeType.Ceasefire);
    expect(alice.canAttackPlayer(bob)).toBe(false);
    expect(alice.canBuild(UnitType.AtomBomb, game.ref(130, 70))).toBe(false);
  });

  test("nuclear peace forbids nukes", async () => {
    await world();
    alice.buildUnit(UnitType.MissileSilo, game.ref(30, 70), {});
    expect(politics.forbidsUnit(alice, UnitType.AtomBomb)).toBe(false);
    passDecree(DecreeType.NuclearPeace);
    expect(politics.forbidsUnit(alice, UnitType.AtomBomb)).toBe(true);
    expect(politics.forbidsUnit(alice, UnitType.City)).toBe(false);
    expect(alice.canBuild(UnitType.AtomBomb, game.ref(130, 70))).toBe(false);
  });

  test("disarmament destroys every missile silo", async () => {
    await world();
    alice.buildUnit(UnitType.MissileSilo, game.ref(30, 70), {});
    expect(game.units(UnitType.MissileSilo).length).toBe(1);
    passDecree(DecreeType.Disarmament);
    expect(game.units(UnitType.MissileSilo).length).toBe(0);
    expect(alice.canBuild(UnitType.MissileSilo, game.ref(30, 70))).toBe(false);
  });

  test("a recession makes buildings dearer", async () => {
    await world();
    const before = game.unitInfo(UnitType.City).cost(game, alice);
    passDecree(DecreeType.Recession);
    const after = game.unitInfo(UnitType.City).cost(game, alice);
    expect(Number(after)).toBeCloseTo(Number(before) * 1.25, -1);
  });

  test("no malus decree on the same player twice in a row", async () => {
    await world();
    passDecree(DecreeType.Scapegoat, { alice: "yes", bob: "yes" }, carol);
    executeTicks(game, 180 * 10 + 5);
    openRound(alice, DecreeType.Sanctions);
    game.addExecution(
      new ProposeDecreeExecution(alice, DecreeType.Sanctions, carol.id()),
    );
    game.executeNextTick();
    expect(internals().proposals.length).toBe(0);
  });

  test("sends its state to the client", async () => {
    await world();
    internals().nextRoundTick = game.ticks();
    const updates = game.executeNextTick();
    const states = updates[GameUpdateType.Politics];
    expect(states.length).toBeGreaterThan(0);
    expect(states[states.length - 1].state.phase).toBe("proposing");
  });

  test("nations vote as soon as the vote opens", async () => {
    game = await setup(MAP, { instantBuild: true, spawnImmunityDuration: 0 }, [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    ]);
    alice = game.player("alice");
    bob = game.player("bob");
    const nation = game.player("nation");
    conquerRect(alice, 0, 40, 100, 100);
    conquerRect(bob, 100, 40, 160, 100);
    conquerRect(nation, 160, 40, 200, 100);
    politics = new PoliticsExecution("game");
    game.addExecution(politics);
    game.executeNextTick();
    openRound(alice, DecreeType.Pandemic);
    game.addExecution(
      new ProposeDecreeExecution(alice, DecreeType.Pandemic, null),
    );
    executeTicks(game, game.config().politicsProposalTicks() + 2);
    expect(internals().phase).toBe("voting");
    const state = (
      politics as unknown as {
        proposals: { votes: Map<number, VoteChoice> }[];
      }
    ).proposals[0];
    expect(state.votes.has(nation.smallID())).toBe(true);
  });

  test("nations leave proposal slots for the humans", async () => {
    game = await setup(MAP, { instantBuild: true, spawnImmunityDuration: 0 }, [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("n1", PlayerType.Nation, null, "n1"),
      new PlayerInfo("n2", PlayerType.Nation, null, "n2"),
      new PlayerInfo("n3", PlayerType.Nation, null, "n3"),
    ]);
    alice = game.player("alice");
    const nations = ["n1", "n2", "n3"].map((n) => game.player(n));
    conquerRect(alice, 0, 40, 50, 100);
    nations.forEach((n, i) =>
      conquerRect(n, 50 + i * 50, 40, 100 + i * 50, 100),
    );
    for (const p of [alice, ...nations]) p.addGold(1_000_000n);
    politics = new PoliticsExecution("game");
    game.addExecution(politics);
    game.executeNextTick();
    internals().nextRoundTick = game.ticks();
    game.executeNextTick();
    expect(internals().phase).toBe("proposing");
    // One human: three of the four slots are free, nations take at most two.
    expect(politics.nationProposalCap()).toBe(2);
    const decrees = [
      DecreeType.WorldBoom,
      DecreeType.Pandemic,
      DecreeType.FreeTrade,
    ];
    internals().proposals.length = 0;
    nations.forEach((n, i) => {
      internals().offers.set(n.smallID(), [decrees[i]]);
      politics.propose(n, decrees[i], null);
    });
    expect(internals().proposals.length).toBe(2);
    internals().offers.set(alice.smallID(), [DecreeType.MarshallPlan]);
    expect(politics.propose(alice, DecreeType.MarshallPlan, null)).toBe(true);
  });

  test("can be switched off", async () => {
    game = await setup(MAP, { disabledFeatures: [GameFeature.Politics] });
    expect(game.config().isFeatureDisabled(GameFeature.Politics)).toBe(true);
  });

  test("survives a snapshot in the middle of a vote", async () => {
    await world();
    openRound(alice, DecreeType.WorldBoom);
    game.addExecution(
      new ProposeDecreeExecution(alice, DecreeType.WorldBoom, null),
    );
    executeTicks(game, game.config().politicsProposalTicks() + 2);
    expect(game.isFrozen()).toBe(true);
    await expectSnapshotRoundTrip(game, MAP, 20);
  });
});
