/**
 * Building a map together (openfront v2): the map editor's shared sessions.
 *
 * One editor opens a session with its document and gets a 4-digit code;
 * others join with the code. The server keeps the document as of some point
 * (the base) and every edit made since, in one order, and hands each edit to
 * everyone in the session (long polling). Every editor applies the same
 * edits in the same order, so every copy of the map stays the same
 * (client: src/client/scenario/MapSession.ts). The server never looks inside
 * an edit; it only orders them.
 *
 * Sessions live in memory: they end when everyone has left, or when the
 * master restarts. Now and then the session's "keeper" (the editor in it the
 * longest) sends the document as of the latest edit, so a new joiner doesn't
 * have to replay everything.
 */

import crypto from "crypto";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "./Logger";

const log = logger.child({ comp: "map-sessions" });

const MAX_SESSIONS = 200;
const MAX_PARTICIPANTS = 16;
/** The document plus the edits since: a 5000x5000 map with room to spare. */
const MAX_SESSION_BYTES = 96 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** A participant who stops polling for this long has left. */
const PARTICIPANT_TIMEOUT_MS = 45_000;
/** How long a poll waits for news before answering empty. */
const POLL_WAIT_MS = 20_000;
const SWEEP_INTERVAL_MS = 10_000;
/** Cursor moves reach the others at most this often. */
const CURSOR_WAKE_MS = 100;
/** A cursor not moved for this long is hidden. */
const CURSOR_TTL_MS = 10_000;

const CodeSchema = z.string().regex(/^[0-9]{4}$/);
const ClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const NameSchema = z.string().trim().min(1).max(40).catch("Builder");

interface Entry {
  seq: number;
  clientId: string;
  /** The edits as the client sent them (JSON array), never parsed here. */
  edits: unknown[];
  commit: "do" | "undo" | "redo" | null;
  bytes: number;
}

interface Participant {
  clientId: string;
  name: string;
  color: string;
  joinedAt: number;
  lastSeen: number;
  /** Where the participant points on the map (tile), and the brush size. */
  cursor: { x: number; y: number; r: number; at: number } | null;
}

interface Waiter {
  after: number;
  res: Response;
  timer: NodeJS.Timeout;
  clientId: string;
}

interface Session {
  code: string;
  /** The document (stored JSON) as of seq `baseSeq`. */
  base: unknown;
  baseBytes: number;
  baseSeq: number;
  entries: Entry[];
  entryBytes: number;
  seq: number;
  participants: Map<string, Participant>;
  waiters: Set<Waiter>;
  createdAt: number;
  /** A pending wake for cursor moves (CURSOR_WAKE_MS). */
  cursorTimer: NodeJS.Timeout | null;
}

const COLORS = [
  "#ef4444",
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#a855f7",
  "#f97316",
  "#06b6d4",
  "#ec4899",
];

const sessions = new Map<string, Session>();

function newCode(): string | null {
  for (let i = 0; i < 100; i++) {
    const code = crypto.randomInt(0, 10_000).toString().padStart(4, "0");
    if (!sessions.has(code)) return code;
  }
  return null;
}

function newClientId(): string {
  return crypto.randomBytes(18).toString("base64url");
}

function participantList(session: Session) {
  return [...session.participants.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(({ clientId, name, color }) => ({ clientId, name, color }));
}

/** The editor that sends the session's base now and then. */
function keeper(session: Session): string | null {
  return participantList(session)[0]?.clientId ?? null;
}

/** The cursors moved recently. */
function cursorList(session: Session) {
  const now = Date.now();
  return [...session.participants.values()]
    .filter((p) => p.cursor !== null && now - p.cursor.at < CURSOR_TTL_MS)
    .map((p) => ({
      clientId: p.clientId,
      x: p.cursor!.x,
      y: p.cursor!.y,
      r: p.cursor!.r,
    }));
}

/** Answers every waiting poll now, edits or not (cursors, participants). */
function wakeAll(session: Session): void {
  for (const w of session.waiters) {
    clearTimeout(w.timer);
    w.res.json(news(session, w.after));
  }
  session.waiters.clear();
}

function entriesAfter(session: Session, after: number) {
  return session.entries
    .filter((e) => e.seq > after)
    .map(({ seq, clientId, edits, commit }) => ({
      seq,
      clientId,
      edits,
      commit,
    }));
}

/** What a poll answers: the news since `after`, or a fresh start. */
function news(session: Session, after: number) {
  const resync = after < session.baseSeq;
  return {
    seq: session.seq,
    participants: participantList(session),
    cursors: cursorList(session),
    keeper: keeper(session),
    ...(resync
      ? {
          resync: true,
          base: session.base,
          baseSeq: session.baseSeq,
          entries: entriesAfter(session, session.baseSeq),
        }
      : { entries: entriesAfter(session, after) }),
  };
}

function wake(session: Session): void {
  for (const waiter of session.waiters) {
    if (session.seq > waiter.after) {
      clearTimeout(waiter.timer);
      session.waiters.delete(waiter);
      waiter.res.json(news(session, waiter.after));
    }
  }
}

function touch(session: Session, clientId: string): Participant | null {
  const p = session.participants.get(clientId);
  if (p === undefined) return null;
  p.lastSeen = Date.now();
  return p;
}

function addParticipant(session: Session, name: string): Participant | null {
  if (session.participants.size >= MAX_PARTICIPANTS) return null;
  const used = new Set([...session.participants.values()].map((p) => p.color));
  const color =
    COLORS.find((c) => !used.has(c)) ??
    COLORS[session.participants.size % COLORS.length];
  const now = Date.now();
  const p: Participant = {
    clientId: newClientId(),
    name,
    color,
    joinedAt: now,
    lastSeen: now,
    cursor: null,
  };
  session.participants.set(p.clientId, p);
  return p;
}

/** Drops participants who stopped polling and sessions nobody is in. */
function sweep(): void {
  const now = Date.now();
  for (const session of sessions.values()) {
    let changed = false;
    for (const p of session.participants.values()) {
      const polling = [...session.waiters].some(
        (w) => w.clientId === p.clientId,
      );
      if (!polling && now - p.lastSeen > PARTICIPANT_TIMEOUT_MS) {
        session.participants.delete(p.clientId);
        changed = true;
      }
    }
    if (session.participants.size === 0) {
      for (const w of session.waiters) {
        clearTimeout(w.timer);
        w.res.status(410).json({ error: "the session has ended" });
      }
      if (session.cursorTimer !== null) clearTimeout(session.cursorTimer);
      sessions.delete(session.code);
      log.info(`map session ${session.code} ended`);
    } else if (changed) {
      // Everyone sees the new participant list.
      wakeAll(session);
    }
  }
}

function jsonBody(req: Request): unknown {
  if (!Buffer.isBuffer(req.body)) throw new Error("no body");
  return JSON.parse(req.body.toString("utf8"));
}

function sessionOf(req: Request<{ code: string }>, res: Response) {
  const code = CodeSchema.safeParse(req.params.code);
  const session = code.success ? sessions.get(code.data) : undefined;
  if (session === undefined) {
    res.status(404).json({ error: "no session with that code" });
    return null;
  }
  return session;
}

export function registerMapSessionRoutes(app: Express): void {
  const raw = express.raw({
    type: "application/octet-stream",
    limit: MAX_BODY_BYTES,
  });
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();

  // Open a session with a document; the opener is its first participant.
  app.post("/api/map-sessions", raw, (req, res) => {
    let body: { name?: unknown; document?: unknown };
    try {
      body = jsonBody(req) as typeof body;
    } catch {
      return res.status(400).json({ error: "bad request" });
    }
    if (typeof body.document !== "object" || body.document === null) {
      return res.status(400).json({ error: "no document" });
    }
    if (sessions.size >= MAX_SESSIONS) {
      return res.status(503).json({ error: "too many sessions" });
    }
    const code = newCode();
    if (code === null) {
      return res.status(503).json({ error: "no free code" });
    }
    const session: Session = {
      code,
      base: body.document,
      baseBytes: (req.body as Buffer).length,
      baseSeq: 0,
      entries: [],
      entryBytes: 0,
      seq: 0,
      participants: new Map(),
      waiters: new Set(),
      createdAt: Date.now(),
      cursorTimer: null,
    };
    const me = addParticipant(session, NameSchema.parse(body.name))!;
    sessions.set(code, session);
    log.info(`map session ${code} opened`);
    res.json({ code, clientId: me.clientId, color: me.color, seq: 0 });
  });

  // Join: the document as of the base, and every edit since.
  app.post(
    "/api/map-sessions/:code/join",
    raw,
    (req: Request<{ code: string }>, res) => {
      const session = sessionOf(req, res);
      if (session === null) return;
      let name: string;
      try {
        name = NameSchema.parse((jsonBody(req) as { name?: unknown }).name);
      } catch {
        name = "Builder";
      }
      const me = addParticipant(session, name);
      if (me === null) {
        return res.status(409).json({ error: "the session is full" });
      }
      // Everyone else learns about the newcomer.
      wakeAll(session);
      res.json({
        clientId: me.clientId,
        color: me.color,
        ...news(session, -1),
      });
    },
  );

  // Edits: the next part of the sender's current step.
  app.post(
    "/api/map-sessions/:code/edits",
    raw,
    (req: Request<{ code: string }>, res) => {
      const session = sessionOf(req, res);
      if (session === null) return;
      let body: { clientId?: unknown; edits?: unknown; commit?: unknown };
      try {
        body = jsonBody(req) as typeof body;
      } catch {
        return res.status(400).json({ error: "bad request" });
      }
      const clientId = ClientIdSchema.safeParse(body.clientId);
      if (!clientId.success || touch(session, clientId.data) === null) {
        return res.status(403).json({ error: "not in this session" });
      }
      const edits = Array.isArray(body.edits) ? body.edits : [];
      const commit =
        body.commit === "do" || body.commit === "undo" || body.commit === "redo"
          ? body.commit
          : null;
      if (edits.length === 0 && commit === null) {
        return res.json({ seq: session.seq });
      }
      const bytes = (req.body as Buffer).length;
      if (session.baseBytes + session.entryBytes + bytes > MAX_SESSION_BYTES) {
        return res
          .status(413)
          .json({ error: "the session is full, wait a moment" });
      }
      session.seq++;
      session.entries.push({
        seq: session.seq,
        clientId: clientId.data,
        edits,
        commit,
        bytes,
      });
      session.entryBytes += bytes;
      wake(session);
      res.json({ seq: session.seq });
    },
  );

  // The news since `after`, waiting up to POLL_WAIT_MS for some.
  app.get(
    "/api/map-sessions/:code/poll",
    (req: Request<{ code: string }>, res) => {
      const session = sessionOf(req, res);
      if (session === null) return;
      const clientId = ClientIdSchema.safeParse(req.query.clientId);
      if (!clientId.success || touch(session, clientId.data) === null) {
        return res.status(403).json({ error: "not in this session" });
      }
      const after = Number(req.query.after);
      if (!Number.isInteger(after) || after < 0) {
        return res.status(400).json({ error: "bad after" });
      }
      if (session.seq > after || after < session.baseSeq) {
        return res.json(news(session, after));
      }
      const waiter: Waiter = {
        after,
        res,
        clientId: clientId.data,
        timer: setTimeout(() => {
          session.waiters.delete(waiter);
          touch(session, clientId.data);
          res.json(news(session, after));
        }, POLL_WAIT_MS),
      };
      session.waiters.add(waiter);
      req.on("close", () => {
        if (session.waiters.delete(waiter)) clearTimeout(waiter.timer);
      });
    },
  );

  // Where the sender points: x and y of a tile and the brush radius, or
  // x = -1 for off the map. The others get it with their next news.
  app.post(
    "/api/map-sessions/:code/cursor",
    raw,
    (req: Request<{ code: string }>, res) => {
      const session = sessionOf(req, res);
      if (session === null) return;
      let body: { clientId?: unknown; x?: unknown; y?: unknown; r?: unknown };
      try {
        body = jsonBody(req) as typeof body;
      } catch {
        return res.status(400).json({ error: "bad request" });
      }
      const clientId = ClientIdSchema.safeParse(body.clientId);
      const p = clientId.success ? touch(session, clientId.data) : null;
      if (p === null) {
        return res.status(403).json({ error: "not in this session" });
      }
      const x = Number(body.x);
      const y = Number(body.y);
      const r = Number(body.r);
      p.cursor =
        Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0
          ? {
              x,
              y,
              // -1: a plain pointer, no brush.
              r: Number.isInteger(r) ? Math.min(100, Math.max(-1, r)) : -1,
              at: Date.now(),
            }
          : null;
      // Moves are bundled: everyone hears at most every CURSOR_WAKE_MS.
      session.cursorTimer ??= setTimeout(() => {
        session.cursorTimer = null;
        wakeAll(session);
      }, CURSOR_WAKE_MS);
      res.json({ ok: true });
    },
  );

  // The keeper's copy of the document as of `seq`: replaces the base, and
  // the edits it holds are dropped.
  app.put(
    "/api/map-sessions/:code/base",
    raw,
    (req: Request<{ code: string }>, res) => {
      const session = sessionOf(req, res);
      if (session === null) return;
      let body: { clientId?: unknown; seq?: unknown; document?: unknown };
      try {
        body = jsonBody(req) as typeof body;
      } catch {
        return res.status(400).json({ error: "bad request" });
      }
      const clientId = ClientIdSchema.safeParse(body.clientId);
      if (
        !clientId.success ||
        touch(session, clientId.data) === null ||
        keeper(session) !== clientId.data
      ) {
        return res.status(403).json({ error: "not the session's keeper" });
      }
      const seq = Number(body.seq);
      if (
        !Number.isInteger(seq) ||
        seq < session.baseSeq ||
        seq > session.seq ||
        typeof body.document !== "object" ||
        body.document === null
      ) {
        return res.status(400).json({ error: "bad base" });
      }
      session.base = body.document;
      session.baseBytes = (req.body as Buffer).length;
      session.baseSeq = seq;
      session.entries = session.entries.filter((e) => e.seq > seq);
      session.entryBytes = session.entries.reduce((n, e) => n + e.bytes, 0);
      res.json({ ok: true });
    },
  );

  app.post(
    "/api/map-sessions/:code/leave",
    raw,
    (req: Request<{ code: string }>, res) => {
      const session = sessionOf(req, res);
      if (session === null) return;
      try {
        const clientId = ClientIdSchema.parse(
          (jsonBody(req) as { clientId?: unknown }).clientId,
        );
        session.participants.delete(clientId);
      } catch {
        // nothing to do
      }
      sweep();
      res.json({ ok: true });
    },
  );
}

/** For tests: forget every session. */
export function resetMapSessions(): void {
  for (const session of sessions.values()) {
    for (const w of session.waiters) clearTimeout(w.timer);
    if (session.cursorTimer !== null) clearTimeout(session.cursorTimer);
  }
  sessions.clear();
}
