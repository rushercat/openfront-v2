import { MessageType, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, test } from "vitest";
import {
  describeEvent,
  formatMatchTime,
  isKeyMoment,
} from "../../../src/client/chronicle/ChronicleText";
import {
  ChronicleSource,
  ChronicleSourcePlayer,
  MatchChronicle,
  SAMPLE_TICKS,
} from "../../../src/client/chronicle/MatchChronicle";
import {
  defaultSelection,
  compactNumber,
} from "../../../src/client/chronicle/MatchStatsModal";

class FakePlayer implements ChronicleSourcePlayer {
  alive = true;
  tiles = 100;
  goldAmount = 1000n;
  troopCount = 500;
  attacks: { targetID: number }[] = [];
  constructor(
    private readonly sid: number,
    private readonly playerName: string,
    private readonly playerType: PlayerType = PlayerType.Human,
  ) {}
  smallID() {
    return this.sid;
  }
  id() {
    return `p${this.sid}`;
  }
  name() {
    return this.playerName;
  }
  type() {
    return this.playerType;
  }
  team() {
    return null;
  }
  isAlive() {
    return this.alive;
  }
  isPlayer() {
    return true;
  }
  hasSpawned() {
    return true;
  }
  numTilesOwned() {
    return this.tiles;
  }
  gold() {
    return this.goldAmount;
  }
  troops() {
    return this.troopCount;
  }
  territoryColor() {
    return { toHex: () => `#00000${this.sid}` };
  }
  outgoingAttacks() {
    return this.attacks;
  }
}

class FakeGame implements ChronicleSource {
  tick = 0;
  spawn = true;
  updates: Record<number, unknown[]> = {};
  constructor(
    readonly all: FakePlayer[],
    readonly me: FakePlayer | null,
  ) {}
  ticks() {
    return this.tick;
  }
  inSpawnPhase() {
    return this.spawn;
  }
  players() {
    return this.all;
  }
  myPlayer() {
    return this.me;
  }
  playerBySmallID(id: number) {
    return (
      this.all.find((p) => p.smallID() === id) ?? { isPlayer: () => false }
    );
  }
  player(id: string) {
    const p = this.all.find((x) => x.id() === id);
    if (p === undefined) throw new Error("no player");
    return p;
  }
  unit(id: number) {
    const owner = this.all.find((p) => p.smallID() === id);
    return owner === undefined ? undefined : { owner: () => owner };
  }
  updatesSinceLastTick() {
    return this.updates as never;
  }
  /** Runs ticks up to `tick`, each with no updates. */
  runTo(chronicle: MatchChronicle, tick: number) {
    while (this.tick < tick) {
      this.tick++;
      this.updates = {};
      chronicle.observe(this);
    }
  }
  /** One tick with these updates. */
  step(chronicle: MatchChronicle, updates: Record<number, unknown[]>) {
    this.tick++;
    this.updates = updates;
    chronicle.observe(this);
    this.updates = {};
  }
}

function setup() {
  const me = new FakePlayer(1, "Me");
  const bob = new FakePlayer(2, "Bob");
  const nation = new FakePlayer(3, "France", PlayerType.Nation);
  const tribe = new FakePlayer(4, "Tribe", PlayerType.Bot);
  const game = new FakeGame([me, bob, nation, tribe], me);
  const chronicle = new MatchChronicle();
  game.runTo(chronicle, 10);
  game.spawn = false;
  return { me, bob, nation, tribe, game, chronicle };
}

describe("MatchChronicle", () => {
  test("samples territory, gold and troops of players and nations, not tribes", () => {
    const { me, game, chronicle } = setup();
    game.runTo(chronicle, SAMPLE_TICKS * 3);
    me.tiles = 250;
    me.goldAmount = 5000n;
    game.runTo(chronicle, SAMPLE_TICKS * 4);
    const samples = chronicle.samples();
    expect(samples.length).toBe(4);
    const last = samples[samples.length - 1];
    expect(last.values[1]).toEqual([250, 5000, 500]);
    expect(last.values[3]).toBeDefined();
    expect(last.values[4]).toBeUndefined();
    expect(chronicle.startTick()).toBe(11);
    expect(chronicle.me()).toBe(1);
  });

  test("records alliances, betrayals, embargos and nukes", () => {
    const { game, chronicle } = setup();
    game.step(chronicle, {
      [GameUpdateType.AllianceRequestReply]: [
        { request: { requestorID: 1, recipientID: 2 }, accepted: true },
        { request: { requestorID: 3, recipientID: 2 }, accepted: false },
      ],
    });
    game.step(chronicle, {
      [GameUpdateType.BrokeAlliance]: [
        { traitorID: 2, betrayedID: 1, allianceID: 7 },
      ],
      [GameUpdateType.EmbargoEvent]: [
        { event: "start", playerID: 3, embargoedID: 1 },
      ],
      [GameUpdateType.UnitIncoming]: [
        {
          unitID: 3,
          playerID: 1,
          messageType: MessageType.HYDROGEN_BOMB_INBOUND,
          message: "",
        },
      ],
    });
    const kinds = chronicle.events().map((e) => e.kind);
    expect(kinds).toEqual(["alliance", "betrayal", "embargo", "nuke"]);
    const betrayal = chronicle.events()[1];
    // translateText falls back to the key in tests
    expect(describeEvent(betrayal, chronicle)).toBe("match_log.betrayal_you");
    expect(isKeyMoment(betrayal, chronicle.me())).toBe(true);
    expect(chronicle.events()[3].nuke).toBe("hydro");
  });

  test("an embargo is told once until it is lifted", () => {
    const { game, chronicle } = setup();
    const embargo = (event: "start" | "stop") => ({
      [GameUpdateType.EmbargoEvent]: [{ event, playerID: 3, embargoedID: 1 }],
    });
    game.step(chronicle, embargo("start"));
    game.step(chronicle, embargo("start"));
    game.step(chronicle, embargo("stop"));
    game.step(chronicle, embargo("stop"));
    game.step(chronicle, embargo("start"));
    expect(chronicle.events().map((e) => e.kind)).toEqual([
      "embargo",
      "embargo_end",
      "embargo",
    ]);
  });

  test("a war starts with the first attack between players at peace, once", () => {
    const { bob, tribe, game, chronicle } = setup();
    bob.attacks = [{ targetID: 1 }, { targetID: 4 }];
    game.runTo(chronicle, 40);
    let wars = chronicle.events().filter((e) => e.kind === "war");
    expect(wars).toHaveLength(1);
    expect(wars[0]).toMatchObject({ a: 2, b: 1 });
    // Peace through an alliance, then a new attack is a new war
    game.step(chronicle, {
      [GameUpdateType.AllianceRequestReply]: [
        { request: { requestorID: 1, recipientID: 2 }, accepted: true },
      ],
    });
    game.runTo(chronicle, 60);
    wars = chronicle.events().filter((e) => e.kind === "war");
    expect(wars).toHaveLength(2);
    expect(tribe.attacks).toHaveLength(0);
  });

  test("eliminations: by conquest with the conqueror, or on their own", () => {
    const { bob, nation, game, chronicle } = setup();
    game.step(chronicle, {
      [GameUpdateType.ConquestEvent]: [
        { conquerorId: "p1", conqueredId: "p2", gold: 0n },
      ],
    });
    bob.alive = false;
    game.runTo(chronicle, 20);
    nation.alive = false;
    game.runTo(chronicle, 25);
    const eliminated = chronicle
      .events()
      .filter((e) => e.kind === "eliminated");
    expect(eliminated).toHaveLength(2);
    expect(eliminated[0]).toMatchObject({ a: 2, b: 1 });
    expect(eliminated[1].a).toBe(3);
    expect(eliminated[1].b).toBeUndefined();
  });

  test("round-trips through toData and thins long games", () => {
    const { game, chronicle } = setup();
    game.runTo(chronicle, SAMPLE_TICKS * 900);
    const data = chronicle.toData();
    expect(data.samples.length).toBe(400);
    expect(data.samples[data.samples.length - 1].tick).toBe(SAMPLE_TICKS * 900);
    const restored = MatchChronicle.fromData(data);
    expect(restored.samples().length).toBe(400);
    expect(restored.players()[2].name).toBe("Bob");
  });

  test("the graphs start with me, my betrayer and the biggest", () => {
    const { bob, nation, game, chronicle } = setup();
    nation.tiles = 5000;
    bob.tiles = 10;
    game.step(chronicle, {
      [GameUpdateType.BrokeAlliance]: [
        { traitorID: 2, betrayedID: 1, allianceID: 1 },
      ],
    });
    game.runTo(chronicle, SAMPLE_TICKS * 2);
    expect(defaultSelection(chronicle)).toEqual([1, 2, 3]);
  });
});

describe("chronicle text", () => {
  test("formats game time from the end of the spawn phase", () => {
    expect(formatMatchTime(100, 100)).toBe("0:00");
    expect(formatMatchTime(100 + 754 * 10, 100)).toBe("12:34");
    expect(formatMatchTime(36_000 + 50, 50)).toBe("1:00:00");
    expect(compactNumber(12_345)).toBe("12.3K");
    expect(compactNumber(4_500_000)).toBe("4.5M");
  });
});
