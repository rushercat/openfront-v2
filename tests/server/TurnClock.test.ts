import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnClock } from "../../src/server/TurnClock";

describe("TurnClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("ticks once per interval", () => {
    let ticks = 0;
    const clock = new TurnClock(100, () => ticks++);
    clock.start();
    vi.advanceTimersByTime(99);
    expect(ticks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ticks).toBe(1);
    vi.advanceTimersByTime(900);
    expect(ticks).toBe(10);
    clock.stop();
  });

  it("makes up for late wake-ups instead of slowing the game", () => {
    // Every wake-up 15 ms late, as with Windows' coarse timer: the clock
    // reads the lateness and shortens the next wait, so the pace holds.
    let late = 0;
    let ticks = 0;
    const clock = new TurnClock(
      100,
      () => ticks++,
      () => Date.now() + late,
    );
    clock.start();
    for (let i = 0; i < 100; i++) {
      late = 15;
      vi.advanceTimersByTime(100);
    }
    // setInterval would have managed ~87 turns in these 10 s.
    expect(ticks).toBeGreaterThanOrEqual(99);
    expect(ticks).toBeLessThanOrEqual(101);
    clock.stop();
  });

  it("starts over after a long stall instead of bursting", () => {
    let ticks = 0;
    const clock = new TurnClock(100, () => ticks++);
    clock.start();
    vi.advanceTimersByTime(100);
    expect(ticks).toBe(1);
    // The event loop was blocked for a second: no timer ran meanwhile.
    vi.setSystemTime(Date.now() + 1000);
    vi.advanceTimersByTime(100);
    expect(ticks).toBe(2);
    // One turn per interval from here on, not ten at once.
    vi.advanceTimersByTime(100);
    expect(ticks).toBeLessThanOrEqual(4);
    clock.stop();
  });

  it("stops", () => {
    let ticks = 0;
    const clock = new TurnClock(100, () => ticks++);
    clock.start();
    vi.advanceTimersByTime(250);
    clock.stop();
    vi.advanceTimersByTime(1000);
    expect(ticks).toBe(2);
    expect(clock.isRunning()).toBe(false);
  });
});
