import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutosaveRequest, AutosaveResponse } from "@quiz/contracts";

import { ApiError } from "../api";
import { Autosave, type AutosaveOptions, type SyncState } from "./autosave";

/*
 * The client half of §4.7, rule by rule. Everything runs on fake timers: the
 * debounce, the three-second offline threshold and the backoff are the
 * specification, so a test that waited for real time would be asserting the
 * machine's mood.
 */

const serverNow = () => new Date("2026-09-20T10:00:00.000Z").toISOString();
const accepted = (revision: number): AutosaveResponse => ({
  revision,
  accepted: true,
  serverNow: serverNow(),
});

interface Sent {
  itemId: string;
  body: AutosaveRequest;
  resolve: (r: AutosaveResponse) => void;
  reject: (e: unknown) => void;
}

/** A transport whose every request is held open until the test answers it. */
function transport() {
  const sent: Sent[] = [];
  const send = (itemId: string, body: AutosaveRequest) =>
    new Promise<AutosaveResponse>((resolve, reject) => {
      sent.push({ itemId, body, resolve, reject });
    });
  return { sent, send };
}

function make(options: Partial<AutosaveOptions> = {}) {
  const t = transport();
  const states: SyncState[] = [];
  const adopted: { itemId: string; payload: unknown; revision: number }[] = [];
  const closed: (unknown | null)[] = [];
  const clocks: string[] = [];
  const save = new Autosave({
    send: t.send,
    onState: (s) => states.push(s),
    onAdopt: (itemId, payload, revision) => adopted.push({ itemId, payload, revision }),
    onClosed: (info) => closed.push(info),
    onServerNow: (iso) => clocks.push(iso),
    ...options,
  });
  return { save, sent: t.sent, states, adopted, closed, clocks };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Autosave", () => {
  it("debounces 300 ms and sends the latest payload once", async () => {
    const { save, sent } = make();
    save.change("i1", { text: "a" });
    await vi.advanceTimersByTimeAsync(100);
    save.change("i1", { text: "ab" });
    await vi.advanceTimersByTimeAsync(299);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.payload).toEqual({ text: "ab" });
    // The revision counts CHANGES, not requests: both keystrokes moved it.
    expect(sent[0]!.body.revision).toBe(2);
  });

  it("keeps one request in flight per item and sends the latest payload next", async () => {
    const { save, sent } = make();
    save.change("i1", { text: "a" });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(1);

    save.change("i1", { text: "ab" });
    save.change("i1", { text: "abc" });
    await vi.advanceTimersByTimeAsync(300);
    // Still ONE: the second request waits for the first to come back.
    expect(sent).toHaveLength(1);

    sent[0]!.resolve(accepted(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.payload).toEqual({ text: "abc" });
    expect(sent[1]!.body.revision).toBe(3);
  });

  it("never lets an item's revision go back, including across a reload", () => {
    const { save } = make();
    save.seed("i1", 7);
    save.change("i1", { text: "a" });
    expect(save.revisionOf("i1")).toBe(8);
  });

  it("adopts the server's payload when the write was stale", async () => {
    const { save, sent, adopted } = make();
    save.change("i1", { text: "mine" });
    await vi.advanceTimersByTimeAsync(300);
    sent[0]!.resolve({
      revision: 9,
      payload: { text: "theirs" },
      accepted: false,
      serverNow: serverNow(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(adopted).toEqual([{ itemId: "i1", payload: { text: "theirs" }, revision: 9 }]);
    expect(save.revisionOf("i1")).toBe(9);
    expect(save.dirty).toBe(false);
  });

  it("feeds every response's serverNow to the clock", async () => {
    const { save, sent, clocks } = make();
    save.change("i1", 1);
    await vi.advanceTimersByTimeAsync(300);
    sent[0]!.resolve(accepted(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(clocks).toEqual([serverNow()]);
  });

  it("stops every write on a 410 and turns the badge closed", async () => {
    const { save, sent, states, closed } = make();
    save.change("i1", 1);
    await vi.advanceTimersByTimeAsync(300);
    sent[0]!.reject(
      new ApiError(410, {
        error: "attempt_closed",
        reason: "deadline",
        deadlineAt: null,
        serverNow: serverNow(),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toHaveLength(1);
    expect(save.syncState).toBe("closed");
    expect(states.at(-1)).toBe("closed");

    save.change("i1", 2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
  });

  it("buffers on a paused 410 and replays it on resume (D17)", async () => {
    const { save, sent, closed } = make();
    save.change("i1", { text: "kept" });
    await vi.advanceTimersByTimeAsync(300);
    sent[0]!.reject(
      new ApiError(410, {
        error: "attempt_closed",
        reason: "paused",
        deadlineAt: null,
        serverNow: serverNow(),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toHaveLength(1);
    expect(save.syncState).toBe("offline");
    // Nothing goes out while the evaluation is paused.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);

    save.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.payload).toEqual({ text: "kept" });
  });

  it("goes offline after 3 s without an acknowledgement and back on the ack", async () => {
    const { save, sent, states } = make();
    save.change("i1", 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(save.syncState).toBe("saving");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(save.syncState).toBe("offline");

    sent[0]!.resolve(accepted(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(save.syncState).toBe("saved");
    expect(states).toEqual(["saving", "offline", "saved"]);
  });

  it("backs off exponentially and stops at five seconds", async () => {
    const { save, sent } = make();
    save.change("i1", 1);
    await vi.advanceTimersByTimeAsync(300);

    const delays = [500, 1_000, 2_000, 4_000, 5_000, 5_000];
    for (const [attempt, delay] of delays.entries()) {
      expect(sent).toHaveLength(attempt + 1);
      sent[attempt]!.reject(new TypeError("network"));
      await vi.advanceTimersByTimeAsync(0);
      // Nothing one millisecond early…
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sent).toHaveLength(attempt + 1);
      // …and exactly one retry on the tick.
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toHaveLength(attempt + 2);
    }
  });

  it("replays every unacked item on a reconnection, without waiting for the backoff", async () => {
    const { save, sent } = make();
    save.change("i1", 1);
    save.change("i2", 2);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(2);
    sent[0]!.reject(new TypeError("offline"));
    sent[1]!.reject(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);

    save.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(4);
    expect(save.unsaved.sort()).toEqual(["i1", "i2"]);
  });

  /*
   * The StrictMode bug: React mounts, runs the cleanup, and mounts again on
   * the SAME instance. The cleanup's `stop(false)` used to be irreversible,
   * so every later keystroke was a silent no-op and nothing ever reached
   * `PUT /attempts/:id/answers/:itemId`.
   */
  it("sends again after a non-final stop followed by a start", async () => {
    const { save, sent, states } = make();
    save.stop(false);
    expect(states).not.toContain("closed");
    save.start();

    save.change("i1", { text: "a" });
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.payload).toEqual({ text: "a" });
  });

  it("keeps what was typed during a non-final stop and flushes it on start", async () => {
    const { save, sent } = make();
    save.change("i1", { text: "draft" });
    save.stop(false);
    // The debounce was cleared with everything else: nothing leaves.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(0);
    expect(save.unsaved).toEqual(["i1"]);

    save.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.payload).toEqual({ text: "draft" });
  });

  it("a final stop is final: neither start nor change reopens it", async () => {
    const { save, sent, states } = make();
    save.stop();
    expect(states).toEqual(["closed"]);
    save.start();
    save.change("i1", { text: "a" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(0);
    expect(save.syncState).toBe("closed");
  });

  it("holds the unacked payloads until they are acknowledged", async () => {
    const { save, sent } = make();
    save.change("i1", { text: "draft" });
    await vi.advanceTimersByTimeAsync(300);
    expect(save.unsaved).toEqual(["i1"]);
    sent[0]!.resolve(accepted(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(save.unsaved).toEqual([]);
  });
});

describe("settle (issue #89)", () => {
  it("resolves at once when nothing is pending", async () => {
    const { save } = make();
    await expect(save.settle("i1")).resolves.toBe(true);
  });

  it("skips the debounce and resolves once the latest payload is acknowledged", async () => {
    const { save, sent } = make();
    save.change("i1", "x");
    let settled: boolean | null = null;
    void save.settle("i1").then((saved) => {
      settled = saved;
    });
    // Sent without waiting for the 300 ms debounce.
    expect(sent).toHaveLength(1);
    await Promise.resolve();
    expect(settled).toBeNull();
    sent[0]!.resolve(accepted(1));
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it("waits for a change typed while the first request was in flight", async () => {
    const { save, sent } = make();
    save.change("i1", "x");
    vi.advanceTimersByTime(300);
    save.change("i1", "");
    let settled: boolean | null = null;
    void save.settle("i1").then((saved) => {
      settled = saved;
    });
    sent[0]!.resolve(accepted(1));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(settled).toBeNull();
    expect(sent[1]!.body.payload).toBe("");
    sent[1]!.resolve(accepted(2));
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it("never rejects: a failed write answers false, the payload still pending", async () => {
    const { save, sent } = make();
    save.change("i1", "x");
    const settled = save.settle("i1");
    sent[0]!.reject(new ApiError(503, { error: "unavailable" }));
    await expect(settled).resolves.toBe(false);
    expect(save.unsaved).toEqual(["i1"]);
  });

  it("answers false at once while a failed payload waits for its retry (5xx, then validate)", async () => {
    const { save, sent } = make();
    save.change("i1", "x");
    vi.advanceTimersByTime(300);
    sent[0]!.reject(new ApiError(500, { error: "boom" }));
    await vi.waitFor(() => expect(save.unsaved).toEqual(["i1"]));
    // The newest payload is NOT on the server: a validation must not proceed.
    await expect(save.settle("i1")).resolves.toBe(false);
    // Once the retry lands, it is safe again.
    vi.advanceTimersByTime(5_000);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    sent[1]!.resolve(accepted(1));
    await vi.waitFor(() => expect(save.unsaved).toEqual([]));
    await expect(save.settle("i1")).resolves.toBe(true);
  });
});
