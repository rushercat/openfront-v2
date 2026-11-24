/**
 * Where moving units are drawn between two simulation ticks.
 *
 * The simulation moves units ten times a second, a whole tile at a time.
 * Drawn at those positions, ships, trains and boats hop from tile to tile
 * at 10 fps however fast the display runs. UnitPass works out once per tick
 * which units moved and where from; every frame, they are drawn that far
 * along the way from the previous tick's tile to the current one, so they
 * glide. Everything drawn on a unit (health bars, veterancy pips, lights,
 * the selection box) asks the same glide, so it stays on the unit.
 *
 * The cost is that a moving unit is drawn up to one tick behind where the
 * simulation has it — the usual trade of interpolation, invisible at 100 ms.
 */

/**
 * More tiles than this in one tick is a jump (a train switching rails at a
 * station, a unit placed somewhere new), not a move: it's drawn there at once.
 */
export const MAX_GLIDE_TILES = 8;

/** Whether a unit that went from tile `from` to `to` in one tick glides. */
export function glides(from: number, to: number, mapW: number): boolean {
  if (from === to || from < 0) return false;
  const fx = from % mapW;
  const tx = to % mapW;
  const fy = (from - fx) / mapW;
  const ty = (to - tx) / mapW;
  return (
    Math.abs(tx - fx) <= MAX_GLIDE_TILES && Math.abs(ty - fy) <= MAX_GLIDE_TILES
  );
}

export class UnitGlide {
  /** Unit id → the tile it glides from this tick (gliding units only). */
  readonly from = new Map<number, number>();
  private tickStartMs = 0;
  private lastTickStartMs: number | null = null;
  /**
   * How long a tick actually lasts here, measured. Turns from a server don't
   * come exactly every msPerTick (a coarse server timer, the network), and a
   * slow machine takes longer per tick: gliding over the nominal 100 ms would
   * then make units stop for the rest of each tick — a hitch every tick.
   */
  private tickMs: number;

  constructor(
    /** Simulation tick length in ms (Config.msPerTick). */
    private readonly nominalTickMs: number,
    private readonly mapW: number,
  ) {
    this.tickMs = nominalTickMs;
  }

  /** A new simulation tick arrived (its unit positions are being uploaded). */
  startTick(nowMs: number): void {
    const last = this.lastTickStartMs;
    this.lastTickStartMs = nowMs;
    this.tickStartMs = nowMs;
    if (last === null) return;
    const interval = nowMs - last;
    // Bursts (catching up) and pauses say nothing about the steady pace.
    if (
      interval < this.nominalTickMs * 0.5 ||
      interval > this.nominalTickMs * 2
    ) {
      return;
    }
    this.tickMs = this.tickMs * 0.8 + interval * 0.2;
  }

  /** The tick length gliding is timed to, in ms. */
  tickLengthMs(): number {
    return this.tickMs;
  }

  /** How far through the current tick a frame drawn at `nowMs` is: 0..1. */
  alpha(nowMs: number): number {
    if (this.tickMs <= 0) return 1;
    const a = (nowMs - this.tickStartMs) / this.tickMs;
    return a <= 0 ? 0 : a >= 1 ? 1 : a;
  }

  /**
   * Where unit `id`, now on tile `pos`, is drawn at `alpha` — as fractional
   * tile coordinates written to `out` ([x, y]).
   */
  position(
    id: number,
    pos: number,
    alpha: number,
    out: [number, number],
  ): [number, number] {
    const x = pos % this.mapW;
    const y = (pos - x) / this.mapW;
    const from = this.from.get(id);
    if (from === undefined || alpha >= 1) {
      out[0] = x;
      out[1] = y;
      return out;
    }
    const fx = from % this.mapW;
    const fy = (from - fx) / this.mapW;
    out[0] = fx + (x - fx) * alpha;
    out[1] = fy + (y - fy) * alpha;
    return out;
  }
}
