import {
  DRAFT_CARDS,
  DRAFT_EPOCHS,
  DraftCardId,
  draftPool,
  draftSettings,
  DraftViewState,
  epochOffers,
} from "@openfront/engine-api/game/Draft";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { PoliticsFactor } from "@openfront/engine-api/game/Politics";
import { DraftConfig, GameConfig } from "@openfront/engine-api/Schemas";
import {
  DraftExecution,
  DraftPickExecution,
  DraftResearchExecution,
} from "@openfront/engine/execution/DraftExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { expectSnapshotRoundTrip } from "./util/Snapshot";
import { executeTicks } from "./util/utils";

const MAP = "big_plains";

let game: Game;
let alice: Player;
let bob: Player;
let carol: Player;
let draft: DraftExecution;

interface Internals {
  phase: "waiting" | "picking" | "done";
  round: number;
  offers: Map<number, DraftCardId[]>;
  decks: Map<number, Map<DraftCardId, number>>;
  received: [number, DraftCardId, number][];
}
const internals = () => draft as unknown as Internals;

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

async function world(
  cfg: Partial<DraftConfig> = {},
  extra: Partial<GameConfig> = {},
) {
  game = await setup(
    MAP,
    {
      instantBuild: true,
      spawnImmunityDuration: 0,
      draft: { enabled: true, pickSeconds: 3, ...cfg },
      ...extra,
    },
    [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      new PlayerInfo("carol", PlayerType.Human, "client_c", "carol"),
    ],
  );
  alice = game.player("alice");
  bob = game.player("bob");
  carol = game.player("carol");
  conquerRect(alice, 0, 40, 100, 100);
  conquerRect(bob, 100, 40, 160, 100);
  conquerRect(carol, 160, 40, 200, 100);
  for (const p of [alice, bob, carol]) {
    p.addGold(20_000_000n);
    p.setUnrest(0);
  }
  draft = new DraftExecution("game");
  game.addExecution(draft);
  // Initialized on a tick, the first round opens on the next one.
  for (let i = 0; i < 10 && internals().phase !== "picking"; i++) {
    game.executeNextTick();
  }
}

const deck = (p: Player) => internals().decks.get(p.smallID())!;

/** Runs the whole draft without anyone picking (timeouts pick at random). */
function runDraft() {
  const s = draftSettings(game.config().gameConfig().draft)!;
  executeTicks(game, (s.pickSeconds * 10 + 3) * s.picks + 5);
}

describe("draft mode", () => {
  test("settings fill in defaults; doctrines draw from their own pool", () => {
    const s = draftSettings({ enabled: true })!;
    expect(s.picks).toBe(6);
    expect(s.baseSet).toBe(true);
    expect(draftSettings({ enabled: false })).toBeNull();
    expect(draftPool(s)).not.toContain(DraftCardId.City);
    expect(draftPool(s).every((c) => !DRAFT_CARDS[c].doctrine)).toBe(true);
    const doc = draftSettings({ enabled: true, tech: "doctrines" })!;
    expect(doc.picks).toBe(3);
    expect(draftPool(doc).every((c) => DRAFT_CARDS[c].doctrine)).toBe(true);
    const hardcore = draftSettings({ enabled: true, baseSet: false })!;
    expect(draftPool(hardcore)).toContain(DraftCardId.City);
  });

  test("before the game: frozen rounds, two cards each, one kept", async () => {
    await world({ picks: 4 });
    game.addExecution(new PlayerExecution(alice), new PlayerExecution(bob));
    expect(internals().phase).toBe("picking");
    game.executeNextTick();
    expect(game.isFrozen()).toBe(true);
    const offer = internals().offers.get(alice.smallID())!;
    expect(offer.length).toBe(2);
    // Two different categories.
    expect(DRAFT_CARDS[offer[0]].category).not.toBe(
      DRAFT_CARDS[offer[1]].category,
    );
    game.addExecution(new DraftPickExecution(alice, offer[1]));
    // A card that is not on offer is ignored.
    const other = Object.values(DraftCardId).find((c) => !offer.includes(c))!;
    game.addExecution(new DraftPickExecution(bob, other));
    const troops = bob.troops();
    executeTicks(game, 10);
    expect(bob.troops()).toBe(troops);
    runDraft();
    expect(deck(alice).has(offer[1])).toBe(true);
    expect(internals().phase).toBe("done");
    expect(game.isFrozen()).toBe(false);
    // Four picks, plus any prerequisites that came with them.
    for (const p of [alice, bob, carol]) {
      expect(deck(p).size).toBeGreaterThanOrEqual(4);
    }
    executeTicks(game, 20);
    expect(bob.troops()).toBeGreaterThan(troops);
  });

  test("only what the deck unlocks can be built; the base set is free", async () => {
    await world({ picks: 1 });
    const tile = game.ref(30, 70);
    deck(alice).clear();
    expect(alice.canBuild(UnitType.City, tile)).not.toBe(false);
    expect(alice.canBuild(UnitType.SAMLauncher, tile)).toBe(false);
    expect(alice.canBuild(UnitType.MissileSilo, tile)).toBe(false);
    deck(alice).set(DraftCardId.Sam, 1);
    (
      draft as unknown as { unlockedCache: Map<number, unknown> }
    ).unlockedCache.clear();
    expect(alice.canBuild(UnitType.SAMLauncher, tile)).not.toBe(false);
  });

  test("without the base set, cities need their card too", async () => {
    await world({ picks: 1, baseSet: false });
    deck(alice).clear();
    expect(alice.canBuild(UnitType.City, game.ref(30, 70))).toBe(false);
  });

  test("a guaranteed defense card by the middle of the draft", async () => {
    await world({ picks: 6 });
    runDraft();
    for (const p of [alice, bob, carol]) {
      expect(
        [DraftCardId.Sam, DraftCardId.Flak].some((c) => deck(p).has(c)),
      ).toBe(true);
    }
  });

  test("picking an upgrade brings its prerequisite (mirrored offers)", async () => {
    await world({ picks: 8, offers: "mirrored" });
    const offers = internals().offers;
    // Everyone sees the same pair.
    expect(offers.get(alice.smallID())).toEqual(offers.get(bob.smallID()));
    runDraft();
    for (const p of [alice, bob, carol]) {
      for (const card of deck(p).keys()) {
        for (const req of DRAFT_CARDS[card].requires) {
          if (req === DraftCardId.Port) continue; // base set
          expect(deck(p).has(req)).toBe(true);
        }
      }
    }
  });

  test("the card passed on goes to the next opponent", async () => {
    await world({ picks: 3, declinedToOpponent: true });
    game.executeNextTick();
    const offer = internals().offers.get(alice.smallID())!;
    game.addExecution(new DraftPickExecution(alice, offer[0]));
    executeTicks(game, 40);
    expect(internals().received).toContainEqual([
      bob.smallID(),
      offer[1],
      alice.smallID(),
    ]);
    expect(deck(bob).has(offer[1])).toBe(true);
  });

  test("during the game: rounds come every interval and don't freeze", async () => {
    await world({ picks: 2, timing: "during", intervalSeconds: 30 });
    expect(internals().phase).toBe("picking");
    executeTicks(game, 5);
    expect(game.isFrozen()).toBe(false);
    executeTicks(game, 30);
    expect(internals().phase).toBe("waiting");
    expect(internals().round).toBe(1);
    executeTicks(game, 300);
    expect(internals().phase).toBe("picking");
    executeTicks(game, 40);
    expect(internals().round).toBe(2);
    expect(internals().phase).toBe("done");
  });

  test("levels: research raises a card and makes its units cheaper", async () => {
    await world({ picks: 1, tech: "levels" });
    runDraft();
    deck(alice).set(DraftCardId.Sam, 1);
    const before = game.unitInfo(UnitType.SAMLauncher).cost(game, alice);
    const gold = alice.gold();
    game.addExecution(new DraftResearchExecution(alice, DraftCardId.Sam));
    game.executeNextTick();
    expect(alice.gold()).toBe(gold - 1_000_000n);
    executeTicks(game, 210);
    expect(deck(alice).get(DraftCardId.Sam)).toBe(2);
    const after = game.unitInfo(UnitType.SAMLauncher).cost(game, alice);
    expect(Number(after)).toBeCloseTo(Number(before) * 0.85, -2);
  });

  test("doctrines: research unlocks the next tier", async () => {
    await world({ picks: 1, tech: "doctrines" });
    runDraft();
    deck(alice).clear();
    deck(alice).set(DraftCardId.DocAir, 1);
    const cache = (draft as unknown as { unlockedCache: Map<number, unknown> })
      .unlockedCache;
    cache.clear();
    expect(draft.allowsUnit(alice, UnitType.FighterJet)).toBe(true);
    expect(draft.allowsUnit(alice, UnitType.Bomber)).toBe(false);
    game.addExecution(new DraftResearchExecution(alice, DraftCardId.DocAir));
    executeTicks(game, 310);
    expect(deck(alice).get(DraftCardId.DocAir)).toBe(2);
    expect(draft.allowsUnit(alice, UnitType.Bomber)).toBe(true);
    expect(draft.allowsUnit(alice, UnitType.TransportPlane)).toBe(false);
  });

  test("perks change income, troop growth and attack losses", async () => {
    await world({ picks: 1 });
    runDraft();
    deck(alice).clear();
    deck(bob).clear();
    deck(alice).set(DraftCardId.StateBank, 1);
    deck(alice).set(DraftCardId.Conscription, 1);
    deck(alice).set(DraftCardId.EliteTroops, 1);
    deck(bob).set(DraftCardId.Fortress, 1);
    expect(alice.politicsFactor(PoliticsFactor.GoldIncome)).toBeCloseTo(1.1);
    expect(alice.politicsFactor(PoliticsFactor.TroopGrowth)).toBeCloseTo(1.1);
    expect(draft.attackLossFactor(alice, bob)).toBeCloseTo(0.92 * 1.1);
    expect(draft.attackLossFactor(carol, null)).toBe(1);
  });

  test("tells the view what it needs", async () => {
    await world({ picks: 2 });
    const offer = internals().offers.get(alice.smallID())!;
    game.addExecution(new DraftPickExecution(alice, offer[0]));
    // The pick lands at the end of this tick, the view update with the next.
    game.executeNextTick();
    const updates = game.executeNextTick();
    const states = updates[GameUpdateType.Draft] as unknown as {
      state: DraftViewState;
    }[];
    expect(states.length).toBeGreaterThan(0);
    const state = states[states.length - 1].state;
    expect(state.rounds).toBe(2);
    expect(state.offers.length).toBe(3);
    expect(state.freezeStart).not.toBeNull();
  });

  test("survives a snapshot in the middle of the draft", async () => {
    await world({ picks: 4, tech: "levels", declinedToOpponent: true });
    executeTicks(game, 35);
    expect(game.isFrozen()).toBe(true);
    await expectSnapshotRoundTrip(game, MAP, 40);
  });
});

describe("epochs mode", () => {
  test("offers: three arms first, then raise your branch or go new", () => {
    const s = draftSettings({ enabled: true, tech: "epochs" })!;
    expect(s.picks).toBe(DRAFT_EPOCHS);
    expect(s.timing).toBe("during");
    expect(s.baseSet).toBe(true);
    expect(draftPool(s).every((c) => DRAFT_CARDS[c].doctrine)).toBe(true);

    const empty = new Map<DraftCardId, number>();
    expect(epochOffers(0, empty)).toEqual([
      DraftCardId.DocArmy,
      DraftCardId.DocNavy,
      DraftCardId.DocAir,
    ]);
    const air1 = new Map([[DraftCardId.DocAir, 1]]);
    expect(epochOffers(1, air1)).toEqual([
      DraftCardId.DocAir,
      DraftCardId.DocNuclear,
      DraftCardId.DocDefense,
    ]);
    // Specialist: air 2 → raise it, plus nuclear and defense.
    const air2 = new Map([[DraftCardId.DocAir, 2]]);
    expect(epochOffers(2, air2)).toEqual([
      DraftCardId.DocAir,
      DraftCardId.DocNuclear,
      DraftCardId.DocDefense,
    ]);
    // Two branches: both can be raised, plus one new.
    const mixed = new Map([
      [DraftCardId.DocNavy, 1],
      [DraftCardId.DocNuclear, 1],
    ]);
    const third = epochOffers(2, mixed);
    expect(third).toHaveLength(3);
    expect(third).toContain(DraftCardId.DocNavy);
    expect(third).toContain(DraftCardId.DocNuclear);
    expect(third[2]).toBe(DraftCardId.DocDefense);
    // Switched-off units take a doctrine out of the offer.
    expect(
      epochOffers(0, empty, (c) => c !== DraftCardId.DocNavy),
    ).not.toContain(DraftCardId.DocNavy);
  });

  test("three frozen choices, one per epoch, no research", async () => {
    await world({ tech: "epochs", intervalSeconds: 30, pickSeconds: 3 });
    game.addExecution(new PlayerExecution(alice), new PlayerExecution(bob));
    expect(internals().phase).toBe("picking");
    game.executeNextTick();
    expect(game.isFrozen()).toBe(true);

    // Epoch I: three arms, alice goes air.
    const first = internals().offers.get(alice.smallID())!;
    expect(first).toHaveLength(3);
    game.addExecution(new DraftPickExecution(alice, DraftCardId.DocAir));
    executeTicks(game, 3 * 10 + 3);
    expect(internals().phase).toBe("waiting");
    expect(game.isFrozen()).toBe(false);
    expect(deck(alice).get(DraftCardId.DocAir)).toBe(1);
    expect(game.draft()!.allowsUnit(alice, UnitType.FighterJet)).toBe(true);
    expect(game.draft()!.allowsUnit(alice, UnitType.Bomber)).toBe(false);
    expect(game.draft()!.allowsUnit(alice, UnitType.AtomBomb)).toBe(false);
    // Base set stays open.
    expect(game.draft()!.allowsUnit(alice, UnitType.City)).toBe(true);
    // No research in this mode.
    const gold = alice.gold();
    game.addExecution(new DraftResearchExecution(alice, DraftCardId.DocAir));
    executeTicks(game, 2);
    // Nothing paid (income still flows in).
    expect(alice.gold() >= gold).toBe(true);

    // The game runs between epochs.
    const troops = alice.troops();
    executeTicks(game, 100);
    expect(alice.troops()).not.toBe(troops);

    // Epoch II: raise air.
    for (let i = 0; i < 400 && internals().phase !== "picking"; i++) {
      game.executeNextTick();
    }
    expect(internals().round).toBe(1);
    game.executeNextTick();
    expect(game.isFrozen()).toBe(true);
    expect(internals().offers.get(alice.smallID())![0]).toBe(
      DraftCardId.DocAir,
    );
    game.addExecution(new DraftPickExecution(alice, DraftCardId.DocAir));
    executeTicks(game, 3 * 10 + 3);
    expect(deck(alice).get(DraftCardId.DocAir)).toBe(2);
    expect(game.draft()!.allowsUnit(alice, UnitType.Bomber)).toBe(true);

    // Epoch III, then done and never frozen again.
    for (let i = 0; i < 400 && internals().phase !== "picking"; i++) {
      game.executeNextTick();
    }
    game.addExecution(new DraftPickExecution(alice, DraftCardId.DocAir));
    executeTicks(game, 3 * 10 + 3);
    expect(internals().phase).toBe("done");
    expect(deck(alice).get(DraftCardId.DocAir)).toBe(3);
    expect(game.isFrozen()).toBe(false);
    // Bob never picked: three random choices, still three levels in all.
    const bobLevels = [...deck(bob).values()].reduce((a, b) => a + b, 0);
    expect(bobLevels).toBe(3);
  });

  test("survives a snapshot in the middle of an epoch choice", async () => {
    await world({ tech: "epochs", intervalSeconds: 30 });
    game.executeNextTick();
    await expectSnapshotRoundTrip(game, MAP, 40);
  });
});
