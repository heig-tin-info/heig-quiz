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
