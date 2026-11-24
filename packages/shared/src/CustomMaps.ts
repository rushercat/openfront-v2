/**
 * Custom maps (openfront v2): maps players make in the map editor and upload
 * to the game server, so anyone can play them in a private match. The server
 * keeps them (src/server/CustomMaps.ts); the client lists, downloads and
 * uploads them (src/client/CustomMapsApi.ts).
 *
 * An upload is a sequence of frames, each a little-endian u32 length and that
 * many bytes, in this order: the header (JSON), the manifest (JSON), map.bin,
 * map4x.bin, map16x.bin, the thumbnail (webp or png) and the editor document
 * (JSON). The document is what the creator reopens to edit the map later;
 * only the creator, who holds the map's edit key, may download it.
 */

import { z } from "zod";

/** A custom map's id: 12 lowercase letters and digits. */
export const CustomMapIdSchema = z.string().regex(/^[a-z0-9]{12}$/);

/** Who may change a map: the secret handed out when it was first uploaded. */
export const CustomMapEditKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,64}$/);

/** The HTTP header an edit key travels in. */
export const CUSTOM_MAP_EDIT_KEY_HEADER = "x-map-edit-key";

export const CustomMapUploadHeaderSchema = z.object({
  name: z.string().trim().min(1).max(64),
  author: z.string().trim().max(40).default(""),
  description: z.string().trim().max(500).default(""),
});
export type CustomMapUploadHeader = z.input<typeof CustomMapUploadHeaderSchema>;

/** What anyone can read about an uploaded map. */
export const CustomMapInfoSchema = z.object({
  id: CustomMapIdSchema,
  name: z.string(),
  author: z.string(),
  description: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
  nations: z.int().nonnegative(),
  /** Bumped on every update, so cached files are fetched again. */
  version: z.int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** "image/webp" or "image/png". */
  thumbnailType: z.string(),
});
export type CustomMapInfo = z.infer<typeof CustomMapInfoSchema>;

export const CustomMapListSchema = z.object({
  maps: z.array(CustomMapInfoSchema),
});

/** The answer to a create: the map and the key that edits it from now on. */
export const CustomMapCreatedSchema = z.object({
  map: CustomMapInfoSchema,
  editKey: CustomMapEditKeySchema,
});

/** The files of an uploaded map, as GET .../file/:name serves them. */
export const CUSTOM_MAP_FILES = [
  "map",
  "map4x",
  "map16x",
  "thumbnail",
] as const;
export type CustomMapFileName = (typeof CUSTOM_MAP_FILES)[number];

export interface CustomMapUpload {
  header: CustomMapUploadHeader;
  /** The manifest the server checks and stores (nations included). */
  manifest: unknown;
  mapBin: Uint8Array;
  map4xBin: Uint8Array;
  map16xBin: Uint8Array;
  thumbnail: Uint8Array;
  /** The editor document as JSON text. */
  document: Uint8Array;
}

const FRAME_COUNT = 7;

export function encodeCustomMapUpload(upload: CustomMapUpload): Uint8Array {
  const text = new TextEncoder();
  const frames = [
    text.encode(JSON.stringify(upload.header)),
    text.encode(JSON.stringify(upload.manifest)),
    upload.mapBin,
    upload.map4xBin,
    upload.map16xBin,
    upload.thumbnail,
    upload.document,
  ];
  const total = frames.reduce((n, f) => n + 4 + f.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    out.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return out;
}

/** Splits an upload into its frames; throws on anything malformed. */
export function decodeCustomMapUpload(bytes: Uint8Array): CustomMapUpload {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error("truncated frame length");
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > bytes.length) throw new Error("truncated frame");
    frames.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (frames.length !== FRAME_COUNT) {
    throw new Error(`expected ${FRAME_COUNT} frames, got ${frames.length}`);
  }
  const text = new TextDecoder();
  const json = (f: Uint8Array): unknown => JSON.parse(text.decode(f));
  return {
    header: CustomMapUploadHeaderSchema.parse(json(frames[0])),
    manifest: json(frames[1]),
    mapBin: frames[2],
    map4xBin: frames[3],
    map16xBin: frames[4],
    thumbnail: frames[5],
    document: frames[6],
  };
}

/** The thumbnail's MIME type from its magic bytes, or null if unsupported. */
export function thumbnailMimeType(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}
