import { describe, expect, it } from "vitest";
import { FramePacer, refreshesPerFrame } from "../../src/client/FramePacer";

/** Feeds `frames` animation frames at `hz`, returns how many were drawn. */
function drawn(hz: number, cap: number, frames: number): number {
  const pacer = new FramePacer(() => cap);
  const vsync = 1000 / hz;
  let count = 0;
  for (let i = 0; i < frames; i++) {
    // A little timestamp jitter, as real frame times have.
    const jitter = i % 3 === 0 ? 0.05 : i % 3 === 1 ? -0.05 : 0;
    if (pacer.shouldDraw(1000 + i * vsync + jitter)) count++;
  }
  return count;
}

describe("refreshesPerFrame", () => {
  it("draws every refresh without a cap", () => {
    expect(refreshesPerFrame(1000 / 540, 0)).toBe(1);
  });

  it("keeps every frame when the cap is just under the refresh rate", () => {
    expect(refreshesPerFrame(1000 / 144, 120)).toBe(1);
    expect(refreshesPerFrame(1000 / 165, 120)).toBe(1);
  });

  it("skips refreshes on fast displays", () => {
    expect(refreshesPerFrame(1000 / 240, 120)).toBe(2);
    expect(refreshesPerFrame(1000 / 540, 120)).toBe(4);
    expect(refreshesPerFrame(1000 / 60, 30)).toBe(2);
  });
});

describe("FramePacer", () => {
  it("caps a 540 Hz display near the limit, evenly spaced", () => {
    // 10 s at 540 Hz with a 120 cap: every 4th refresh = 135 fps.
    const count = drawn(540, 120, 5400);
    expect(count).toBeGreaterThan(1300);
    expect(count).toBeLessThan(1400);
  });

  it("halves a 240 Hz display at a 120 cap", () => {
    const count = drawn(240, 120, 2400);
    expect(count).toBeGreaterThan(1150);
    expect(count).toBeLessThan(1250);
  });

  it("leaves a 60 Hz display alone at a 120 cap", () => {
    expect(drawn(60, 120, 600)).toBe(600);
  });

  it("draws every frame without a cap", () => {
    expect(drawn(540, 0, 540)).toBe(540);
  });

  it("follows a cap change", () => {
    let cap = 0;
    const pacer = new FramePacer(() => cap);
    const vsync = 1000 / 240;
    let count = 0;
    for (let i = 0; i < 240; i++) {
      if (pacer.shouldDraw(i * vsync)) count++;
    }
    expect(count).toBe(240);
    cap = 60;
    count = 0;
    for (let i = 240; i < 480; i++) {
      if (pacer.shouldDraw(i * vsync)) count++;
    }
    expect(count).toBeGreaterThan(55);
    expect(count).toBeLessThan(65);
  });
});
