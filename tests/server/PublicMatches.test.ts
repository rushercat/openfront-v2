import EventEmitter from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterLobbyService } from "../../src/server/MasterLobbyService";
import { startPolling } from "../../src/server/PollingLoop";
import { publicMatchesEnabled } from "../../src/server/PublicMatches";
import { ServerEnv } from "../../src/server/ServerEnv";

vi.mock("../../src/server/Logger", () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

vi.mock("../../src/server/PollingLoop", () => ({
  startPolling: vi.fn(),
}));

function createMockWorker(): EventEmitter & { send: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
  };
  emitter.send = vi.fn();
  return emitter;
}

// openfront v2: private matches only, unless PUBLIC_MATCHES=1.
describe("public matches are off by default", () => {
  beforeEach(() => {
    vi.stubEnv("DOMAIN", "localhost");
    vi.stubEnv("PUBLIC_MATCHES", "");
    vi.spyOn(ServerEnv, "numWorkers").mockReturnValue(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.mocked(startPolling).mockClear();
  });

  it("reads the switch from the environment", () => {
    expect(publicMatchesEnabled()).toBe(false);
    vi.stubEnv("PUBLIC_MATCHES", "1");
    expect(publicMatchesEnabled()).toBe(true);
  });

  it("schedules no public lobbies", async () => {
    const playlist = { gameConfig: vi.fn(async () => ({})) };
    const log = { info: vi.fn(), error: vi.fn() } as any;
    const service = new MasterLobbyService(playlist as any, log);
    const worker = createMockWorker();
    service.registerWorker(0, worker as any);
    worker.emit("message", { type: "workerReady", workerId: 0 });
    const scheduler = vi
      .mocked(startPolling)
      .mock.calls.find(([, intervalMs]) => intervalMs === 1000)?.[0];
    expect(scheduler).toBeDefined();
    await scheduler!();
    const created = worker.send.mock.calls.filter(
      ([msg]) => msg.type === "createGame",
    );
    expect(created).toHaveLength(0);
    expect(playlist.gameConfig).not.toHaveBeenCalled();
  });
});
