import { GameMap } from "@openfront/engine-api/game/GameMap";
import { DebugSpan } from "../../utilities/DebugSpan";
import { PathFinder } from "../types";
import { AStar, AStarAdapter } from "./AStar";

export class AStarRail implements PathFinder<number> {
  private readonly aStar: AStar;
  private readonly regions: RailRegions;

  constructor(gameMap: GameMap) {
    const adapter = new RailAdapter(gameMap);
    this.aStar = new AStar({ adapter });
    this.regions = new RailRegions(gameMap);
  }

  /** Builds the region map now rather than on the first search. */
  prepare(): void {
    this.regions.prepare();
  }

  findPath(from: number | number[], to: number): number[] | null {
    // A rail that can't exist doesn't need a search: with no way across,
    // A* would explore every tile rails can reach from `from` (a whole
    // continent: 100 ms spikes for each station across a strait) before
    // giving up. Only answers "no path" where A* would have too.
    if (!this.regions.mayConnect(from, to)) return null;
    return DebugSpan.wrap("AStar.Rail:findPath", () =>
      this.aStar.findPath(from, to),
    );
  }
}

/**
 * Splits the tiles into regions no rail step crosses, in either direction.
 * Two tiles in different regions have no rail path between them; two tiles in
 * the same region may still have none (the steps are one-way in places), so
 * the search still decides those. Rebuilt whenever the terrain changed
 * (GameMap.terrainVersion): rails follow land, shorelines and impassable
 * terrain, which nukes and the editor can change.
 */
export class RailRegions {
  private region: Int32Array | null = null;
  private version = -1;

  constructor(private readonly map: GameMap) {}

  prepare(): void {
    this.regions();
  }

  mayConnect(from: number | number[], to: number): boolean {
    const region = this.regions();
    const target = region[to];
    if (typeof from === "number") return region[from] === target;
    return from.some((f) => region[f] === target);
  }

  private regions(): Int32Array {
    const version = this.map.terrainVersion();
    if (this.region === null || version !== this.version) {
      this.region = this.label();
      this.version = version;
    }
    return this.region;
  }

  /** Flood-fills the regions over the steps taken in either direction. */
  private label(): Int32Array {
    const map = this.map;
    const w = map.width();
    const n = w * map.height();
    // Per tile: bit 0 land, bit 1 shoreline, bit 2 impassable — read once,
    // then the fill below only touches typed arrays.
    const kind = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
      const b = map.terrainByte(t);
      const land = (b & TERRAIN_LAND) !== 0;
      kind[t] =
        (land ? K_LAND : 0) |
        ((b & TERRAIN_SHORELINE) !== 0 ? K_SHORE : 0) |
        (land && (b & TERRAIN_MAGNITUDE) === IMPASSABLE_MAGNITUDE
          ? K_IMPASSABLE
          : 0);
    }
    // A rail may step from a onto its neighbour b (RailAdapter's rule):
    // never out of impassable terrain; onto land, or along a shoreline.
    const step = (ka: number, kb: number): boolean =>
      (ka & K_IMPASSABLE) === 0 &&
      ((kb & K_LAND) !== 0 || ((ka | kb) & K_SHORE) !== 0);
    const linked = (a: number, b: number): boolean =>
      step(kind[a], kind[b]) || step(kind[b], kind[a]);

    const region = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let next = 0;
    for (let seed = 0; seed < n; seed++) {
      if (region[seed] !== -1) continue;
      const id = next++;
      region[seed] = id;
      let top = 0;
      stack[top++] = seed;
      while (top > 0) {
        const t = stack[--top];
        const x = t % w;
        if (t >= w) {
          const m = t - w;
          if (region[m] === -1 && linked(t, m)) {
            region[m] = id;
            stack[top++] = m;
          }
        }
        if (t < n - w) {
          const m = t + w;
          if (region[m] === -1 && linked(t, m)) {
            region[m] = id;
            stack[top++] = m;
          }
        }
        if (x !== 0) {
          const m = t - 1;
          if (region[m] === -1 && linked(t, m)) {
            region[m] = id;
            stack[top++] = m;
          }
        }
        if (x !== w - 1) {
          const m = t + 1;
          if (region[m] === -1 && linked(t, m)) {
            region[m] = id;
            stack[top++] = m;
          }
        }
      }
    }
    return region;
  }
}

// Terrain byte layout (GameMapImpl): bit 7 land, bit 6 shoreline, bits 0-4
// magnitude; land of magnitude 31 is impassable.
const TERRAIN_LAND = 1 << 7;
const TERRAIN_SHORELINE = 1 << 6;
const TERRAIN_MAGNITUDE = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;
const K_LAND = 1;
const K_SHORE = 2;
const K_IMPASSABLE = 4;

// Internal adapter
class RailAdapter implements AStarAdapter {
  private readonly gameMap: GameMap;
  private readonly width: number;
  private readonly height: number;
  private readonly _numNodes: number;
  private readonly waterPenalty = 5;
  private readonly heuristicWeight = 2;
  private readonly directionChangePenalty = 3;

  constructor(gameMap: GameMap) {
    this.gameMap = gameMap;
    this.width = gameMap.width();
    this.height = gameMap.height();
    this._numNodes = this.width * this.height;
  }

  numNodes(): number {
    return this._numNodes;
  }

  maxNeighbors(): number {
    return 4;
  }

  maxPriority(): number {
    const maxCost = 1 + this.waterPenalty + this.directionChangePenalty;
    return this.heuristicWeight * (this.width + this.height) * maxCost;
  }

  neighbors(node: number, buffer: Int32Array): number {
    let count = 0;
    const x = node % this.width;
    const fromShoreline = this.gameMap.isShoreline(node);
    const isImpassable = this.gameMap.isImpassable(node);

    if (node >= this.width) {
      const n = node - this.width;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }
    if (node < this._numNodes - this.width) {
      const n = node + this.width;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }
    if (x !== 0) {
      const n = node - 1;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }
    if (x !== this.width - 1) {
      const n = node + 1;
      if (this.isTraversable(n, fromShoreline, isImpassable))
        buffer[count++] = n;
    }

    return count;
  }

  private isTraversable(
    to: number,
    fromShoreline: boolean,
    isImpassable: boolean,
  ): boolean {
    if (isImpassable) return false;
    const toWater = this.gameMap.isWater(to);
    if (!toWater) return true;
    return fromShoreline || this.gameMap.isShoreline(to);
  }

  cost(from: number, to: number, prev?: number): number {
    const penalized = this.gameMap.isWater(to) || this.gameMap.isShoreline(to);
    let c = penalized ? 1 + this.waterPenalty : 1;

    if (prev !== undefined) {
      const d1 = from - prev;
      const d2 = to - from;
      if (d1 !== d2) {
        c += this.directionChangePenalty;
      }
    }

    return c;
  }

  heuristic(node: number, goal: number): number {
    const nx = node % this.width;
    const ny = (node / this.width) | 0;
    const gx = goal % this.width;
    const gy = (goal / this.width) | 0;
    return this.heuristicWeight * (Math.abs(nx - gx) + Math.abs(ny - gy));
  }
}
