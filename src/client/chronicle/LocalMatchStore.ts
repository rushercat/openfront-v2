import type { ChronicleData } from "./MatchChronicle";

/**
 * The games this browser played (or watched), kept in IndexedDB: a short
 * summary for the "My games" list, the chronicle for the statistics, and the
 * game record (every turn's intents, gzipped JSON) the replay viewer
 * re-simulates. The engine is deterministic, so the intents are all a
 * replay needs; a record only replays on the build that played it.
 *
 * Best effort, like ReplayStore: without IndexedDB (private windows, blocked
 * storage) nothing is kept and every call quietly does nothing.
 */

const DB_NAME = "openfront-matches";
const DB_VERSION = 1;
const SUMMARIES = "summaries";
const DATA = "data";
/** Games kept; the oldest go first (saved ones always stay). */
export const MAX_STORED_MATCHES = 30;
/**
 * Replays kept of games that weren't saved: only the newest few. Older ones
 * keep their summary and statistics, but their record is dropped and the
 * replay can no longer be watched (MatchSummary.replayExpired). A saved game
 * keeps its replay for good.
 */
export const MAX_UNSAVED_REPLAYS = 3;

export type MatchResult = "won" | "lost" | "played";

export interface MatchSummary {
  gameID: string;
  /** When it was last saved (ms). */
  savedAt: number;
  startedAt: number;
  /** Game time played, in ticks from the end of the spawn phase. */
  durationTicks: number;
  map: string;
  mode: string;
  myName: string | null;
  result: MatchResult;
  winnerName: string | null;
  playerCount: number;
  /** False when the game can't be replayed (it was resumed from a save). */
  hasReplay: boolean;
  gitCommit: string;
  /** The player saved its replay: it is kept for good. */
  saved?: boolean;
  /** Its replay was dropped (beyond the newest MAX_UNSAVED_REPLAYS). */
  replayExpired?: boolean;
}

export interface StoredMatchData {
  gameID: string;
  chronicle: ChronicleData;
  /** The game record as gzipped JSON, null without a replay. */
  record: Uint8Array | null;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SUMMARIES)) {
        db.createObjectStore(SUMMARIES, { keyPath: "gameID" });
      }
      if (!db.objectStoreNames.contains(DATA)) {
        db.createObjectStore(DATA, { keyPath: "gameID" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

/**
 * Stores (or replaces) a game, then drops the oldest unsaved games beyond
 * MAX_STORED_MATCHES and the replays of unsaved games beyond
 * MAX_UNSAVED_REPLAYS.
 */
export async function saveMatch(
  summary: MatchSummary,
  data: StoredMatchData,
): Promise<boolean> {
  const db = await openDb();
  if (db === null) return false;
  // The autosave doesn't know the player saved it meanwhile.
  const existing = await loadMatchSummary(summary.gameID);
  const merged: MatchSummary =
    existing?.saved === true ? { ...summary, saved: true } : summary;
  try {
    const tx = db.transaction([SUMMARIES, DATA], "readwrite");
    tx.objectStore(SUMMARIES).put(merged);
    tx.objectStore(DATA).put(data);
    if (!(await done(tx))) return false;
  } catch {
    return false;
  }
  await prune(db);
  return true;
}

/**
 * What pruning does to a list of summaries (newest first): the games to
 * delete, and the games whose replay to drop. Saved games are never touched.
 */
export function planPrune(summaries: readonly MatchSummary[]): {
  remove: string[];
  expire: string[];
} {
  const remove: string[] = [];
  const expire: string[] = [];
  let kept = 0;
  let replays = 0;
  for (const s of summaries) {
    if (s.saved === true) continue;
    kept++;
    if (kept > MAX_STORED_MATCHES) {
      remove.push(s.gameID);
      continue;
    }
    if (!s.hasReplay || s.replayExpired === true) continue;
    replays++;
    if (replays > MAX_UNSAVED_REPLAYS) expire.push(s.gameID);
  }
  return { remove, expire };
}

async function prune(db: IDBDatabase): Promise<void> {
  const summaries = await listMatches();
  const { remove, expire } = planPrune(summaries);
  if (remove.length === 0 && expire.length === 0) return;
  try {
    const tx = db.transaction([SUMMARIES, DATA], "readwrite");
    const summaryStore = tx.objectStore(SUMMARIES);
    const dataStore = tx.objectStore(DATA);
    for (const id of remove) {
      summaryStore.delete(id);
      dataStore.delete(id);
    }
    for (const id of expire) {
      const s = summaries.find((x) => x.gameID === id);
      if (s === undefined) continue;
      summaryStore.put({ ...s, replayExpired: true });
      const data = await result(
        dataStore.get(id) as IDBRequest<StoredMatchData | undefined>,
      );
      if (data !== undefined) dataStore.put({ ...data, record: null });
    }
    await done(tx);
  } catch {
    // Pruned next time.
  }
}

/** Applies the limits now (for games stored before they existed). */
export async function pruneMatches(): Promise<void> {
  const db = await openDb();
  if (db !== null) await prune(db);
}

/**
 * Saves (or unsaves) a game's replay. Unsaving an older game drops its
 * replay at once if it isn't among the newest MAX_UNSAVED_REPLAYS. Returns
 * the updated summary, or null if the game isn't stored.
 */
export async function setMatchSaved(
  gameID: string,
  saved: boolean,
): Promise<MatchSummary | null> {
  const db = await openDb();
  if (db === null) return null;
  const summary = await loadMatchSummary(gameID);
  if (summary === null) return null;
  // An expired replay can't be brought back by saving it.
  if (saved && summary.replayExpired === true) return summary;
  const updated: MatchSummary = { ...summary, saved };
  try {
    const tx = db.transaction(SUMMARIES, "readwrite");
    tx.objectStore(SUMMARIES).put(updated);
    if (!(await done(tx))) return null;
  } catch {
    return null;
  }
  if (!saved) await prune(db);
  return await loadMatchSummary(gameID);
}

/** Every stored game's summary, newest first. */
export async function listMatches(): Promise<MatchSummary[]> {
  const db = await openDb();
  if (db === null) return [];
  try {
    const tx = db.transaction(SUMMARIES, "readonly");
    const all =
      (await result(
        tx.objectStore(SUMMARIES).getAll() as IDBRequest<MatchSummary[]>,
      )) ?? [];
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function loadMatchSummary(
  gameID: string,
): Promise<MatchSummary | null> {
  const db = await openDb();
  if (db === null) return null;
  try {
    const tx = db.transaction(SUMMARIES, "readonly");
    return (
      (await result(
        tx.objectStore(SUMMARIES).get(gameID) as IDBRequest<MatchSummary>,
      )) ?? null
    );
  } catch {
    return null;
  }
}

export async function loadMatchData(
  gameID: string,
): Promise<StoredMatchData | null> {
  const db = await openDb();
  if (db === null) return null;
  try {
    const tx = db.transaction(DATA, "readonly");
    return (
      (await result(
        tx.objectStore(DATA).get(gameID) as IDBRequest<StoredMatchData>,
      )) ?? null
    );
  } catch {
    return null;
  }
}

export async function deleteMatch(gameID: string): Promise<void> {
  const db = await openDb();
  if (db === null) return;
  try {
    const tx = db.transaction([SUMMARIES, DATA], "readwrite");
    tx.objectStore(SUMMARIES).delete(gameID);
    tx.objectStore(DATA).delete(gameID);
    await done(tx);
  } catch {
    // Nothing to do.
  }
}

/** For tests: forget the open database so the next call opens a fresh one. */
export function resetMatchStoreForTest(): void {
  dbPromise = null;
}
