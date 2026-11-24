import {
  MAX_STORED_MATCHES,
  MAX_UNSAVED_REPLAYS,
  planPrune,
  type MatchSummary,
} from "../../../src/client/chronicle/LocalMatchStore";

function game(id: string, extra: Partial<MatchSummary> = {}): MatchSummary {
  return {
    gameID: id,
    savedAt: 0,
    startedAt: 0,
    durationTicks: 0,
    map: "World",
    mode: "Free For All",
    myName: null,
    result: "played",
    winnerName: null,
    playerCount: 2,
    hasReplay: true,
    gitCommit: "DEV",
    ...extra,
  };
}

describe("LocalMatchStore.planPrune", () => {
  test("keeps the replays of the newest unsaved games only", () => {
    // Newest first, as listMatches returns them.
    const games = ["g5", "g4", "g3", "g2", "g1"].map((id) => game(id));
    const { remove, expire } = planPrune(games);
    expect(MAX_UNSAVED_REPLAYS).toBe(3);
    expect(remove).toEqual([]);
    expect(expire).toEqual(["g2", "g1"]);
  });

  test("saved games keep their replay and don't count", () => {
    const games = [
      game("g5"),
      game("g4", { saved: true }),
      game("g3"),
      game("g2", { saved: true }),
      game("g1"),
      game("g0"),
    ];
    const { expire } = planPrune(games);
    // g5, g3, g1 are the three newest unsaved; g0 goes.
    expect(expire).toEqual(["g0"]);
  });

  test("games without a replay or already expired don't use a slot", () => {
    const games = [
      game("g5", { hasReplay: false }),
      game("g4"),
      game("g3", { replayExpired: true }),
      game("g2"),
      game("g1"),
      game("g0"),
    ];
    expect(planPrune(games).expire).toEqual(["g0"]);
  });

  test("drops the oldest unsaved games beyond the list limit, never saved ones", () => {
    const games: MatchSummary[] = [];
    for (let i = 0; i < MAX_STORED_MATCHES + 2; i++) {
      games.push(game(`g${i}`, { saved: i === MAX_STORED_MATCHES + 1 }));
    }
    const { remove } = planPrune(games);
    expect(remove).toEqual([`g${MAX_STORED_MATCHES}`]);
  });
});
