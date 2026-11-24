/**
 * Map terrain from an image (openfront v2's map editor): an uploaded
 * picture becomes a new map's water, land and mountains.
 *
 * Two readings of the pixels:
 *
 * - "picture", for any drawing, photo or screenshot of a map: transparent
 *   and blue-ish pixels are water, everything else land, brighter land
 *   higher up.
 * - "heightmap", the map generator's own format (map-generator/
 *   map_generator.go): transparent pixels and blue 106 are water, pure black
 *   is impassable, and land takes its elevation from the blue channel
 *   (140-200).
 *
 * The image is scaled to the map's size first.
 */

import {
  IMPASSABLE,
  land,
  MAX_ELEVATION,
  MAX_SIDE,
  MIN_SIDE,
  WATER,
} from "./ScenarioDocument";

export type ImageImportMode = "picture" | "heightmap";

/** The largest side an imported map gets by default, to stay quick to play. */
export const DEFAULT_IMPORT_SIDE = 2000;

export async function imageSize(
  file: Blob,
): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/**
 * A map size for an image: its own size and aspect ratio, shrunk so the
 * longer side is at most `maxSide`, grown so the shorter one is at least the
 * editor's minimum, both multiples of 4.
 */
export function fitMapSize(
  width: number,
  height: number,
  maxSide = DEFAULT_IMPORT_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height, 1);
  // Large images shrink to maxSide; others keep their size.
  let scale = Math.min(1, Math.min(maxSide, MAX_SIDE) / longest);
  // Small images are scaled up to the minimum side.
  const shortest = Math.max(1, Math.min(width, height));
  if (shortest * scale < MIN_SIDE) scale = MIN_SIDE / shortest;
  const round4 = (v: number) =>
    Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(v / 4) * 4));
  return { width: round4(width * scale), height: round4(height * scale) };
}

/** The terrain bytes (authored values, ScenarioDocument) of an image. */
export async function terrainFromImage(
  file: Blob,
  width: number,
  height: number,
  mode: ImageImportMode,
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("no 2d canvas");
  // The generator's format is exact colours: scaling must not blend them.
  ctx.imageSmoothingEnabled = mode === "picture";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const terrain = new Uint8Array(width * height);
  for (let i = 0; i < terrain.length; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const a = pixels[i * 4 + 3];
    terrain[i] =
      mode === "heightmap"
        ? heightmapPixel(r, g, b, a)
        : picturePixel(r, g, b, a);
  }
  return terrain;
}

function heightmapPixel(r: number, g: number, b: number, a: number): number {
  if (a < 20 || b === 106) return WATER;
  if (r === 0 && g === 0 && b === 0) return IMPASSABLE;
  const elevation = Math.floor((Math.min(200, Math.max(140, b)) - 140) / 2);
  return land(Math.min(MAX_ELEVATION, elevation));
}

function picturePixel(r: number, g: number, b: number, a: number): number {
  if (a < 128) return WATER;
  // Water: clearly more blue than red, and not darker green than blue.
  if (b > r + 20 && b >= g - 10) return WATER;
  const brightness = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
  return land(Math.min(MAX_ELEVATION, Math.round(brightness * MAX_ELEVATION)));
}
