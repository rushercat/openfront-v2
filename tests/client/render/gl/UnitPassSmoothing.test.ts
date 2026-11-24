/**
 * Render-side nuke smoothing (UnitPass).
 *
 * `applyMissileSmoothing` lerps each recorded segment's lastPos→pos by
 * wall-clock progress through the current tick and rewrites the missile
 * instance buffer's x/y, leaving the packed per-instance bytes untouched.
 * `flickerHashByte` reproduces (CPU-side) the per-instance flicker phase the
 * vertex shader used to derive from its rendered position.
 *
 * The GL pass is exercised directly via its prototype with stubbed GL calls —
 * the real method runs, only the two WebGL calls it makes are captured.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flickerHashByte,
  headingByte,
  nextAircraftHeading,
  UnitPass,
} from "../../../../src/client/render/gl/passes/UnitPass";
import {
  glides,
  MAX_GLIDE_TILES,
  UnitGlide,
} from "../../../../src/client/render/gl/utils/UnitGlide";

const FLOATS_PER_INSTANCE = 4;
const TICK_MS = 100;

interface SmoothingHarness {
  pass: UnitPass;
  f32: Float32Array;
  bufferSubData: ReturnType<typeof vi.fn>;
}

/**
 * Build a UnitPass instance without its GL-heavy constructor, wiring up only
 * the fields applyMissileSmoothing touches.
 */
function makeSmoothingHarness(
  segs: number[],
  instanceCount: number,
  nowMs: number,
  lastUpdateMs: number,
): SmoothingHarness {
  const f32 = new Float32Array(instanceCount * FLOATS_PER_INSTANCE);
  const bufferSubData = vi.fn();
  const gl = {
    ARRAY_BUFFER: 0x8892,
    bindBuffer: vi.fn(),
    bufferSubData,
  };

  vi.spyOn(performance, "now").mockReturnValue(nowMs);

  const glide = new UnitGlide(TICK_MS, 1000);
  glide.startTick(lastUpdateMs);
  const pass = Object.create(UnitPass.prototype) as UnitPass;
  Object.assign(pass, {
    gl,
    smoothSegs: segs,
    missileCount: instanceCount,
    missileBuf: { float32: f32, buffer: {} },
    missilesSettled: false,
    glide,
  });

  return { pass, f32, bufferSubData };
}

function runSmoothing(h: SmoothingHarness): void {
  (
    h.pass as unknown as { applyMissileSmoothing(): void }
  ).applyMissileSmoothing();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UnitPass.applyMissileSmoothing", () => {
  it("lerps lastPos→pos by wall-clock progress through the tick", () => {
    // instance 2; lastPos (10,20) → pos (30,40); 50ms into a 100ms tick.
    const h = makeSmoothingHarness([2, 10, 20, 30, 40], 5, 1050, 1000);
    runSmoothing(h);

    const off = 2 * FLOATS_PER_INSTANCE;
    expect(h.f32[off + 0]).toBeCloseTo(20); // 10 + (30-10)*0.5
    expect(h.f32[off + 1]).toBeCloseTo(30); // 20 + (40-20)*0.5
  });

  it("sits at lastPos at the start of the tick (alpha 0)", () => {
    const h = makeSmoothingHarness([0, 10, 20, 30, 40], 1, 1000, 1000);
    runSmoothing(h);
    expect(h.f32[0]).toBeCloseTo(10);
    expect(h.f32[1]).toBeCloseTo(20);
  });

  it("clamps alpha to 1 so a stalled tick settles exactly on pos", () => {
    // 200ms elapsed into a 100ms tick → alpha would be 2, clamped to 1.
    const h = makeSmoothingHarness([0, 10, 20, 30, 40], 1, 1200, 1000);
    runSmoothing(h);
    expect(h.f32[0]).toBeCloseTo(30);
    expect(h.f32[1]).toBeCloseTo(40);
  });

  it("writes each segment to its own instance slot and leaves others alone", () => {
    const h = makeSmoothingHarness([1, 0, 0, 8, 16], 3, 1050, 1000);
    // Mark instance 0's slot; it has no segment and must be untouched.
    h.f32[0] = 111;
    h.f32[1] = 222;
    runSmoothing(h);

    expect(h.f32[0]).toBe(111);
    expect(h.f32[1]).toBe(222);
    const off = 1 * FLOATS_PER_INSTANCE;
    expect(h.f32[off + 0]).toBeCloseTo(4); // 0 + 8*0.5
    expect(h.f32[off + 1]).toBeCloseTo(8); // 0 + 16*0.5
  });

  it("overwrites only x/y, preserving the packed ownerID/atlas/flags floats", () => {
    const h = makeSmoothingHarness([0, 10, 20, 30, 40], 1, 1050, 1000);
    h.f32[2] = 999; // ownerID slot
    h.f32[3] = 888; // packed atlasIdx/flags/flickerHash slot
    runSmoothing(h);
    expect(h.f32[2]).toBe(999);
    expect(h.f32[3]).toBe(888);
  });

  it("handles multiple smoothed nukes in one pass", () => {
    const h = makeSmoothingHarness(
      [0, 0, 0, 10, 10, 2, 100, 100, 200, 200],
      3,
      1050,
      1000,
    );
    runSmoothing(h);
    expect(h.f32[0]).toBeCloseTo(5);
    expect(h.f32[1]).toBeCloseTo(5);
    expect(h.f32[2 * FLOATS_PER_INSTANCE + 0]).toBeCloseTo(150);
    expect(h.f32[2 * FLOATS_PER_INSTANCE + 1]).toBeCloseTo(150);
  });

  it("re-uploads exactly the active missile-instance float range", () => {
    const h = makeSmoothingHarness([0, 10, 20, 30, 40], 4, 1050, 1000);
    runSmoothing(h);
    expect(h.bufferSubData).toHaveBeenCalledTimes(1);
    const args = h.bufferSubData.mock.calls[0];
    // gl.bufferSubData(ARRAY_BUFFER, dstOffset, srcData, srcOffset, length)
    expect(args[1]).toBe(0);
    expect(args[3]).toBe(0);
    expect(args[4]).toBe(4 * FLOATS_PER_INSTANCE);
  });

  it("does nothing when there are no smoothed segments", () => {
    const h = makeSmoothingHarness([], 3, 1050, 1000);
    runSmoothing(h);
    expect(h.bufferSubData).not.toHaveBeenCalled();
  });

  it("stops re-uploading once the tick's end positions are in", () => {
    const h = makeSmoothingHarness([0, 10, 20, 30, 40], 1, 1200, 1000);
    runSmoothing(h);
    runSmoothing(h);
    expect(h.bufferSubData).toHaveBeenCalledTimes(1);
  });
});

describe("UnitGlide", () => {
  const W = 1000;
  const at = (x: number, y: number) => y * W + x;

  it("glides a unit that moved a few tiles", () => {
    expect(glides(at(10, 10), at(11, 10), W)).toBe(true);
    expect(glides(at(10, 10), at(10 + MAX_GLIDE_TILES, 10), W)).toBe(true);
  });

  it("doesn't glide a unit that stood still or jumped", () => {
    expect(glides(at(10, 10), at(10, 10), W)).toBe(false);
    expect(glides(at(10, 10), at(10, 10 + MAX_GLIDE_TILES + 1), W)).toBe(false);
    // Wrapping around the row edge is a jump, not a one-tile step.
    expect(glides(at(W - 1, 10), at(0, 11), W)).toBe(false);
  });

  it("times the glide to how long ticks really take", () => {
    const glide = new UnitGlide(TICK_MS, W);
    // Turns arriving every 110 ms (a coarse server timer).
    for (let t = 0; t <= 3000; t += 110) glide.startTick(t);
    expect(glide.tickLengthMs()).toBeGreaterThan(108);
    expect(glide.tickLengthMs()).toBeLessThan(112);
    // A catch-up burst and a pause leave the estimate alone.
    glide.startTick(3305);
    glide.startTick(3310);
    glide.startTick(9000);
    expect(glide.tickLengthMs()).toBeGreaterThan(108);
    expect(glide.tickLengthMs()).toBeLessThan(112);
  });

  it("places a gliding unit along its step and others on their tile", () => {
    const glide = new UnitGlide(TICK_MS, W);
    glide.startTick(1000);
    glide.from.set(7, at(10, 20));
    const out: [number, number] = [0, 0];
    expect(glide.position(7, at(14, 20), glide.alpha(1025), out)).toEqual([
      11, 20,
    ]);
    expect(glide.position(8, at(3, 4), glide.alpha(1025), out)).toEqual([3, 4]);
    // Past the end of the tick it rests on its tile.
    expect(glide.position(7, at(14, 20), glide.alpha(1500), out)).toEqual([
      14, 20,
    ]);
  });
});

describe("flickerHashByte", () => {
  const fract = (x: number, y: number) => {
    const v = x * 0.1731 + y * 0.3179;
    return v - Math.floor(v);
  };

  it("returns an integer byte in [0, 254]", () => {
    for (const [x, y] of [
      [0, 0],
      [3, 5],
      [40, 80],
      [127, 255],
    ]) {
      const h = flickerHashByte(x, y);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(254);
    }
  });

  it("is deterministic for a given tile position", () => {
    expect(flickerHashByte(12, 34)).toBe(flickerHashByte(12, 34));
  });

  it("matches the shader's fract(worldX*0.1731 + worldY*0.3179) phase", () => {
    for (const [x, y] of [
      [3, 5],
      [17, 42],
      [80, 9],
    ]) {
      // byte/255 should reproduce the original fract phase to within one step.
      expect(flickerHashByte(x, y) / 255).toBeCloseTo(fract(x, y), 2);
    }
  });
});

describe("aircraft heading", () => {
  const W = 1000;
  const at = (x: number, y: number) => y * W + x;
  /** Feeds the moves along a path, as one tick each, and returns the bytes. */
  function fly(path: [number, number][]): number[] {
    let facing: ReturnType<typeof nextAircraftHeading> | undefined;
    const out: number[] = [];
    for (let i = 1; i < path.length; i++) {
      const [lx, ly] = path[i - 1];
      const [x, y] = path[i];
      facing = nextAircraftHeading(facing, at(x, y), at(lx, ly), x, y, lx, ly);
      out.push(facing.byte);
    }
    return out;
  }

  it("faces the way it flies", () => {
    expect(
      fly([
        [10, 10],
        [14, 10],
      ]),
    ).toEqual([headingByte(1, 0)]);
    expect(
      fly([
        [10, 10],
        [10, 6],
      ]),
    ).toEqual([0]);
    expect(
      fly([
        [10, 10],
        [10, 14],
      ]),
    ).toEqual([128]);
  });

  it("smooths the wobble of moves snapped to tiles", () => {
    // ~22° east of north at 2 tiles a tick snaps to (1,-2), (0,-2), (1,-2)…
    const path: [number, number][] = [[50, 50]];
    for (let i = 0; i < 8; i++) {
      const [x, y] = path[path.length - 1];
      path.push(i % 2 === 0 ? [x + 1, y - 2] : [x, y - 2]);
    }
    const bytes = fly(path).slice(2);
    const raw = [headingByte(1, -2), headingByte(0, -2)];
    const rawSpread = Math.abs(raw[0] - raw[1]);
    const spread = Math.max(...bytes) - Math.min(...bytes);
    expect(spread).toBeLessThan(rawSpread);
  });

  it("does not change while the same move is drawn again", () => {
    const first = nextAircraftHeading(
      undefined,
      at(12, 10),
      at(10, 10),
      12,
      10,
      10,
      10,
    );
    expect(
      nextAircraftHeading(first, at(12, 10), at(10, 10), 12, 10, 10, 10),
    ).toBe(first);
  });
});
