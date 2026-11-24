/**
 * Building a map together (openfront v2): this editor's side of a shared
 * session (src/server/MapSessions.ts). It sends this editor's edits to the
 * session and feeds everyone's edits, in the session's order, back into the
 * DocumentEditor (receive()), its own included. Every copy of the map goes
 * through the same edits in the same order, so they stay the same.
 */

import { z } from "zod";
import { ClientEnv } from "../ClientEnv";
import type {
  DocumentEditor,
  Edit,
  EditRelay,
  StepKind,
} from "./DocumentEditor";
import {
  ScenarioDocumentSchema,
  ScenarioNationSchema,
  type ScenarioDocument,
  ScenarioStructureSchema,
  serializeScenarioDocument,
} from "./ScenarioDocument";

/** How often this editor's pending edits go out while painting. */
const FLUSH_MS = 120;
/** After this many edits since the last base, the keeper sends a new one. */
const BASE_EVERY_ENTRIES = 300;
const BASE_EVERY_MS = 60_000;

const Tiles = z.array(z.int().nonnegative()).max(25_000_000);

/** Edits from other editors are checked before they touch the document. */
export const EditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_nation"),
    nation: ScenarioNationSchema,
    index: z.int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("remove_nation"), id: z.string() }),
  z.object({
    type: z.literal("set_nation"),
    id: z.string(),
    name: z.string().optional(),
    flag: z.string().nullable().optional(),
    troops: z.number().optional(),
    gold: z.number().optional(),
    playable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("set_owner"),
    tiles: Tiles,
    owner: z.string().nullable(),
  }),
  z.object({
    type: z.literal("place_structure"),
    structure: ScenarioStructureSchema,
  }),
  z.object({
    type: z.literal("remove_structure"),
    tile: z.int().nonnegative(),
  }),
  z.object({
    type: z.literal("set_terrain"),
    tiles: Tiles,
    terrain: z.array(z.int().min(0).max(255)).max(25_000_000),
  }),
]);

const EntrySchema = z.object({
  seq: z.int(),
  clientId: z.string(),
  edits: z.array(z.unknown()),
  commit: z.enum(["do", "undo", "redo"]).nullable(),
});
type Entry = z.infer<typeof EntrySchema>;

const ParticipantSchema = z.object({
  clientId: z.string(),
  name: z.string(),
  color: z.string(),
});
export type MapSessionParticipant = z.infer<typeof ParticipantSchema>;

const CursorSchema = z.object({
  clientId: z.string(),
  x: z.int(),
  y: z.int(),
  r: z.int(),
});
/** Where another participant points: a tile and their brush radius. */
export type MapSessionCursor = z.infer<typeof CursorSchema>;

/** Cursor moves go out at most this often. */
const CURSOR_SEND_MS = 100;

const NewsSchema = z.object({
  seq: z.int(),
  participants: z.array(ParticipantSchema),
  cursors: z.array(CursorSchema).optional(),
  keeper: z.string().nullable(),
  entries: z.array(EntrySchema),
  resync: z.boolean().optional(),
  base: z.unknown().optional(),
  baseSeq: z.int().optional(),
});
type News = z.infer<typeof NewsSchema>;

function base(): string {
  try {
    return `${ClientEnv.serverHttpBase()}/api/map-sessions`;
  } catch {
    return "/api/map-sessions";
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok) {
    throw new MapSessionError(
      typeof json.error === "string" ? json.error : `${res.status}`,
      res.status,
    );
  }
  return json;
}

export class MapSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A session joined: its document as of the base, and the edits since. */
export interface JoinedSession {
  session: MapSession;
  doc: ScenarioDocument;
}

export interface MapSessionEvents {
  /** Edits came in and the document changed. */
  changed(): void;
  /** Who is in the session changed. */
  participants(list: MapSessionParticipant[]): void;
  /** Where the others point now (this editor's own cursor left out). */
  cursors(list: MapSessionCursor[]): void;
  /** The session is gone or this editor fell too far behind: stop sharing. */
  ended(reason: string): void;
}

export class MapSession implements EditRelay {
  private editor: DocumentEditor | null = null;
  private seq = 0;
  private lastBaseSeq = 0;
  private lastBaseAt = Date.now();
  private keeper: string | null = null;
  private outgoing: Edit[] = [];
  private flushTimer: number | null = null;
  // Posts go out one at a time, so the session gets them in the order sent.
  private sending: Promise<void> = Promise.resolve();
  private stopped = false;
  private pollAbort = new AbortController();
  participants: MapSessionParticipant[] = [];
  private cursorSent = "";
  private cursorPending: { x: number; y: number; r: number } | null = null;
  private cursorTimer: number | null = null;
  private cursorLastAt = 0;

  private constructor(
    readonly code: string,
    readonly clientId: string,
    readonly color: string,
    private readonly events: MapSessionEvents,
  ) {}

  /** Opens a session with this editor's document. */
  static async open(
    doc: ScenarioDocument,
    name: string,
    events: MapSessionEvents,
  ): Promise<MapSession> {
    const res = z
      .object({ code: z.string(), clientId: z.string(), color: z.string() })
      .parse(
        await postJson(base(), {
          name,
          document: serializeScenarioDocument(doc),
        }),
      );
    const session = new MapSession(res.code, res.clientId, res.color, events);
    session.participants = [{ clientId: res.clientId, name, color: res.color }];
    return session;
  }

  /**
   * Joins a session: the document as of now. Call attach() with the editor
   * built on it, which then catches up and starts listening.
   */
  static async join(
    code: string,
    name: string,
    events: MapSessionEvents,
  ): Promise<JoinedSession & { pending: Entry[] }> {
    const res = z
      .object({ clientId: z.string(), color: z.string() })
      .and(NewsSchema)
      .parse(await postJson(`${base()}/${code}/join`, { name }));
    const doc = ScenarioDocumentSchema.parse(res.base);
    const session = new MapSession(code, res.clientId, res.color, events);
    session.seq = res.baseSeq ?? 0;
    session.lastBaseSeq = session.seq;
    session.participants = res.participants;
    session.keeper = res.keeper;
    return { session, doc, pending: res.entries };
  }

  /**
   * Shares the editor's document through this session: from now on its
   * edits go out and everyone's come back. `pending` are edits made since
   * the document was taken (join()).
   */
  attach(editor: DocumentEditor, pending: Entry[] = []): void {
    this.editor = editor;
    editor.setRelay(this);
    this.applyEntries(pending);
    this.events.participants(this.participants);
    void this.pollLoop();
  }

  // ---- EditRelay ----

  edit(edit: Edit): void {
    this.outgoing.push(edit);
    if (this.flushTimer === null) {
      this.flushTimer = window.setTimeout(() => this.flush(null), FLUSH_MS);
    }
  }

  commit(kind: StepKind): void {
    this.flush(kind);
  }

  step(edits: Edit[], kind: StepKind): void {
    this.outgoing.push(...edits);
    this.flush(kind);
  }

  private flush(commit: StepKind | null): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const edits = this.outgoing;
    this.outgoing = [];
    if (edits.length === 0 && commit === null) return;
    this.sending = this.sending.then(async () => {
      if (this.stopped) return;
      try {
        await postJson(`${base()}/${this.code}/edits`, {
          clientId: this.clientId,
          edits,
          commit,
        });
      } catch (e) {
        console.error("shared map: sending edits failed:", e);
        if (
          e instanceof MapSessionError &&
          (e.status === 403 || e.status === 404)
        ) {
          this.end("map_session.ended");
        }
      }
    });
  }

  // ---- Receiving ----

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const res = await fetch(
          `${base()}/${this.code}/poll?clientId=${encodeURIComponent(
            this.clientId,
          )}&after=${this.seq}`,
          { signal: this.pollAbort.signal },
        );
        if (res.status === 404 || res.status === 403 || res.status === 410) {
          this.end("map_session.ended");
          return;
        }
        if (!res.ok) throw new Error(`${res.status}`);
        this.onNews(NewsSchema.parse(await res.json()));
        failures = 0;
      } catch (e) {
        if (this.stopped) return;
        failures++;
        console.warn("shared map: polling failed:", e);
        if (failures >= 10) {
          this.end("map_session.connection_lost");
          return;
        }
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * failures)));
      }
    }
  }

  private onNews(news: News): void {
    if (news.resync === true) {
      // Too far behind to catch up edit by edit.
      this.end("map_session.resync");
      return;
    }
    this.participants = news.participants;
    this.keeper = news.keeper;
    this.events.participants(news.participants);
    this.events.cursors(
      (news.cursors ?? []).filter((c) => c.clientId !== this.clientId),
    );
    this.applyEntries(news.entries);
    void this.maybeSendBase();
  }

  private applyEntries(entries: Entry[]): void {
    const editor = this.editor;
    if (editor === null) return;
    let changed = false;
    for (const entry of entries) {
      if (entry.seq <= this.seq) continue;
      this.seq = entry.seq;
      const edits: Edit[] = [];
      for (const raw of entry.edits) {
        const parsed = EditSchema.safeParse(raw);
        // Every copy skips the same malformed edit.
        if (parsed.success) edits.push(parsed.data as Edit);
      }
      editor.receive(edits, entry.clientId === this.clientId, entry.commit);
      changed = true;
    }
    if (changed) this.events.changed();
  }

  /** The keeper sends the document now and then, as of its latest edit. */
  private async maybeSendBase(): Promise<void> {
    const editor = this.editor;
    if (editor === null || this.keeper !== this.clientId) return;
    const due =
      this.seq - this.lastBaseSeq >= BASE_EVERY_ENTRIES ||
      (this.seq > this.lastBaseSeq &&
        Date.now() - this.lastBaseAt >= BASE_EVERY_MS);
    if (!due) return;
    const seq = this.seq;
    this.lastBaseSeq = seq;
    this.lastBaseAt = Date.now();
    try {
      const res = await fetch(`${base()}/${this.code}/base`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: JSON.stringify({
          clientId: this.clientId,
          seq,
          document: serializeScenarioDocument(editor.doc),
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
    } catch (e) {
      console.warn("shared map: sending the base failed:", e);
    }
  }

  // ---- Cursor ----

  /**
   * Shows the others where this editor points (a tile and the brush
   * radius), or null once the pointer leaves the map. Sent at most every
   * CURSOR_SEND_MS, and only when it changed.
   */
  sendCursor(cursor: { x: number; y: number; r: number } | null): void {
    if (this.stopped) return;
    this.cursorPending = cursor ?? { x: -1, y: -1, r: 0 };
    if (this.cursorTimer !== null) return;
    const wait = Math.max(0, this.cursorLastAt + CURSOR_SEND_MS - Date.now());
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      const c = this.cursorPending;
      this.cursorPending = null;
      if (c === null || this.stopped) return;
      const key = `${c.x},${c.y},${c.r}`;
      if (key === this.cursorSent) return;
      this.cursorSent = key;
      this.cursorLastAt = Date.now();
      void postJson(`${base()}/${this.code}/cursor`, {
        clientId: this.clientId,
        ...c,
      }).catch(() => {});
    }, wait);
  }

  // ---- Leaving ----

  private end(reasonKey: string): void {
    if (this.stopped) return;
    this.stop();
    this.events.ended(reasonKey);
  }

  /** Stops sharing; the editor keeps its document and edits alone again. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pollAbort.abort();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
    this.editor?.setRelay(null);
    this.editor = null;
  }

  /** Leaves the session for good. */
  leave(): void {
    const wasStopped = this.stopped;
    this.stop();
    if (wasStopped) return;
    void fetch(`${base()}/${this.code}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: JSON.stringify({ clientId: this.clientId }),
      keepalive: true,
    }).catch(() => {});
  }
}
