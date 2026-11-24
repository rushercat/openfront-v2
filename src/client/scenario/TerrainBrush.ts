/**
 * The terrain and territory brushes (docs/ScenarioEditor.md, "Terrain"):
 * which tiles a round brush covers, and a stroke that paints them through
 * the DocumentEditor in batches.
 */

import type { DocumentEditor, Edit } from "./DocumentEditor";
import { IMPASSABLE, isOwnable, land } from "./ScenarioDocument";

/**
 * The tiles within `radius` of tile (cx, cy), clipped to a `width` x
 * `height` map: those whose centre lies in a circle of radius + 0.5 tiles
 * about the centre tile's, so radius 0 is one tile and the brush preview,
 * a circle 2 * radius + 1 tiles across, outlines them.
 */
export function discTiles(
  cx: number,
  cy: number,
  radius: number,
  width: number,
  height: number,
): number[] {
  const tiles: number[] = [];
  addDisc(tiles, null, cx, cy, radius, width, height);
  return tiles;
}

/**
 * The tiles the brush covers moving from tile (x0, y0) to tile (x1, y1): a
 * disc at each tile of the line between, each tile once.
 */
export function lineTiles(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  width: number,
  height: number,
): number[] {
  const tiles: number[] = [];
  const seen = new Set<number>();
  // Bresenham.
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    addDisc(tiles, seen, x, y, radius, width, height);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return tiles;
}

function addDisc(
  tiles: number[],
  seen: Set<number> | null,
  cx: number,
  cy: number,
  radius: number,
  width: number,
  height: number,
): void {
  const r2 = radius * radius + radius;
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(width - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(height - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy > r2) continue;
      const t = y * width + x;
      if (seen !== null) {
        if (seen.has(t)) continue;
        seen.add(t);
      }
      tiles.push(t);
    }
  }
}

/**
 * One stroke of a brush: moveTo() collects the tiles it passes that it would
 * change, flush() applies them as one edit, and end() makes the stroke one
 * undo step. A stroke that changes nothing sends nothing.
 */
export class BrushStroke {
  private last: { x: number; y: number } | null = null;
  private readonly pending = new Set<number>();
  protected changed = false;

  constructor(
    protected readonly editor: DocumentEditor,
    readonly radius: number,
    /** Whether painting the tile would change it. */
    private readonly changes: (tile: number) => boolean,
    /** The edit that paints the tiles. */
    private readonly edit: (tiles: number[]) => Edit,
  ) {}

  /** Moves the brush to tile (x, y), which may lie off the map. */
  moveTo(x: number, y: number): void {
    const { width, height } = this.editor.doc;
    const from = this.last ?? { x, y };
    const tiles = lineTiles(from.x, from.y, x, y, this.radius, width, height);
    for (const t of tiles) {
      if (this.changes(t)) this.pending.add(t);
    }
    this.last = { x, y };
  }

  /** Applies the tiles collected since the last flush. */
  flush(): void {
    if (this.pending.size === 0) return;
    const tiles = [...this.pending];
    this.pending.clear();
    this.editor.apply(this.edit(tiles));
    this.changed = true;
  }

  /** Flushes and commits; returns whether the stroke changed anything. */
  end(): boolean {
    this.flush();
    this.editor.commit();
    return this.changed;
  }
}

/** Paints a terrain byte, skipping tiles that already hold it. */
export class TerrainStroke extends BrushStroke {
  constructor(editor: DocumentEditor, terrain: number, radius: number) {
    const { doc } = editor;
    super(
      editor,
      radius,
      (t) => doc.terrain[t] !== terrain,
      (tiles) => ({
        type: "set_terrain",
        tiles,
        terrain: tiles.map(() => terrain),
      }),
    );
  }
}

/**
 * Gives land to the nation with id `owner`, or to nobody when it's null.
 * Skips water, impassable tiles and tiles the owner already has.
 */
export class TerritoryStroke extends BrushStroke {
  constructor(editor: DocumentEditor, owner: string | null, radius: number) {
    const { doc } = editor;
    super(
      editor,
      radius,
      (t) => {
        const o = doc.owners[t];
        if (owner === null) return o !== 0;
        return (
          isOwnable(doc.terrain[t]) &&
          (o === 0 || doc.nations[o - 1].id !== owner)
        );
      },
      (tiles) => ({ type: "set_owner", tiles, owner }),
    );
  }
}

/** Elevation of a land byte, or null for water and impassable tiles. */
export function landElevation(b: number): number | null {
  if (b < 0x80 || b >= IMPASSABLE) return null;
  return b & 0x1f;
}

/**
 * openfront v2: land with automatic slopes. The brush itself paints land at
 * `elevation` like the plain terrain brush; around it, `slopeWidth` tiles
 * of land fall off towards the flat. The slope only ever raises land: a tile
 * that is already as high or higher (another mountain) keeps its height, and
 * water and impassable tiles stay. Afterwards the slopes are ordinary land
 * that any brush can paint over.
 */
export class SlopeStroke extends BrushStroke {
  private lastPos: { x: number; y: number } | null = null;
  /** Tile → terrain byte this stroke will set. */
  private readonly targets = new Map<number, number>();
  /**
   * What this stroke already sent. In a shared session the editor applies
   * an edit only once the server echoes it, so the document can still show
   * the old height: compare against this too, or a later, lower slope value
   * could undercut an earlier, higher one.
   */
  private readonly sent = new Map<number, number>();

  constructor(
    editor: DocumentEditor,
    private readonly elevation: number,
    radius: number,
    readonly slopeWidth: number,
  ) {
    super(
      editor,
      radius,
      () => false,
      (tiles) => ({ type: "set_terrain", tiles, terrain: [] }),
    );
  }

  override moveTo(x: number, y: number): void {
    const from = this.lastPos ?? { x, y };
    // Bresenham, like lineTiles: one brush position per tile of the line.
    const dx = Math.abs(x - from.x);
    const dy = -Math.abs(y - from.y);
    const sx = from.x < x ? 1 : -1;
    const sy = from.y < y ? 1 : -1;
    let err = dx + dy;
    let cx = from.x;
    let cy = from.y;
    for (;;) {
      this.stamp(cx, cy);
      if (cx === x && cy === y) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        cx += sx;
      }
      if (e2 <= dx) {
        err += dx;
        cy += sy;
      }
    }
    this.lastPos = { x, y };
  }

  /** The brush and its slope around tile (cx, cy). */
  private stamp(cx: number, cy: number): void {
    const { doc } = this.editor;
    const { width, height } = doc;
    const r = this.radius;
    const outer = r + this.slopeWidth;
    const core2 = r * r + r;
    const x0 = Math.max(0, cx - outer);
    const x1 = Math.min(width - 1, cx + outer);
    const y0 = Math.max(0, cy - outer);
    const y1 = Math.min(height - 1, cy + outer);
    const coreByte = land(this.elevation);
    for (let y = y0; y <= y1; y++) {
      const ddy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const ddx = x - cx;
        const d2 = ddx * ddx + ddy * ddy;
        const t = y * width + x;
        if (d2 <= core2) {
          // The brush itself: plain land at the chosen height.
          if (doc.terrain[t] !== coreByte && this.sent.get(t) !== coreByte) {
            this.targets.set(t, coreByte);
          }
          continue;
        }
        // Distance past the brush edge, 0..1 over the slope width.
        const past = (Math.sqrt(d2) - (r + 0.5)) / (this.slopeWidth + 0.5);
        if (past >= 1) continue;
        // Falls off from the brush edge, a little gentler towards the foot.
        const height = Math.round(this.elevation * Math.pow(1 - past, 1.3));
        if (height <= 0) continue;
        const current = landElevation(doc.terrain[t]);
        if (current === null) continue;
        const planned = this.targets.get(t);
        const plannedHeight = planned === undefined ? -1 : planned & 0x1f;
        const sent = this.sent.get(t);
        const sentHeight = sent === undefined ? -1 : sent & 0x1f;
        if (height <= current || height <= plannedHeight) continue;
        if (height <= sentHeight) continue;
        this.targets.set(t, land(height));
      }
    }
  }

  override flush(): void {
    if (this.targets.size === 0) return;
    const tiles: number[] = [];
    const terrain: number[] = [];
    for (const [t, b] of this.targets) {
      if (this.editor.doc.terrain[t] === b) continue;
      tiles.push(t);
      terrain.push(b);
      this.sent.set(t, b);
    }
    this.targets.clear();
    if (tiles.length === 0) return;
    this.editor.apply({ type: "set_terrain", tiles, terrain });
    this.changed = true;
  }
}
