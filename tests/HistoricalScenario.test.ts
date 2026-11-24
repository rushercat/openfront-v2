/**
 * Historical scenarios (engine-lib/game/HistoricalScenarios.ts): nations at
 * their historical places with starting borders and fixed bloc alliances.
 */

import {
  GameMapType,
  GameType,
  HistoricalScenarioId,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  MISSION_HOLD_TICKS,
  type MissionsViewState,
} from "@openfront/engine-api/game/Missions";
import {
  assignScenarioNations,
  HISTORICAL_SCENARIOS,
  historicalScenario,
  missionsFor,
  scenarioForConfig,
} from "@openfront/engine-lib/game/HistoricalScenarios";
import { createGameRunner, GameRunner } from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import { toWireGameStartInfo } from "@openfront/shared/SharedUtil";
import fs from "fs";
import path from "path";
import { config, human, mapLoader } from "./client/replay/util/ArchiveGame";

const europe1939 = historicalScenario(HistoricalScenarioId.Europe1939);

async function startScenario(
  players: ReturnType<typeof human>[],
  assignments: { clientID: string; nation: string }[] = [],
): Promise<GameRunner> {
  const start = toWireGameStartInfo({
    gameID: "histScen1",
    lobbyCreatedAt: 1_700_000_000_000,
    config: config({
      gameMap: GameMapType.Europe,
      gameType: GameType.Private,
      bots: 0,
      historicalScenario: HistoricalScenarioId.Europe1939,
      scenarioAssignments: assignments,
    }),
    players,
  });
  const map = await loadMapFiles(
    mapLoader,
    start.config.gameMap,
    start.config.gameMapSize,
  );
  const runner = await createGameRunner(start, undefined, map, () => {});
  for (let t = 0; t < 3; t++) {
    runner.addTurn({ turnNumber: t, intents: [] });
    runner.executeNextTick();
  }
  return runner;
}

describe("historical scenarios", () => {
  test("every nation has a unique key and flag, and its flag exists", () => {
    const flags = new Set(europe1939.nations.map((n) => n.flag));
    const keys = new Set(europe1939.nations.map((n) => n.key));
    expect(flags.size).toBe(europe1939.nations.length);
    expect(keys.size).toBe(europe1939.nations.length);
    const flagDir = path.join(__dirname, "../resources/flags");
    for (const n of europe1939.nations) {
      expect(fs.existsSync(path.join(flagDir, `${n.flag}.svg`))).toBe(true);
    }
  });

  test("a scenario only applies on its own map at normal size", () => {
    const base = config({
      historicalScenario: HistoricalScenarioId.Europe1939,
    });
    expect(scenarioForConfig({ ...base, gameMap: GameMapType.World })).toBe(
      null,
    );
    expect(
      scenarioForConfig({ ...base, gameMap: GameMapType.Europe })?.id,
    ).toBe(HistoricalScenarioId.Europe1939);
  });

  test("the host's choices come first, then the great powers", () => {
    const assigned = assignScenarioNations(
      europe1939,
      ["a", "b", "c"],
      [
        { clientID: "b", nation: "poland" },
        // Taken twice: the second one is ignored.
        { clientID: "c", nation: "poland" },
        { clientID: "x", nation: "france" },
      ],
    );
    expect(assigned.get("b")?.key).toBe("poland");
    expect(assigned.get("a")?.key).toBe("germany");
    expect(assigned.get("c")?.key).toBe("italy");
  });

  test("nations start with their land, troops and fixed bloc alliances", async () => {
    const runner = await startScenario(
      [human(1), human(2)],
      [
        { clientID: "client001", nation: "france" },
        { clientID: "client002", nation: "germany" },
      ],
    );
    const game = runner.game;
    const france = game.playerByClientID("client001")!;
    const germany = game.playerByClientID("client002")!;
    expect(france.info().nationFlag).toBe("fr");
    expect(germany.info().nationFlag).toBe("de");
    expect(france.hasSpawned()).toBe(true);
    expect(france.numTilesOwned()).toBeGreaterThan(50_000);
    expect(germany.numTilesOwned()).toBeGreaterThan(20_000);
    expect(france.troops()).toBeGreaterThan(100_000);

    const byFlag = (flag: string) =>
      game.allPlayers().find((p) => p.info().nationFlag === flag)!;
    const uk = byFlag("gb");
    const italy = byFlag("italy");
    const ussr = byFlag("ussr");
    expect(uk.type()).toBe(PlayerType.Nation);
    // Allies and Axis start allied within their bloc, not across it.
    expect(france.isAlliedWith(uk)).toBe(true);
    expect(germany.isAlliedWith(italy)).toBe(true);
    expect(france.isAlliedWith(germany)).toBe(false);
    expect(ussr.isAlliedWith(germany)).toBe(false);

    // Every nation of the scenario plays: 2 humans + the AI for the rest.
    const flags = new Set(
      game
        .allPlayers()
        .map((p) => p.info().nationFlag)
        .filter((f) => f !== null),
    );
    expect(flags.size).toBe(europe1939.nations.length);

    // A bloc alliance can't be broken, and doesn't run out.
    const alliance = france.allianceWith(uk)!;
    france.breakAlliance(alliance);
    expect(france.isAlliedWith(uk)).toBe(true);
    expect(france.isTraitor()).toBe(false);
  }, 120_000);
});

describe("all historical scenarios", () => {
  const all = Object.values(HISTORICAL_SCENARIOS);
  const flagDir = path.join(__dirname, "../resources/flags");

  test.each(all.map((s) => [s.id, s] as const))(
    "%s: unique keys and flags, flags exist, missions are sound",
    (_id, scenario) => {
      const keys = new Set(scenario.nations.map((n) => n.key));
      const flags = new Set(scenario.nations.map((n) => n.flag));
      expect(keys.size).toBe(scenario.nations.length);
      expect(flags.size).toBe(scenario.nations.length);
      for (const n of scenario.nations) {
        expect(fs.existsSync(path.join(flagDir, `${n.flag}.svg`))).toBe(true);
        for (const s of n.seeds) expect(s.radius).toBeGreaterThan(0);
      }
      const majors = scenario.nations.filter((n) => n.major);
      expect(majors.length).toBeGreaterThanOrEqual(6);
      for (const major of majors) {
        // Several missions per position, for variety.
        const missions = missionsFor(scenario, major.key);
        expect(missions.length).toBeGreaterThanOrEqual(3);
        for (const mission of missions) {
          for (const goal of mission.goals) {
            const targets =
              goal.kind === "conquer"
                ? goal.nations
                : goal.kind === "eliminate"
                  ? [goal.nation]
                  : [];
            for (const t of targets) {
              const target = scenario.nations.find((n) => n.key === t);
              expect(target, `${major.key} → ${t}`).toBeDefined();
              expect(t).not.toBe(major.key);
              // Never a fixed ally: that mission could not be done.
              if (major.bloc !== null) {
                expect(target!.bloc).not.toBe(major.bloc);
              }
            }
          }
        }
      }
      // One historical mission per great power, with its background text
      // in English and German.
      const en = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "../resources/lang/en.json"),
          "utf8",
        ),
      );
      const de = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "../resources/lang/de.json"),
          "utf8",
        ),
      );
      const lookup = (o: unknown, key: string) =>
        key
          .split(".")
          .reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o);
      for (const n of scenario.nations) {
        const hist = missionsFor(scenario, n.key).filter((m) => m.historical);
        expect(hist.length, n.key).toBeLessThanOrEqual(1);
        if (n.major) expect(hist.length, n.key).toBe(1);
        for (const m of hist) {
          expect(typeof lookup(en, m.noteKey!), m.noteKey!).toBe("string");
          expect(typeof lookup(de, m.noteKey!), m.noteKey!).toBe("string");
        }
      }
      // Minor nations get generic missions.
      const minor = scenario.nations.find((n) => !n.major)!;
      expect(missionsFor(scenario, minor.key).length).toBeGreaterThan(0);
    },
  );

  test.each(
    all
      .filter((s) => s.id !== HistoricalScenarioId.Europe1939)
      .map((s) => [s.id, s] as const),
  )(
    "%s: every nation starts with land",
    async (_id, scenario) => {
      const start = toWireGameStartInfo({
        gameID: "histScen2",
        lobbyCreatedAt: 1_700_000_000_000,
        config: config({
          gameMap: scenario.map,
          gameType: GameType.Private,
          bots: 0,
          historicalScenario: scenario.id,
        }),
        players: [human(1)],
      });
      const map = await loadMapFiles(
        mapLoader,
        start.config.gameMap,
        start.config.gameMapSize,
      );
      const runner = await createGameRunner(start, undefined, map, () => {});
      for (let t = 0; t < 3; t++) {
        runner.addTurn({ turnNumber: t, intents: [] });
        runner.executeNextTick();
      }
      const owners = new Map(
        runner.game
          .allPlayers()
          .filter((p) => p.info().nationFlag !== null)
          .map((p) => [p.info().nationFlag, p.numTilesOwned()]),
      );
      const landless = scenario.nations
        .filter((n) => (owners.get(n.flag) ?? 0) < 50)
        .map((n) => n.key);
      expect(landless).toEqual([]);
    },
    120_000,
  );
});

describe("secret missions", () => {
  test("every human of a scenario nation is dealt one of its missions", async () => {
    const updates: MissionsViewState[] = [];
    const start = toWireGameStartInfo({
      gameID: "histMiss1",
      lobbyCreatedAt: 1_700_000_000_000,
      config: config({
        gameMap: GameMapType.Europe,
        gameType: GameType.Private,
        bots: 0,
        historicalScenario: HistoricalScenarioId.Europe1939,
        scenarioMissions: true,
        scenarioAssignments: [
          { clientID: "client001", nation: "france" },
          { clientID: "client002", nation: "germany" },
        ],
      }),
      players: [human(1), human(2)],
    });
    const map = await loadMapFiles(
      mapLoader,
      start.config.gameMap,
      start.config.gameMapSize,
    );
    const runner = await createGameRunner(start, undefined, map, (gu) => {
      if (!("updates" in gu)) return;
      for (const u of gu.updates[GameUpdateType.Missions] ?? []) {
        updates.push(u.state);
      }
    });
    for (let t = 0; t < 3; t++) {
      runner.addTurn({ turnNumber: t, intents: [] });
      runner.executeNextTick();
    }
    expect(updates.length).toBeGreaterThan(0);
    const state = updates[updates.length - 1];
    expect(state.winner).toBe(null);
    expect(state.missions).toHaveLength(2);
    const france = runner.game.playerByClientID("client001")!;
    const mine = state.missions.find((m) => m.player === france.smallID())!;
    expect(mine.nation).toBe("france");
    const options = missionsFor(europe1939, "france").map((m) =>
      JSON.stringify(m.goals),
    );
    expect(options).toContain(JSON.stringify(mine.goals.map((g) => g.goal)));
    for (const g of mine.goals) {
      expect(g.progress).toBeGreaterThanOrEqual(0);
      expect(g.progress).toBeLessThanOrEqual(1);
    }
    // The dealt missions go into a snapshot (the schema accepts them).
    expect(runner.snapshot().length).toBeGreaterThan(0);
  }, 120_000);
});

describe("secret missions: winning", () => {
  test("a fulfilled mission held long enough wins the game", async () => {
    const scenario = historicalScenario(HistoricalScenarioId.Italy1494);
    const saved = scenario.missions;
    // A mission any nation fulfils at once: rule 1% of the land.
    const easy = [{ kind: "land" as const, share: 0.01 }];
    scenario.missions = { venice: [easy, easy, easy] };
    try {
      const updates: MissionsViewState[] = [];
      const start = toWireGameStartInfo({
        gameID: "histMiss2",
        lobbyCreatedAt: 1_700_000_000_000,
        config: config({
          gameMap: scenario.map,
          gameType: GameType.Singleplayer,
          bots: 0,
          historicalScenario: scenario.id,
          scenarioMissions: true,
          scenarioAssignments: [{ clientID: "client001", nation: "venice" }],
        }),
        players: [human(1)],
      });
      const map = await loadMapFiles(
        mapLoader,
        start.config.gameMap,
        start.config.gameMapSize,
      );
      const runner = await createGameRunner(start, undefined, map, (gu) => {
        if (!("updates" in gu)) return;
        for (const u of gu.updates[GameUpdateType.Missions] ?? []) {
          updates.push(u.state);
        }
      });
      const venice = runner.game.playerByClientID("client001")!;
      let t = 0;
      for (; t < 1200 && runner.game.getWinner() === null; t++) {
        runner.addTurn({ turnNumber: t, intents: [] });
        runner.executeNextTick();
      }
      expect(runner.game.getWinner()).toBe(venice);
      const last = updates[updates.length - 1];
      expect(last.winner).toBe(venice.smallID());
      // Not before the hold time ran out.
      expect(t).toBeGreaterThan(MISSION_HOLD_TICKS);
    } finally {
      scenario.missions = saved;
    }
  }, 300_000);
});
