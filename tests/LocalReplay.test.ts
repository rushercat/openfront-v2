/**
 * The replay of a game this browser recorded (MatchSession): the turns and
 * hashes a client saw, turned into a game record, re-simulate in sync in the
 * replay processor, like an archived record does.
 */

import { decompressGameRecord, replacer } from "@openfront/shared/SharedUtil";
import { GameRecordSchema, WirePlayer } from "@openfront/shared/WireSchemas";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MatchSession } from "../src/client/chronicle/MatchSession";
import { ClientEnv } from "../src/client/ClientEnv";
import { processGameRecord } from "../src/client/replay/processor/ReplayProcessor";
import {
  config,
  human,
  mapLoader,
  playAndArchive,
  spawnOnLand,
} from "./client/replay/util/ArchiveGame";
import { directEngine } from "./client/replay/util/DirectEngine";
import { gzip } from "./client/replay/util/RecordGame";

const SPAWN_TURNS = 200;

describe("local replay record", () => {
  afterEach(() => vi.restoreAllMocks());

  test("a recorded game replays in sync", async () => {
    vi.spyOn(ClientEnv, "gitCommit").mockReturnValue("DEV");
    const [a, b] = [human(1), human(2)];
    const ticks = SPAWN_TURNS + 120;
    const { record: archived, wireStart } = await playAndArchive({
      gameID: "localRp01",
      config: config(),
      players: [a, b],
      ticks,
      intents: (game, t) => {
        const size = game.width() * game.height();
        const id = (p: WirePlayer) => game.playerByClientID(p.clientID)!.id();
        switch (t) {
          case 5:
            return [
              spawnOnLand(game, a.clientID, Math.floor(size * 0.3)),
              spawnOnLand(game, b.clientID, Math.floor(size * 0.6)),
            ];
          case SPAWN_TURNS + 10:
            return [
              {
                type: "attack",
                clientID: a.clientID,
                targetID: null,
                troops: null,
              },
            ];
          case SPAWN_TURNS + 30:
            return [
              {
                type: "allianceRequest",
                clientID: a.clientID,
                recipient: id(b),
              },
            ];
          default:
            return [];
        }
      },
    });

    // What a client saw: every turn, then the hashes it computed.
    const session = new MatchSession(wireStart, a.clientID, true);
    const seen = decompressGameRecord({ ...archived }).turns;
    for (const turn of seen) {
      session.addTurn({ turnNumber: turn.turnNumber, intents: turn.intents });
    }
    for (const turn of seen) {
      if (turn.hash !== undefined && turn.hash !== null) {
        session.recordHash(turn.turnNumber, turn.hash);
      }
    }
    void session.end();

    const record = GameRecordSchema.parse(
      JSON.parse(JSON.stringify(session.buildRecord(), replacer)),
    );
    expect(record.turns.some((t) => t.hash !== undefined)).toBe(true);

    const result = await processGameRecord(record, {
      engine: directEngine(),
      mapLoader,
      gzip,
      keyframeInterval: 50,
      onStart: () => {},
      onAppend: () => {},
    });
    expect(result.totalTicks).toBe(ticks);
  });
});
