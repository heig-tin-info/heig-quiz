// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionMonitor } from "./connection";

const health = {
  status: "ok", attention: false, uptimeSeconds: 5,
  checks: { database: "up", jobs: "up", runner: "disabled", ticker: "up", disk: "ok", backup: "unknown" },
};
let monitor: ConnectionMonitor;
let stop: () => void;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  fetcher = vi.fn().mockRejectedValue(new TypeError("Network unavailable"));
  vi.stubGlobal("fetch", fetcher);
  monitor = new ConnectionMonitor();
  stop = monitor.start();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("connection recovery", () => {
  it("ignores an isolated request/stream failure if the API is healthy", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(health)));
    monitor.suspect();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(monitor.getSnapshot()).toBe("connected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("delays the veil, coalesces failures, and recovers without replaying writes", async () => {
    monitor.suspect();
    monitor.suspect();
    await vi.advanceTimersByTimeAsync(1_199);
    expect(monitor.getSnapshot()).toBe("connected");
    await vi.advanceTimersByTimeAsync(1);
    expect(monitor.getSnapshot()).toBe("reconnecting");
    fetcher.mockImplementation(async () => new Response(JSON.stringify(health)));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(monitor.getSnapshot()).toBe("connected");
    expect(fetcher.mock.calls.every(([path, init]) => path === "/healthz" && !init.method)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the explicit update message across failures and a browser reconnect", async () => {
    monitor.updating();
    expect(monitor.getSnapshot()).toBe("updating");
    monitor.suspect();
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(monitor.getSnapshot()).toBe("updating");
    fetcher.mockImplementation(async () => new Response(JSON.stringify(health)));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(monitor.getSnapshot()).toBe("connected");
  });

  it("does not mistake a captive portal or degraded database for recovery", async () => {
    fetcher.mockResolvedValueOnce(new Response("<html>Sign in</html>"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...health, status: "degraded" })));
    monitor.suspect();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(monitor.getSnapshot()).toBe("reconnecting");
  });

  it("ignores an old success after a shutdown announcement", async () => {
    let complete!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
    monitor.suspect();
    monitor.updating();
    complete(new Response(JSON.stringify(health)));
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getSnapshot()).toBe("updating");
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("aborts a hung probe after five seconds and schedules another", async () => {
    fetcher.mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    monitor.suspect();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(monitor.getSnapshot()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("detects an offline browser on mount and retries when it comes online", async () => {
    stop();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    stop = monitor.start();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(monitor.getSnapshot()).toBe("reconnecting");
    expect(fetcher).not.toHaveBeenCalled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    fetcher.mockResolvedValue(new Response(JSON.stringify(health)));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getSnapshot()).toBe("connected");
  });
});
