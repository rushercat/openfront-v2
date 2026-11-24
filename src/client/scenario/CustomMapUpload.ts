/**
 * Builds a custom map upload (packages/shared/src/CustomMaps.ts) from the
 * map editor's document and the terrain the editing engine exported.
 *
 * A custom map is played like a stock map, so its nations are spawn points:
 * each nation spawns at the middle of the land painted for it (the owned
 * tile nearest its centre). Nations with no land are left out.
 */

import type { MapFiles } from "@openfront/engine-api/game/MapFiles";
import type { CustomMapUpload } from "@openfront/shared/CustomMaps";
import {
  type ScenarioDocument,
  serializeScenarioDocument,
} from "./ScenarioDocument";
import { renderScenarioThumbnail, thumbnailPixels } from "./ScenarioExport";

export interface NationSpawn {
  name: string;
  coordinates: [number, number];
  flag?: string;
}

/** Each nation's spawn, and the names of those without land. */
export function nationSpawns(doc: ScenarioDocument): {
  spawns: NationSpawn[];
  skipped: string[];
} {
  const n = doc.nations.length;
  const count = new Float64Array(n + 1);
  const sumX = new Float64Array(n + 1);
  const sumY = new Float64Array(n + 1);
  for (let tile = 0; tile < doc.owners.length; tile++) {
    const owner = doc.owners[tile];
    if (owner === 0) continue;
    count[owner]++;
    sumX[owner] += tile % doc.width;
    sumY[owner] += Math.floor(tile / doc.width);
  }
  const best = new Int32Array(n + 1).fill(-1);
  const bestDist = new Float64Array(n + 1).fill(Infinity);
  for (let tile = 0; tile < doc.owners.length; tile++) {
    const owner = doc.owners[tile];
    if (owner === 0) continue;
    const dx = (tile % doc.width) - sumX[owner] / count[owner];
    const dy = Math.floor(tile / doc.width) - sumY[owner] / count[owner];
    const d = dx * dx + dy * dy;
    if (d < bestDist[owner]) {
      bestDist[owner] = d;
      best[owner] = tile;
    }
  }
  const spawns: NationSpawn[] = [];
  const skipped: string[] = [];
  doc.nations.forEach((nation, i) => {
    const tile = best[i + 1];
    if (tile < 0) {
      skipped.push(nation.name);
      return;
    }
    spawns.push({
      name: nation.name,
      coordinates: [tile % doc.width, Math.floor(tile / doc.width)],
      ...(nation.flag !== null ? { flag: nation.flag } : {}),
    });
  });
  return { spawns, skipped };
}

/** The thumbnail as webp, or as png where the browser can't encode webp. */
async function thumbnail(files: MapFiles): Promise<Uint8Array> {
  try {
    return await renderScenarioThumbnail(files);
  } catch {
    const pixels = thumbnailPixels(files);
    const w = Math.max(1, Math.floor(files.manifest.map4x.width / 2));
    const canvas = new OffscreenCanvas(w, pixels.length / 4 / w);
    canvas
      .getContext("2d")!
      .putImageData(new ImageData(pixels, w, canvas.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }
}

export async function buildCustomMapUpload(
  doc: ScenarioDocument,
  files: MapFiles,
  author: string,
): Promise<{ upload: CustomMapUpload; skipped: string[] }> {
  if (
    files.mapBin === undefined ||
    files.map4xBin === undefined ||
    files.map16xBin === undefined
  ) {
    throw new Error("the exported terrain lacks a map file");
  }
  const { spawns, skipped } = nationSpawns(doc);
  const stored = serializeScenarioDocument(doc);
  return {
    upload: {
      header: {
        name: doc.meta.name,
        author: author.slice(0, 40),
        description: doc.meta.description.slice(0, 500),
      },
      manifest: { ...files.manifest, nations: spawns },
      mapBin: files.mapBin,
      map4xBin: files.map4xBin,
      map16xBin: files.map16xBin,
      thumbnail: await thumbnail(files),
      document: new TextEncoder().encode(JSON.stringify(stored)),
    },
    skipped,
  };
}
