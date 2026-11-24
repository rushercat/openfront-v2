import {
  CUSTOM_MAP_EDIT_KEY_HEADER,
  encodeCustomMapUpload,
  type CustomMapUpload,
} from "@openfront/shared/CustomMaps";
import express from "express";
import fs from "fs";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerCustomMapRoutes } from "../../src/server/CustomMaps";

vi.mock("../../src/server/Logger", () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn() }) },
}));

const W = 100;
const H = 100;

function upload(name: string): CustomMapUpload {
  const meta = (w: number, h: number) => ({
    width: w,
    height: h,
    num_land_tiles: 0,
  });
  return {
    header: { name, author: "tester", description: "" },
    manifest: {
      map: meta(W, H),
      map4x: meta(W / 2, H / 2),
      map16x: meta(W / 4, H / 4),
      nations: [{ name: "Northland", coordinates: [10, 10], flag: "de" }],
    },
    mapBin: new Uint8Array(W * H),
    map4xBin: new Uint8Array((W / 2) * (H / 2)),
    map16xBin: new Uint8Array((W / 4) * (H / 4)),
    // A png's magic bytes.
    thumbnail: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    document: new TextEncoder().encode(JSON.stringify({ hello: "map" })),
  };
}

describe("custom map routes", () => {
  let base: string;
  let close: () => void;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "custom-maps-"));
    vi.stubEnv("CUSTOM_MAPS_DIR", dir);
    const app = express();
    registerCustomMapRoutes(app);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/custom-maps`;
    close = () => server.close();
  });

  afterAll(() => {
    close();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: Uint8Array, headers: Record<string, string> = {}) =>
    fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body: body as BodyInit,
    });

  it("lets anyone upload and play a map, and only its creator change it", async () => {
    const created = await post(encodeCustomMapUpload(upload("Island")));
    expect(created.status).toBe(200);
    const { map, editKey } = (await created.json()) as {
      map: { id: string; version: number; nations: number };
      editKey: string;
    };
    expect(map.nations).toBe(1);

    const list = (await (await fetch(base)).json()) as {
      maps: { id: string }[];
    };
    expect(list.maps.map((m) => m.id)).toContain(map.id);

    const bin = await fetch(`${base}/${map.id}/file/map4x?v=1`);
    expect(new Uint8Array(await bin.arrayBuffer()).length).toBe(2500);
    const manifest = (await (
      await fetch(`${base}/${map.id}/manifest`)
    ).json()) as {
      nations: { name: string }[];
    };
    expect(manifest.nations[0].name).toBe("Northland");

    // Without the key: no document, no update, no delete.
    expect((await fetch(`${base}/${map.id}/document`)).status).toBe(403);
    const anonymous = await fetch(`${base}/${map.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: encodeCustomMapUpload(upload("Stolen")) as BodyInit,
    });
    expect(anonymous.status).toBe(403);

    const key = { [CUSTOM_MAP_EDIT_KEY_HEADER]: editKey };
    const doc = await fetch(`${base}/${map.id}/document`, { headers: key });
    expect(await doc.json()).toEqual({ hello: "map" });

    const updated = await fetch(`${base}/${map.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", ...key },
      body: encodeCustomMapUpload(upload("Island 2")) as BodyInit,
    });
    expect(updated.status).toBe(200);
    const info = (await (await fetch(`${base}/${map.id}`)).json()) as {
      name: string;
      version: number;
    };
    expect(info).toMatchObject({ name: "Island 2", version: 2 });

    const deleted = await fetch(`${base}/${map.id}`, {
      method: "DELETE",
      headers: key,
    });
    expect(deleted.status).toBe(200);
    expect((await fetch(`${base}/${map.id}`)).status).toBe(404);
  });

  it("rejects malformed uploads", async () => {
    const bad = upload("Broken");
    bad.mapBin = new Uint8Array(5);
    expect((await post(encodeCustomMapUpload(bad))).status).toBe(400);
    expect((await post(new Uint8Array([1, 2, 3]))).status).toBe(400);
    const offMap = upload("Off the map");
    (offMap.manifest as { nations: unknown[] }).nations = [
      { name: "Nowhere", coordinates: [500, 500] },
    ];
    expect((await post(encodeCustomMapUpload(offMap))).status).toBe(400);
  });
});
