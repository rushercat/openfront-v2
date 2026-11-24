import { GameRecord, GameRecordSchema } from "@openfront/shared/WireSchemas";
import { gunzipInBrowser } from "../replay/BrowserGzip";
import { loadMatchData } from "./LocalMatchStore";

/** Records inflate to at most this many bytes (a guard against a broken store). */
const MAX_RECORD_BYTES = 512 * 1024 * 1024;

/**
 * The game record this browser stored for a game it played (MatchSession),
 * or null if there is none. `commit` is the build that played it: a record
 * only replays on that build. Development builds stamp "DEV", which the
 * schema's commit check would refuse, so it is checked with a stand-in.
 */
export async function loadLocalGameRecord(
  gameID: string,
): Promise<{ record: GameRecord; commit: string } | null> {
  const data = await loadMatchData(gameID);
  if (data === null || data.record === null) return null;
  try {
    const json = new TextDecoder().decode(
      await gunzipInBrowser(data.record, MAX_RECORD_BYTES),
    );
    const raw = JSON.parse(json) as { gitCommit?: unknown };
    const commit = typeof raw.gitCommit === "string" ? raw.gitCommit : "";
    const parsed = GameRecordSchema.safeParse({
      ...raw,
      gitCommit: /^[0-9a-fA-F]{40}$/.test(commit) ? commit : "0".repeat(40),
    });
    if (!parsed.success) {
      console.warn("local replay: stored record doesn't parse", parsed.error);
      return null;
    }
    return { record: { ...parsed.data, gitCommit: commit }, commit };
  } catch (err) {
    console.warn("local replay: stored record unreadable", err);
    return null;
  }
}
