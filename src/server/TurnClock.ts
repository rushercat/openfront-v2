/**
 * Calls `tick` every `intervalMs` on average — the game's turn clock.
 *
 * setInterval re-arms from the moment its callback ran, so every late wake-up
 * is added to the game's pace for good. Late wake-ups are the norm where the
 * system timer is coarse: Node on Windows sleeps in steps of ~15.6 ms, so a
 * 100 ms interval comes out at 100–116 ms and the whole game runs up to a
 * tenth slow, with uneven turns. This clock aims every turn at a fixed
 * schedule (start + n × interval) instead, so a late turn makes the next
 * one's wait shorter and the pace holds at exactly one turn per interval.
 *
 * After a long stall (the event loop blocked, the system clock jumped) it
 * starts the schedule over rather than firing the missed turns in a burst,
 * as setInterval would also skip them.
 */
export class TurnClock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private next = 0;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => void,
    // Date.now rather than performance.now: test fake timers move it too.
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.stop();
    this.running = true;
    this.next = this.now() + this.intervalMs;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private arm(): void {
    const delay = Math.max(0, this.next - this.now());
    this.timer = setTimeout(this.fire, delay);
  }

  private readonly fire = (): void => {
    this.timer = undefined;
    if (!this.running) return;
    const now = this.now();
    this.tick();
    if (!this.running) return; // tick() may stop the clock
    this.next += this.intervalMs;
    if (
      now - this.next > this.intervalMs ||
      this.next - now > 2 * this.intervalMs
    ) {
      this.next = now + this.intervalMs;
    }
    this.arm();
  };
}
