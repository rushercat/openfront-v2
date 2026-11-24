import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  registerMapSessionRoutes,
  resetMapSessions,
} from "../../src/server/MapSessions";

vi.mock("../../src/server/Logger", () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn() }) },
}));

describe("shared map sessions", () => {
  let base: string;
  let close: () => void;

  beforeAll(async () => {
    const app = express();
    registerMapSessionRoutes(app);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/map-sessions`;
    close = () => {
      resetMapSessions();
      server.close();
    };
  });

  afterAll(() => close());

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  it("opens with a 4-digit code, orders everyone's edits and hands them out", async () => {
    const opened = await post(base, {
      name: "Konstantin",
      document: { hello: "map" },
    });
    expect(opened.status).toBe(200);
    expect(opened.json.code).toMatch(/^[0-9]{4}$/);
    const { code, clientId: host } = opened.json;

    const joined = await post(`${base}/${code}/join`, { name: "Friend" });
    expect(joined.status).toBe(200);
    expect(joined.json.base).toEqual({ hello: "map" });
    expect(joined.json.participants.map((p: any) => p.name)).toEqual([
      "Konstantin",
      "Friend",
    ]);
    expect(joined.json.keeper).toBe(host);
    const friend = joined.json.clientId;

    // The friend waits for news; the host's edit wakes the poll.
    const poll = fetch(`${base}/${code}/poll?clientId=${friend}&after=0`).then(
      (r) => r.json() as Promise<any>,
    );
    const sent = await post(`${base}/${code}/edits`, {
      clientId: host,
      edits: [{ type: "set_terrain", tiles: [1], terrain: [128] }],
      commit: "do",
    });
    expect(sent.json.seq).toBe(1);
    const news = await poll;
    expect(news.entries).toEqual([
      {
        seq: 1,
        clientId: host,
        edits: [{ type: "set_terrain", tiles: [1], terrain: [128] }],
        commit: "do",
      },
    ]);

    // Outsiders can't edit; only the keeper replaces the base.
    expect(
      (
        await post(`${base}/${code}/edits`, {
          clientId: "x".repeat(20),
          edits: [{}],
        })
      ).status,
    ).toBe(403);
    const notKeeper = await fetch(`${base}/${code}/base`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: JSON.stringify({ clientId: friend, seq: 1, document: {} }),
    });
    expect(notKeeper.status).toBe(403);
    const keeperBase = await fetch(`${base}/${code}/base`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: JSON.stringify({ clientId: host, seq: 1, document: { v: 2 } }),
    });
    expect(keeperBase.status).toBe(200);
    // Someone behind the new base starts over from it.
    const behind = (await (
      await fetch(`${base}/${code}/poll?clientId=${friend}&after=0`)
    ).json()) as any;
    expect(behind).toMatchObject({ resync: true, base: { v: 2 }, baseSeq: 1 });

    // The session ends when everyone has left.
    await post(`${base}/${code}/leave`, { clientId: friend });
    await post(`${base}/${code}/leave`, { clientId: host });
    expect((await post(`${base}/${code}/join`, { name: "Late" })).status).toBe(
      404,
    );
  });

  it("shows everyone where the others point", async () => {
    const { code, clientId: host } = (
      await post(base, { name: "Host", document: {} })
    ).json;
    const friend = (await post(`${base}/${code}/join`, { name: "Friend" })).json
      .clientId;
    // No edits pending: the poll waits, and a cursor move wakes it.
    const poll = fetch(`${base}/${code}/poll?clientId=${friend}&after=0`).then(
      (r) => r.json() as Promise<any>,
    );
    const moved = await post(`${base}/${code}/cursor`, {
      clientId: host,
      x: 12,
      y: 34,
      r: 3,
    });
    expect(moved.status).toBe(200);
    const news = await poll;
    expect(news.entries).toEqual([]);
    expect(news.cursors).toEqual([{ clientId: host, x: 12, y: 34, r: 3 }]);

    // Off the map: hidden again. Outsiders can't place a cursor.
    const poll2 = fetch(`${base}/${code}/poll?clientId=${friend}&after=0`).then(
      (r) => r.json() as Promise<any>,
    );
    await post(`${base}/${code}/cursor`, { clientId: host, x: -1, y: -1 });
    expect((await poll2).cursors).toEqual([]);
    expect(
      (
        await post(`${base}/${code}/cursor`, {
          clientId: "x".repeat(20),
          x: 1,
          y: 1,
        })
      ).status,
    ).toBe(403);
  });

  it("refuses unknown codes", async () => {
    expect((await post(`${base}/0000/join`, { name: "x" })).status).toBe(404);
  });
});
