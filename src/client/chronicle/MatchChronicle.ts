import {
  GameUpdates,
  MessageType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";

/**
 * What happened in a match, for the event log, the statistics after the
 * game and the list of past games: how big, rich and strong each player was
 * over time, and the moments that mattered (alliances, betrayals, wars,
 * embargos, eliminations, nukes, the win).
 *
 * It is filled on the main thread from what the game view already gets each
 * tick (MatchChronicleController), so it costs the simulation nothing, and it
 * is plain data (toData/fromData) so a finished game can be stored with its
 * replay (LocalMatchStore). Tribes (bots) are left out: they are many and
 * nobody wants their history.
 */

/** Ticks between two samples of every player's territory, gold and troops (5 s). */
export const SAMPLE_TICKS = 50;
/** Ticks between two looks at who attacks whom. */
const WAR_CHECK_TICKS = 10;
/** A stored chronicle keeps at most this many samples; longer games are thinned. */
const MAX_STORED_SAMPLES = 400;

export type ChronicleEventKind =
  | "alliance"
  | "alliance_expired"
  | "betrayal"
  | "war"
  | "embargo"
  | "embargo_end"
  | "eliminated"
  | "nuke"
  | "win";

export type NukeKind = "atom" | "hydro" | "mirv";

export interface ChronicleEvent {
  tick: number;
  kind: ChronicleEventKind;
  /** smallID of who acted (the traitor, the attacker, the eliminated player, the winner). */
  a: number;
  /** smallID of who it was done to, if anyone. */
  b?: number;
  /** For nukes, which one. */
  nuke?: NukeKind;
  /** For a team win, the team's name. */
  team?: string;
}

export interface ChroniclePlayer {
  id: number;
  name: string;
  /** Territory color, #rrggbb. */
  color: string;
  type: PlayerType;
  team: string | null;
}

/** One look at every tracked player: [tiles, gold, troops] by smallID. */
export interface ChronicleSample {
  tick: number;
  values: Record<number, [number, number, number]>;
}

export interface ChronicleData {
  version: 1;
  /** smallID of the player who recorded it, null for a spectator. */
  me: number | null;
  /** First tick after the spawn phase (game time 0:00), null if not reached. */
  startTick: number | null;
  lastTick: number;
  players: Record<number, ChroniclePlayer>;
  samples: ChronicleSample[];
  events: ChronicleEvent[];
}

/** What MatchChronicle needs to know about a player. */
export interface ChronicleSourcePlayer {
  smallID(): number;
  id(): string;
  name(): string;
  type(): PlayerType;
  team(): string | null;
  isAlive(): boolean;
  hasSpawned(): boolean;
  numTilesOwned(): number;
  gold(): bigint;
  troops(): number;
  territoryColor(): { toHex(): string };
  outgoingAttacks(): readonly { targetID: number }[];
}

/** What MatchChronicle needs to know about the game (GameView has all of it). */
export interface ChronicleSource {
  ticks(): number;
  inSpawnPhase(): boolean;
  players(): ChronicleSourcePlayer[];
  myPlayer(): ChronicleSourcePlayer | null;
  playerBySmallID(id: number): unknown;
  player(id: string): ChronicleSourcePlayer;
  unit(id: number): { owner(): { smallID(): number } } | undefined;
  updatesSinceLastTick(): Partial<GameUpdates> | null;
}

export class MatchChronicle {
  private data: ChronicleData;
  /** Unordered pairs ("low:high") whose players are at war. */
  private atWar = new Set<string>();
  private alive = new Set<number>();
  /** Ordered pairs ("from>to") with an embargo in place; nations renew theirs often. */
  private embargoes = new Set<string>();
  private listeners = new Set<(event: ChronicleEvent) => void>();

  constructor(data?: ChronicleData) {
    this.data = data ?? {
      version: 1,
      me: null,
      startTick: null,
      lastTick: 0,
      players: {},
      samples: [],
      events: [],
    };
  }

  static fromData(data: ChronicleData): MatchChronicle {
    return new MatchChronicle(structuredClone(data));
  }

  /** A copy to store, with long games thinned to MAX_STORED_SAMPLES samples. */
  toData(): ChronicleData {
    const copy = structuredClone(this.data);
    if (copy.samples.length > MAX_STORED_SAMPLES) {
      const step = copy.samples.length / MAX_STORED_SAMPLES;
      const thinned: ChronicleSample[] = [];
      for (let i = 0; i < MAX_STORED_SAMPLES - 1; i++) {
        thinned.push(copy.samples[Math.floor(i * step)]);
      }
      // Always keep the last look
      thinned.push(copy.samples[copy.samples.length - 1]);
      copy.samples = thinned;
    }
    return copy;
  }

  me(): number | null {
    return this.data.me;
  }

  startTick(): number | null {
    return this.data.startTick;
  }

  lastTick(): number {
    return this.data.lastTick;
  }

  players(): Record<number, ChroniclePlayer> {
    return this.data.players;
  }

  player(id: number): ChroniclePlayer | undefined {
    return this.data.players[id];
  }

  samples(): readonly ChronicleSample[] {
    return this.data.samples;
  }

  events(): readonly ChronicleEvent[] {
    return this.data.events;
  }

  /** Called with each new event; returns the unsubscribe. */
  onEvent(listener: (event: ChronicleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reads one tick of the game: call once per game tick. */
  observe(game: ChronicleSource): void {
    const tick = game.ticks();
    if (tick < this.data.lastTick) {
      // Seeked back (replay): nothing to learn.
      return;
    }
    this.data.lastTick = tick;
    const me = game.myPlayer();
    if (me !== null) this.data.me = me.smallID();

    const updates = game.updatesSinceLastTick();
    if (updates !== null) this.readUpdates(game, updates, tick);

    if (game.inSpawnPhase()) return;
    this.data.startTick ??= tick;

    if (tick % WAR_CHECK_TICKS === 0) this.checkWars(game, tick);
    if (tick % SAMPLE_TICKS === 0) this.sample(game, tick);
    this.checkEliminations(game, tick);
  }

  private readUpdates(
    game: ChronicleSource,
    updates: Partial<GameUpdates>,
    tick: number,
  ): void {
    for (const u of updates[GameUpdateType.AllianceRequestReply] ?? []) {
      if (!u.accepted) continue;
      const a = u.request.requestorID;
      const b = u.request.recipientID;
      if (!this.tracks(game, a) || !this.tracks(game, b)) continue;
      this.atWar.delete(pairKey(a, b));
      this.add({ tick, kind: "alliance", a, b });
    }
    for (const u of updates[GameUpdateType.BrokeAlliance] ?? []) {
      if (!this.tracks(game, u.traitorID) || !this.tracks(game, u.betrayedID)) {
        continue;
      }
      this.add({ tick, kind: "betrayal", a: u.traitorID, b: u.betrayedID });
    }
    for (const u of updates[GameUpdateType.AllianceExpired] ?? []) {
      if (!this.tracks(game, u.player1ID) || !this.tracks(game, u.player2ID)) {
        continue;
      }
      this.add({
        tick,
        kind: "alliance_expired",
        a: u.player1ID,
        b: u.player2ID,
      });
    }
    for (const u of updates[GameUpdateType.EmbargoEvent] ?? []) {
      if (!this.tracks(game, u.playerID) || !this.tracks(game, u.embargoedID)) {
        continue;
      }
      const key = `${u.playerID}>${u.embargoedID}`;
      const starts = u.event === "start";
      if (this.embargoes.has(key) === starts) continue;
      if (starts) this.embargoes.add(key);
      else this.embargoes.delete(key);
      this.add({
        tick,
        kind: u.event === "start" ? "embargo" : "embargo_end",
        a: u.playerID,
        b: u.embargoedID,
      });
    }
    for (const u of updates[GameUpdateType.ConquestEvent] ?? []) {
      const conqueror = safePlayer(game, u.conquerorId);
      const conquered = safePlayer(game, u.conqueredId);
      if (conquered === null) continue;
      const victim = conquered.smallID();
      if (!this.tracks(game, victim) || this.hasEliminated(victim)) continue;
      this.alive.delete(victim);
      this.add({
        tick,
        kind: "eliminated",
        a: victim,
        b:
          conqueror !== null && this.tracks(game, conqueror.smallID())
            ? conqueror.smallID()
            : undefined,
      });
    }
    for (const u of updates[GameUpdateType.UnitIncoming] ?? []) {
      const nuke = nukeKind(u.messageType);
      if (nuke === null) continue;
      const launcher = game.unit(u.unitID)?.owner().smallID();
      if (launcher === undefined || !this.tracks(game, launcher)) continue;
      if (!this.tracks(game, u.playerID)) continue;
      // A MIRV announces each of its warheads: one event is enough.
      if (
        nuke === "mirv" &&
        this.data.events.some(
          (e) =>
            e.kind === "nuke" &&
            e.nuke === "mirv" &&
            e.a === launcher &&
            e.b === u.playerID &&
            tick - e.tick < SAMPLE_TICKS,
        )
      ) {
        continue;
      }
      this.add({ tick, kind: "nuke", a: launcher, b: u.playerID, nuke });
    }
    for (const u of updates[GameUpdateType.Win] ?? []) {
      if (this.data.events.some((e) => e.kind === "win")) continue;
      const winner = u.winner;
      if (winner === undefined) continue;
      if (winner[0] === "player") {
        const p = safePlayer(game, winner[1]);
        if (p !== null) {
          this.register(p);
          this.add({ tick, kind: "win", a: p.smallID() });
        }
      } else {
        this.add({ tick, kind: "win", a: -1, team: winner[1] });
      }
    }
  }

  /** A war starts with the first attack between two players at peace. */
  private checkWars(game: ChronicleSource, tick: number): void {
    for (const p of game.players()) {
      if (!isTrackedType(p) || !p.isAlive()) continue;
      for (const attack of p.outgoingAttacks()) {
        const target = attack.targetID;
        if (!this.tracks(game, target)) continue;
        const key = pairKey(p.smallID(), target);
        if (this.atWar.has(key)) continue;
        this.atWar.add(key);
        this.add({ tick, kind: "war", a: p.smallID(), b: target });
      }
    }
  }

  /** Players who died without a conquest (e.g. starved out by a nuke). */
  private checkEliminations(game: ChronicleSource, tick: number): void {
    for (const p of game.players()) {
      if (!isTrackedType(p) || !p.hasSpawned()) continue;
      const id = p.smallID();
      if (p.isAlive()) {
        this.alive.add(id);
        continue;
      }
      if (this.alive.has(id)) {
        this.alive.delete(id);
        if (!this.hasEliminated(id)) {
          this.register(p);
          this.add({ tick, kind: "eliminated", a: id });
        }
      }
    }
  }

  private sample(game: ChronicleSource, tick: number): void {
    const values: Record<number, [number, number, number]> = {};
    for (const p of game.players()) {
      if (!isTrackedType(p) || !p.isAlive() || p.numTilesOwned() === 0) {
        continue;
      }
      this.register(p);
      values[p.smallID()] = [
        p.numTilesOwned(),
        Number(p.gold()),
        Math.round(p.troops()),
      ];
    }
    this.data.samples.push({ tick, values });
  }

  private hasEliminated(id: number): boolean {
    return this.data.events.some((e) => e.kind === "eliminated" && e.a === id);
  }

  /** Whether smallID is a player (not a tribe) worth telling about; registers it. */
  private tracks(game: ChronicleSource, id: number): boolean {
    const p = game.playerBySmallID(id);
    if (!isSourcePlayer(p) || !isTrackedType(p)) return false;
    this.register(p);
    return true;
  }

  private register(p: ChronicleSourcePlayer): void {
    const id = p.smallID();
    if (this.data.players[id] !== undefined) return;
    let color = "#888888";
    try {
      color = p.territoryColor().toHex();
    } catch {
      // Colors aren't ready before the player spawned.
    }
    this.data.players[id] = {
      id,
      name: p.name(),
      color,
      type: p.type(),
      team: p.team(),
    };
  }

  private add(event: ChronicleEvent): void {
    this.data.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function isTrackedType(p: ChronicleSourcePlayer): boolean {
  return p.type() !== PlayerType.Bot;
}

function isSourcePlayer(p: unknown): p is ChronicleSourcePlayer {
  return (
    typeof p === "object" &&
    p !== null &&
    "smallID" in p &&
    "isPlayer" in p &&
    typeof (p as { isPlayer: unknown }).isPlayer === "function" &&
    (p as { isPlayer(): boolean }).isPlayer()
  );
}

function safePlayer(
  game: ChronicleSource,
  id: string,
): ChronicleSourcePlayer | null {
  try {
    return game.player(id);
  } catch {
    return null;
  }
}

function nukeKind(type: MessageType): NukeKind | null {
  switch (type) {
    case MessageType.NUKE_INBOUND:
      return "atom";
    case MessageType.HYDROGEN_BOMB_INBOUND:
      return "hydro";
    case MessageType.MIRV_INBOUND:
      return "mirv";
    default:
      return null;
  }
}
