import {
  AllPlayersStats,
  ClientID,
  Turn,
  Winner,
} from "@openfront/engine-api/Schemas";
import {
  createPartialGameRecord,
  replacer,
} from "@openfront/shared/SharedUtil";
import type {
  PlayerRecord,
  WireGameStartInfo,
} from "@openfront/shared/WireSchemas";
import { ClientEnv } from "../ClientEnv";
import { gzipInBrowser } from "../replay/BrowserGzip";
import {
  saveMatch,
  type MatchResult,
  type MatchSummary,
} from "./LocalMatchStore";
import { MatchChronicle } from "./MatchChronicle";

/** A running game is saved this often (ms), so a closed tab still leaves a replay. */
const AUTOSAVE_MS = 3 * 60 * 1000;

/**
 * The game this client is playing (or spectating): its chronicle, and every
 * turn the server sent, which together with the start info is the game
 * record a replay re-simulates. ClientGameRunner starts it and hands it each
 * turn; MatchChronicleController fills the chronicle; it is saved to this
 * browser (LocalMatchStore) when the game is won, every few minutes, and
 * when the player leaves.
 */
export class MatchSession {
  readonly chronicle = new MatchChronicle();
  private readonly turns: Turn[] = [];
  private readonly startedAt = Date.now();
  private winner: Winner = undefined;
  private allPlayersStats: AllPlayersStats = {};
  private saving: Promise<boolean> | null = null;
  private saveAgain = false;
  private autosave: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly gameStartInfo: WireGameStartInfo,
    readonly clientID: ClientID | null,
    /** False for a game resumed from a save: its turns don't start at the beginning. */
    readonly replayable: boolean,
  ) {
    if (typeof setInterval !== "undefined") {
      this.autosave = setInterval(() => void this.save(), AUTOSAVE_MS);
    }
  }

  get gameID(): string {
    return this.gameStartInfo.gameID;
  }

  addTurn(turn: Turn): void {
    if (this.replayable) this.turns.push({ ...turn });
  }

  /**
   * The hash the simulation computed after a turn, kept with that turn like
   * the server's record does, so the replay can check it plays the same game.
   */
  recordHash(tick: number, hash: number): void {
    const turn = this.turns[tick];
    if (turn !== undefined && turn.turnNumber === tick) turn.hash = hash;
  }

  turnCount(): number {
    return this.turns.length;
  }

  markWin(winner: Winner, allPlayersStats: AllPlayersStats): void {
    this.winner = winner;
    this.allPlayersStats = allPlayersStats;
    void this.save();
  }

  /** The game record so far, as the server would archive it. */
  buildRecord(): object {
    const gsi = this.gameStartInfo;
    const players: PlayerRecord[] = gsi.players.map((p) => ({
      ...p,
      persistentID: null,
      stats: this.allPlayersStats[p.clientID] ?? {},
    }));
    const partial = createPartialGameRecord(
      gsi.gameID,
      gsi.config,
      players,
      this.turns,
      this.startedAt,
      Date.now(),
      this.winner,
      gsi.lobbyCreatedAt,
      gsi.visibleAt,
      gsi.tribes,
    );
    return {
      ...partial,
      info: { ...partial.info, scenario: gsi.scenario },
      gitCommit: ClientEnv.gitCommit(),
    };
  }

  summary(): MatchSummary {
    const chronicle = this.chronicle;
    const me = chronicle.me();
    const meName = me === null ? null : (chronicle.player(me)?.name ?? null);
    const win = chronicle.events().find((e) => e.kind === "win");
    let winnerName: string | null = null;
    let result: MatchResult = "played";
    if (win !== undefined) {
      if (win.team !== undefined) {
        winnerName = win.team;
        const myTeam = me === null ? null : chronicle.player(me)?.team;
        result = myTeam !== null && myTeam === win.team ? "won" : "lost";
      } else {
        winnerName = chronicle.player(win.a)?.name ?? null;
        result = me !== null && win.a === me ? "won" : "lost";
      }
      if (me === null) result = "played";
    } else if (
      me !== null &&
      chronicle.events().some((e) => e.kind === "eliminated" && e.a === me)
    ) {
      result = "lost";
    }
    const config = this.gameStartInfo.config;
    const start = chronicle.startTick();
    return {
      gameID: this.gameID,
      savedAt: Date.now(),
      startedAt: this.startedAt,
      durationTicks: start === null ? 0 : chronicle.lastTick() - start,
      map: String(config.gameMap),
      mode: String(config.gameMode),
      myName: meName,
      result,
      winnerName,
      playerCount: Object.keys(chronicle.players()).length,
      hasReplay: this.replayable,
      gitCommit: ClientEnv.gitCommit(),
    };
  }

  /** Saves the game to this browser; overlapping calls are merged. */
  save(): Promise<boolean> {
    if (this.saving !== null) {
      this.saveAgain = true;
      return this.saving;
    }
    this.saving = this.write().finally(() => {
      this.saving = null;
      if (this.saveAgain) {
        this.saveAgain = false;
        void this.save();
      }
    });
    return this.saving;
  }

  private async write(): Promise<boolean> {
    try {
      // Nothing worth keeping before anyone spawned
      if (this.chronicle.startTick() === null) return false;
      let record: Uint8Array | null = null;
      if (this.replayable) {
        const json = JSON.stringify(this.buildRecord(), replacer);
        record = await gzipInBrowser(new TextEncoder().encode(json));
      }
      return await saveMatch(this.summary(), {
        gameID: this.gameID,
        chronicle: this.chronicle.toData(),
        record,
      });
    } catch (err) {
      console.warn("match session: save failed", err);
      return false;
    }
  }

  /** Saves one last time and stops the autosave. */
  end(): Promise<boolean> {
    if (this.autosave !== null) {
      clearInterval(this.autosave);
      this.autosave = null;
    }
    return this.save();
  }
}

let current: MatchSession | null = null;
let active: MatchChronicle | null = null;

/**
 * The chronicle of the game on screen: the session's while playing, a
 * fresh one for a replay. MatchChronicleController sets it.
 */
export function activeChronicle(): MatchChronicle | null {
  return active;
}

export function setActiveChronicle(chronicle: MatchChronicle | null): void {
  active = chronicle;
}

export function startMatchSession(session: MatchSession): MatchSession {
  void current?.end();
  current = session;
  return session;
}

/** The game being played now, null outside a game (and in replays). */
export function currentMatchSession(): MatchSession | null {
  return current;
}

export function endMatchSession(): void {
  void current?.end();
  current = null;
}
