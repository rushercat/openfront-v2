/**
 * Caps how often the game map is drawn.
 *
 * requestAnimationFrame fires once per display refresh: 240 times a second
 * on a 240 Hz laptop, 540 on a 540 Hz monitor. The simulation only changes
 * ten times a second, so drawing the whole map (and running the per-frame
 * camera, metrics and HUD work) at those rates spends GPU and main-thread
 * time on frames nobody can tell apart, and that time is taken from input,
 * the worker's updates and the HUD — the game feels laggier, not smoother.
 *
 * The pacer is asked on every animation frame whether to draw it. It draws
 * every n-th refresh, n chosen from the measured refresh interval, so the
 * frames stay evenly spaced (a plain "at most every 1000/cap ms" check would
 * alternate between n and n+1 refreshes and judder):
 *   540 Hz, cap 120 → every 4th refresh (135 fps)
 *   240 Hz, cap 120 → every 2nd (120 fps)
 *   144 Hz, cap 120 → every refresh (144 fps — the cap is a ceiling for the
 *                     fast displays, never a reason to halve a normal one)
 *    60 Hz, cap 30  → every 2nd (30 fps)
 */

/** Choices offered in the settings; 0 means no cap. */
export const MAX_FPS_OPTIONS: readonly number[] = [
  30, 60, 90, 120, 144, 240, 0,
];

/** Cap for players who never picked one. */
export const DEFAULT_MAX_FPS = 120;

/** Refresh intervals outside this range are pauses, not the display rate. */
const MIN_VSYNC_MS = 1;
const MAX_VSYNC_MS = 50;

/**
 * Refreshes between two drawn frames for a display refreshing every
 * `vsyncMs` and a cap of `maxFps` (0 = uncapped). Rounds a little in favour
 * of drawing more often, so a cap just under the refresh rate (120 on a
 * 144 Hz screen) keeps every frame.
 */
export function refreshesPerFrame(vsyncMs: number, maxFps: number): number {
  if (!(maxFps > 0) || !(vsyncMs > 0)) return 1;
  const ratio = 1000 / maxFps / vsyncMs;
  return Math.max(1, Math.floor(ratio + 0.25));
}

export class FramePacer {
  /** Smoothed time between two animation frames (the display's refresh). */
  private vsyncMs = 1000 / 60;
  private lastRafAt: number | null = null;
  private lastDrawAt: number | null = null;
  private step = 1;
  private stepCap = -1;
  private stepVsync = -1;

  constructor(private readonly maxFps: () => number) {}

  /** The refresh interval measured so far, in ms. */
  refreshIntervalMs(): number {
    return this.vsyncMs;
  }

  /** Call on every animation frame; true when this frame should be drawn. */
  shouldDraw(nowMs: number): boolean {
    this.measure(nowMs);
    const cap = this.maxFps();
    if (!(cap > 0) || this.lastDrawAt === null) {
      this.lastDrawAt = nowMs;
      return true;
    }
    const step = this.stepFor(cap);
    // Half a refresh of slack: frame timestamps are only refresh-aligned up
    // to a little jitter, and a frame the browser dropped still counts.
    if (nowMs - this.lastDrawAt >= (step - 0.5) * this.vsyncMs) {
      this.lastDrawAt = nowMs;
      return true;
    }
    return false;
  }

  /** Forget the last frame, e.g. after the tab was hidden. */
  reset(): void {
    this.lastRafAt = null;
    this.lastDrawAt = null;
  }

  private measure(nowMs: number): void {
    const last = this.lastRafAt;
    this.lastRafAt = nowMs;
    if (last === null) return;
    const delta = nowMs - last;
    if (delta < MIN_VSYNC_MS || delta > MAX_VSYNC_MS) return;
    // Follows a faster refresh at once (a window dragged to a faster
    // monitor) but a slower one only gradually: a long draw or a busy main
    // thread makes single frames late without the display having changed.
    this.vsyncMs =
      delta < this.vsyncMs
        ? this.vsyncMs * 0.5 + delta * 0.5
        : this.vsyncMs * 0.98 + delta * 0.02;
  }

  /**
   * The step is only recomputed once the refresh estimate moved by more
   * than 10 %, so noise around a rounding boundary can't make the frame
   * spacing flip back and forth.
   */
  private stepFor(cap: number): number {
    if (
      cap !== this.stepCap ||
      Math.abs(this.vsyncMs - this.stepVsync) > this.stepVsync * 0.1
    ) {
      this.stepCap = cap;
      this.stepVsync = this.vsyncMs;
      this.step = refreshesPerFrame(this.vsyncMs, cap);
    }
    return this.step;
  }
}

type FrameListener = (nowMs: number) => void;
const frameListeners = new Set<FrameListener>();

/**
 * Runs `listener` after every drawn game frame (not every animation frame:
 * the capped ones in between draw nothing). Returns the unsubscribe.
 */
export function onFrameDrawn(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

/** Whether a game frame loop is running (and will report drawn frames). */
export function hasFrameDriver(): boolean {
  return frameDriverCount > 0;
}

let frameDriverCount = 0;

/** The game's frame loop announces itself, so listeners know frames will come. */
export function registerFrameDriver(): () => void {
  frameDriverCount++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    frameDriverCount--;
  };
}

/** Called by the game's frame loop after it drew a frame. */
export function notifyFrameDrawn(nowMs: number): void {
  for (const listener of frameListeners) listener(nowMs);
}
