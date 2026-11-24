/**
 * The client side of custom maps (openfront v2, packages/shared/src/
 * CustomMaps.ts): listing the maps uploaded to the game server, loading one
 * for a game, and uploading, updating and deleting the maps made in the map
 * editor.
 *
 * Who may edit a map is whoever holds its edit key, which the server hands
 * out once, when the map is first uploaded. This browser keeps the keys of
 * the maps it uploaded (and which local draft each came from) in
 * localStorage, so only their creator can open them in the editor again.
 */

import {
  CustomGameMap,
  GameMapSize,
} from "@openfront/engine-api/game/GameTypes";
import type {
  MapFiles,
  MapManifest,
} from "@openfront/engine-api/game/MapFiles";
import {
  CUSTOM_MAP_EDIT_KEY_HEADER,
  type CustomMapFileName,
  type CustomMapInfo,
  CustomMapCreatedSchema,
  CustomMapInfoSchema,
  CustomMapListSchema,
  type CustomMapUpload,
  encodeCustomMapUpload,
} from "@openfront/shared/CustomMaps";
import { z } from "zod";
import { ClientEnv } from "./ClientEnv";
import { terrainMapFileLoader } from "./TerrainMapFileLoader";

const OWNED_KEY = "openfront.customMaps.owned";

const OwnedSchema = z.record(
  z.string(),
  z.object({
    editKey: z.string(),
    /** The local editor draft the map was uploaded from, if any. */
    draftId: z.string().nullable(),
  }),
);
type Owned = z.infer<typeof OwnedSchema>;

function base(): string {
  try {
    return `${ClientEnv.serverHttpBase()}/api/custom-maps`;
  } catch {
    return "/api/custom-maps";
  }
}

async function errorOf(res: Response): Promise<Error> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // not JSON
  }
  return new Error(message);
}

// ---- Ownership (this browser's edit keys) ----

function readOwned(): Owned {
  try {
    const raw = localStorage.getItem(OWNED_KEY);
    if (raw === null) return {};
    return OwnedSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeOwned(owned: Owned): void {
  try {
    localStorage.setItem(OWNED_KEY, JSON.stringify(owned));
  } catch (e) {
    console.warn("custom maps: could not save the edit keys:", e);
  }
}

/** Whether this browser created the map (holds its edit key). */
export function ownsCustomMap(id: string): boolean {
  return readOwned()[id] !== undefined;
}

/** The uploaded map a local draft was uploaded as, if any. */
export function customMapOfDraft(draftId: string): string | null {
  const entry = Object.entries(readOwned()).find(
    ([, v]) => v.draftId === draftId,
  );
  return entry?.[0] ?? null;
}

/** Links an owned map to the local draft that now edits it. */
export function linkCustomMapToDraft(id: string, draftId: string): void {
  const owned = readOwned();
  const entry = owned[id];
  if (entry === undefined) return;
  // A draft edits one map at a time.
  for (const v of Object.values(owned)) {
    if (v.draftId === draftId) v.draftId = null;
  }
  entry.draftId = draftId;
  writeOwned(owned);
}

function editKeyOf(id: string): string {
  const key = readOwned()[id]?.editKey;
  if (key === undefined) {
    throw new Error("only the map's creator can do that");
  }
  return key;
}

// ---- Reading ----

export async function listCustomMaps(): Promise<CustomMapInfo[]> {
  const res = await fetch(base());
  if (!res.ok) throw await errorOf(res);
  return CustomMapListSchema.parse(await res.json()).maps;
}

export async function customMapInfo(id: string): Promise<CustomMapInfo> {
  const res = await fetch(`${base()}/${id}`);
  if (!res.ok) throw await errorOf(res);
  return CustomMapInfoSchema.parse(await res.json());
}

export function customMapFileUrl(
  info: Pick<CustomMapInfo, "id" | "version">,
  name: CustomMapFileName,
): string {
  return `${base()}/${info.id}/file/${name}?v=${info.version}`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw await errorOf(res);
  return new Uint8Array(await res.arrayBuffer());
}

/** All of a map's files, as a Custom map at normal size. */
export async function downloadCustomMapFiles(
  info: CustomMapInfo,
): Promise<MapFiles> {
  const [manifestRes, mapBin, map4xBin, map16xBin] = await Promise.all([
    fetch(`${base()}/${info.id}/manifest?v=${info.version}`),
    fetchBytes(customMapFileUrl(info, "map")),
    fetchBytes(customMapFileUrl(info, "map4x")),
    fetchBytes(customMapFileUrl(info, "map16x")),
  ]);
  if (!manifestRes.ok) throw await errorOf(manifestRes);
  const manifest = (await manifestRes.json()) as MapManifest;
  return {
    map: CustomGameMap,
    mapSize: GameMapSize.Normal,
    manifest,
    mapBin,
    map4xBin,
    map16xBin,
  };
}

const loading = new Map<string, Promise<CustomMapInfo>>();

/**
 * Makes the uploaded map `id` the Custom map every map loader answers for
 * (FetchGameMapLoader.setCustomMap), downloading it unless it is already
 * the loaded one. Resolves with its info.
 */
export function ensureCustomMapLoaded(id: string): Promise<CustomMapInfo> {
  const pending = loading.get(id);
  if (pending !== undefined) return pending;
  const load = (async () => {
    const info = await customMapInfo(id);
    const key = `custom:${info.id}:${info.version}`;
    if (terrainMapFileLoader.loadedCustomMapKey() !== key) {
      const files = await downloadCustomMapFiles(info);
      terrainMapFileLoader.setCustomMap(
        files,
        customMapFileUrl(info, "thumbnail"),
        key,
      );
    }
    return info;
  })();
  loading.set(id, load);
  void load.finally(() => loading.delete(id));
  return load;
}

/** The editor document of a map this browser created. */
export async function downloadCustomMapDocument(id: string): Promise<unknown> {
  const res = await fetch(`${base()}/${id}/document`, {
    headers: { [CUSTOM_MAP_EDIT_KEY_HEADER]: editKeyOf(id) },
  });
  if (!res.ok) throw await errorOf(res);
  return res.json();
}

// ---- Writing ----

/** Uploads a new map; this browser keeps its edit key. */
export async function uploadCustomMap(
  upload: CustomMapUpload,
  draftId: string | null,
): Promise<CustomMapInfo> {
  const res = await fetch(base(), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: encodeCustomMapUpload(upload) as BodyInit,
  });
  if (!res.ok) throw await errorOf(res);
  const created = CustomMapCreatedSchema.parse(await res.json());
  const owned = readOwned();
  owned[created.map.id] = { editKey: created.editKey, draftId };
  writeOwned(owned);
  return created.map;
}

/** Replaces a map this browser created with a new version. */
export async function updateCustomMap(
  id: string,
  upload: CustomMapUpload,
): Promise<CustomMapInfo> {
  const res = await fetch(`${base()}/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      [CUSTOM_MAP_EDIT_KEY_HEADER]: editKeyOf(id),
    },
    body: encodeCustomMapUpload(upload) as BodyInit,
  });
  if (!res.ok) throw await errorOf(res);
  return z.object({ map: CustomMapInfoSchema }).parse(await res.json()).map;
}

/** Deletes a map this browser created. */
export async function deleteCustomMap(id: string): Promise<void> {
  const res = await fetch(`${base()}/${id}`, {
    method: "DELETE",
    headers: { [CUSTOM_MAP_EDIT_KEY_HEADER]: editKeyOf(id) },
  });
  if (!res.ok) throw await errorOf(res);
  const owned = readOwned();
  delete owned[id];
  writeOwned(owned);
}
