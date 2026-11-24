/**
 * Custom map storage (openfront v2, see packages/shared/src/CustomMaps.ts).
 *
 * Every map lives in its own folder under the custom maps directory
 * (CUSTOM_MAPS_DIR, or ./custom-maps): meta.json, manifest.json, map.bin,
 * map4x.bin, map16x.bin, the thumbnail and document.json. Anyone may list
 * and download a map's files, so any player can play it. Only the creator,
 * who got the map's edit key back from the first upload, may download its
 * editor document, update it or delete it. The key itself is never stored,
 * only its SHA-256.
 *
 * Game servers on the same machine (the workers and the winner replay) read
 * the files from the same folder.
 */

import {
  CustomGameMap,
  GameMapSize,
} from "@openfront/engine-api/game/GameTypes";
import type { MapFiles } from "@openfront/engine-api/game/MapFiles";
import {
  type MapManifest,
  MapManifestSchema,
} from "@openfront/engine-api/game/MapManifest";
import {
  CUSTOM_MAP_EDIT_KEY_HEADER,
  type CustomMapFileName,
  CustomMapIdSchema,
  type CustomMapInfo,
  CustomMapInfoSchema,
  decodeCustomMapUpload,
  thumbnailMimeType,
} from "@openfront/shared/CustomMaps";
import crypto from "crypto";
import express, { type Express, type Request, type Response } from "express";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { logger } from "./Logger";

const log = logger.child({ comp: "custom-maps" });

/** The largest upload: a 5000x5000 map with its document. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const MIN_SIDE = 100;
const MAX_SIDE = 5000;
const MAX_NATIONS = 400;
const MAX_MAPS = 5000;

const StoredMetaSchema = CustomMapInfoSchema.extend({
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
});
type StoredMeta = z.infer<typeof StoredMetaSchema>;

export function customMapsDir(): string {
  return process.env.CUSTOM_MAPS_DIR ?? path.join(process.cwd(), "custom-maps");
}

function mapDir(id: string): string {
  // The id is checked by every caller; this keeps a bad one out regardless.
  if (!CustomMapIdSchema.safeParse(id).success) {
    throw new Error(`bad custom map id ${id}`);
  }
  return path.join(customMapsDir(), id);
}

const FILE_NAMES: Record<Exclude<CustomMapFileName, "thumbnail">, string> = {
  map: "map.bin",
  map4x: "map4x.bin",
  map16x: "map16x.bin",
};

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function newId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function readMeta(id: string): Promise<StoredMeta | null> {
  try {
    const raw = await fs.readFile(path.join(mapDir(id), "meta.json"), "utf8");
    return StoredMetaSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function publicInfo(meta: StoredMeta): CustomMapInfo {
  // Drop the key hash.
  const { keyHash: _keyHash, ...info } = meta;
  return info;
}

/** Reads one of a custom map's files, for game servers on this machine. */
export async function readCustomMapFile(
  id: string,
  name: "manifest.json" | "map.bin" | "map4x.bin" | "map16x.bin",
): Promise<Buffer> {
  return fs.readFile(path.join(mapDir(id), name));
}

/** A custom map's files at a size, for a game server's engine. */
export async function loadCustomMapFiles(
  id: string,
  mapSize: GameMapSize,
): Promise<MapFiles> {
  const manifest = JSON.parse(
    (await readCustomMapFile(id, "manifest.json")).toString("utf8"),
  ) as MapManifest;
  const bin = async (name: "map.bin" | "map4x.bin" | "map16x.bin") =>
    new Uint8Array(await readCustomMapFile(id, name));
  if (mapSize === GameMapSize.Normal) {
    return {
      map: CustomGameMap,
      mapSize,
      manifest,
      mapBin: await bin("map.bin"),
      map4xBin: await bin("map4x.bin"),
    };
  }
  return {
    map: CustomGameMap,
    mapSize,
    manifest,
    map4xBin: await bin("map4x.bin"),
    map16xBin: await bin("map16x.bin"),
  };
}

export async function customMapExists(id: string): Promise<boolean> {
  return (
    CustomMapIdSchema.safeParse(id).success && (await readMeta(id)) !== null
  );
}

class UploadError extends Error {}

/**
 * Checks an upload and returns what to store. The manifest is rebuilt from
 * the uploaded one's sizes and nations, so nothing else in it is taken.
 */
function checkUpload(body: Uint8Array) {
  let upload;
  try {
    upload = decodeCustomMapUpload(body);
  } catch (e) {
    throw new UploadError(`bad upload: ${(e as Error).message}`);
  }
  const Meta = z.object({
    width: z.int().min(1).max(MAX_SIDE),
    height: z.int().min(1).max(MAX_SIDE),
    num_land_tiles: z.int().nonnegative(),
  });
  const Uploaded = z.object({
    map: Meta,
    map4x: Meta,
    map16x: Meta,
    nations: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(64),
          coordinates: z.tuple([z.int().nonnegative(), z.int().nonnegative()]),
          // A flag file name (resources/flags), never a path.
          flag: z
            .string()
            .min(1)
            .max(80)
            .refine((f) => !/[/\\]|\.\./.test(f), "not a flag name")
            .optional(),
        }),
      )
      .max(MAX_NATIONS),
  });
  const parsed = Uploaded.safeParse(upload.manifest);
  if (!parsed.success) {
    throw new UploadError(`bad manifest: ${z.prettifyError(parsed.error)}`);
  }
  const m = parsed.data;
  if (
    m.map.width < MIN_SIDE ||
    m.map.height < MIN_SIDE ||
    m.map.width % 4 !== 0 ||
    m.map.height % 4 !== 0 ||
    m.map4x.width !== m.map.width / 2 ||
    m.map4x.height !== m.map.height / 2 ||
    m.map16x.width !== m.map.width / 4 ||
    m.map16x.height !== m.map.height / 4
  ) {
    throw new UploadError("bad map sizes");
  }
  const sizes: [Uint8Array, z.infer<typeof Meta>, string][] = [
    [upload.mapBin, m.map, "map.bin"],
    [upload.map4xBin, m.map4x, "map4x.bin"],
    [upload.map16xBin, m.map16x, "map16x.bin"],
  ];
  for (const [bin, meta, name] of sizes) {
    if (bin.length !== meta.width * meta.height) {
      throw new UploadError(`${name} has ${bin.length} bytes`);
    }
  }
  const thumbnailType = thumbnailMimeType(upload.thumbnail);
  if (thumbnailType === null || upload.thumbnail.length > MAX_THUMBNAIL_BYTES) {
    throw new UploadError("the thumbnail must be a webp or png image");
  }
  try {
    JSON.parse(new TextDecoder().decode(upload.document));
  } catch {
    throw new UploadError("the document is not JSON");
  }
  const manifest = MapManifestSchema.safeParse({
    id: "Custom",
    name: "Custom",
    translation_key: "map.custom",
    categories: ["fictional"],
    nations: m.nations,
    map: m.map,
    map4x: m.map4x,
    map16x: m.map16x,
  } satisfies MapManifest);
  if (!manifest.success) {
    throw new UploadError(`bad manifest: ${z.prettifyError(manifest.error)}`);
  }
  return { upload, manifest: manifest.data, thumbnailType };
}

async function writeMap(
  id: string,
  checked: ReturnType<typeof checkUpload>,
  meta: StoredMeta,
): Promise<void> {
  const dir = mapDir(id);
  await fs.mkdir(dir, { recursive: true });
  const { upload, manifest } = checked;
  // Files first, meta last: a map only counts once its meta is written.
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, "map.bin"), upload.mapBin);
  await fs.writeFile(path.join(dir, "map4x.bin"), upload.map4xBin);
  await fs.writeFile(path.join(dir, "map16x.bin"), upload.map16xBin);
  await fs.writeFile(path.join(dir, "thumbnail"), upload.thumbnail);
  await fs.writeFile(path.join(dir, "document.json"), upload.document);
  const tmp = path.join(dir, "meta.json.tmp");
  await fs.writeFile(tmp, JSON.stringify(meta));
  await fs.rename(tmp, path.join(dir, "meta.json"));
}

async function listMaps(): Promise<CustomMapInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(customMapsDir());
  } catch {
    return [];
  }
  const metas = await Promise.all(
    entries
      .filter((e) => CustomMapIdSchema.safeParse(e).success)
      .map((e) => readMeta(e)),
  );
  return metas
    .filter((m): m is StoredMeta => m !== null)
    .map(publicInfo)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The map the request names if its edit key matches; answers otherwise. */
async function authorized(
  req: Request<{ id: string }>,
  res: Response,
): Promise<StoredMeta | null> {
  const id = CustomMapIdSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "bad map id" });
    return null;
  }
  const meta = await readMeta(id.data);
  if (meta === null) {
    res.status(404).json({ error: "map not found" });
    return null;
  }
  const key = req.header(CUSTOM_MAP_EDIT_KEY_HEADER);
  const given = typeof key === "string" ? hashKey(key) : "";
  const expected = Buffer.from(meta.keyHash, "hex");
  const actual = Buffer.from(given.padEnd(64, "0"), "hex");
  if (
    given.length !== 64 ||
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    res.status(403).json({ error: "only the map's creator can do that" });
    return null;
  }
  return meta;
}

function bodyBytes(req: Request): Uint8Array | null {
  return Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : null;
}

export function registerCustomMapRoutes(app: Express): void {
  const raw = express.raw({
    type: "application/octet-stream",
    limit: MAX_UPLOAD_BYTES,
  });

  app.get("/api/custom-maps", async (_req, res) => {
    res.json({ maps: await listMaps() });
  });

  app.get("/api/custom-maps/:id", async (req, res) => {
    const id = CustomMapIdSchema.safeParse(req.params.id);
    const meta = id.success ? await readMeta(id.data) : null;
    if (meta === null) return res.status(404).json({ error: "map not found" });
    res.json(publicInfo(meta));
  });

  app.get("/api/custom-maps/:id/manifest", async (req, res) => {
    const id = CustomMapIdSchema.safeParse(req.params.id);
    if (!id.success || (await readMeta(id.data)) === null) {
      return res.status(404).json({ error: "map not found" });
    }
    res.type("application/json");
    res.send(await readCustomMapFile(id.data, "manifest.json"));
  });

  app.get("/api/custom-maps/:id/file/:name", async (req, res) => {
    const id = CustomMapIdSchema.safeParse(req.params.id);
    const meta = id.success ? await readMeta(id.data) : null;
    if (meta === null) return res.status(404).json({ error: "map not found" });
    const name = req.params.name;
    let file: string;
    let type: string;
    if (name === "thumbnail") {
      file = "thumbnail";
      type = meta.thumbnailType;
    } else if (name === "map" || name === "map4x" || name === "map16x") {
      file = FILE_NAMES[name];
      type = "application/octet-stream";
    } else {
      return res.status(404).json({ error: "no such file" });
    }
    // Clients ask with ?v=<version>, so a cached copy is never stale.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.type(type);
    res.send(await fs.readFile(path.join(mapDir(meta.id), file)));
  });

  app.get(
    "/api/custom-maps/:id/document",
    async (req: Request<{ id: string }>, res) => {
      const meta = await authorized(req, res);
      if (meta === null) return;
      res.type("application/json");
      res.send(await fs.readFile(path.join(mapDir(meta.id), "document.json")));
    },
  );

  app.post("/api/custom-maps", raw, async (req, res) => {
    const body = bodyBytes(req);
    if (body === null) return res.status(400).json({ error: "no upload" });
    try {
      if ((await listMaps()).length >= MAX_MAPS) {
        return res
          .status(507)
          .json({ error: "the server holds too many maps" });
      }
      const checked = checkUpload(body);
      let id = newId();
      while ((await readMeta(id)) !== null) id = newId();
      const editKey = crypto.randomBytes(32).toString("base64url");
      const now = Date.now();
      const meta: StoredMeta = {
        id,
        name: checked.upload.header.name,
        author: checked.upload.header.author ?? "",
        description: checked.upload.header.description ?? "",
        width: checked.manifest.map.width,
        height: checked.manifest.map.height,
        nations: checked.manifest.nations.length,
        version: 1,
        createdAt: now,
        updatedAt: now,
        thumbnailType: checked.thumbnailType,
        keyHash: hashKey(editKey),
      };
      await writeMap(id, checked, meta);
      log.info(`custom map ${id} created (${meta.width}x${meta.height})`);
      res.json({ map: publicInfo(meta), editKey });
    } catch (e) {
      if (e instanceof UploadError) {
        return res.status(400).json({ error: e.message });
      }
      log.error("custom map upload failed:", e);
      res.status(500).json({ error: "upload failed" });
    }
  });

  app.put(
    "/api/custom-maps/:id",
    raw,
    async (req: Request<{ id: string }>, res) => {
      const meta = await authorized(req, res);
      if (meta === null) return;
      const body = bodyBytes(req);
      if (body === null) return res.status(400).json({ error: "no upload" });
      try {
        const checked = checkUpload(body);
        const updated: StoredMeta = {
          ...meta,
          name: checked.upload.header.name,
          author: checked.upload.header.author ?? meta.author,
          description: checked.upload.header.description ?? meta.description,
          width: checked.manifest.map.width,
          height: checked.manifest.map.height,
          nations: checked.manifest.nations.length,
          version: meta.version + 1,
          updatedAt: Date.now(),
          thumbnailType: checked.thumbnailType,
        };
        await writeMap(meta.id, checked, updated);
        log.info(`custom map ${meta.id} updated to v${updated.version}`);
        res.json({ map: publicInfo(updated) });
      } catch (e) {
        if (e instanceof UploadError) {
          return res.status(400).json({ error: e.message });
        }
        log.error("custom map update failed:", e);
        res.status(500).json({ error: "update failed" });
      }
    },
  );

  app.delete(
    "/api/custom-maps/:id",
    async (req: Request<{ id: string }>, res) => {
      const meta = await authorized(req, res);
      if (meta === null) return;
      await fs.rm(mapDir(meta.id), { recursive: true, force: true });
      log.info(`custom map ${meta.id} deleted`);
      res.json({ ok: true });
    },
  );
}
