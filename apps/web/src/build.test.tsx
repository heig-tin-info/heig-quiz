import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuildMonitor } from "./build";
import type { ConnectionState } from "./realtime/connection";
import { createSignal } from "./ui/state";

// ADR-110: what makes a tab stale, and what keeps it from loading the new build.
describe("the build monitor", () => {
  it("goes stale on another server build only", () => {
    const build = new BuildMonitor("aaa");
    build.observe(null);
    build.observe("aaa");
    expect(build.isStale()).toBe(false);
    build.observe("bbb");
    expect(build.isStale()).toBe(true);
  });

  it("stays inert in a build that knows no commit", () => {
    const build = new BuildMonitor(null);
    build.observe("bbb");
    expect(build.isStale()).toBe(false);
  });

  it("lets a stale tab load the new build only when nothing would be lost", () => {
    const build = new BuildMonitor("aaa");
    expect(build.mayLoad(false)).toBe(false);
    build.observe("bbb");
    expect(build.mayLoad(false)).toBe(true);
    expect(build.mayLoad(true)).toBe(false);
    const release = build.hold();
    expect(build.mayLoad(false)).toBe(false);
    release();
    build.confine(true);
    expect(build.mayLoad(false)).toBe(false);
    build.confine(false);
    expect(build.mayLoad(false)).toBe(true);
  });

  it("settles once the last hold is released, each release counting once", async () => {
    const build = new BuildMonitor("aaa");
    const first = build.hold();
    const second = build.hold();
    let settled = false;
    void build.settled().then(() => (settled = true));
    first();
    first();
    // The same signal tells of a stale tab: still held.
    build.markStale();
    await Promise.resolve();
    expect(settled).toBe(false);
    second();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("takes a failed chunk as a stale build, and leaves the import to reject", () => {
    const build = new BuildMonitor("aaa");
    const stop = build.start();
    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);
    stop();
    expect(build.isStale()).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });
});

// ADR-110: the reload a clean, stale tab makes by itself.
describe("the spontaneous reload", () => {
  let visibility: DocumentVisibilityState = "visible";
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
  });

  /** A connection the test drives, as the overlay's monitor would publish it. */
  function fakeConnection() {
    let state: ConnectionState = "connected";
    const signal = createSignal();
    return {
      getSnapshot: () => state,
      subscribe: signal.subscribe,
      set(next: ConnectionState) {
        state = next;
        signal.emit();
      },
    };
  }
  function watched(answering = false) {
    const build = new BuildMonitor("aaa");
    const load = vi.spyOn(build, "load").mockImplementation(() => {});
    const connection = fakeConnection();
    stops.push(build.watch(() => answering, connection));
    return { build, load, connection };
  }
  const hide = () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(1_000);
  };

  it("reloads a hidden tab, once per server build", () => {
    const { build, load } = watched();
    build.observe("bbb");
    expect(load).not.toHaveBeenCalled();
    hide();
    expect(load).toHaveBeenCalledExactlyOnceWith(window.location.href, true);
    // The same build again (the reload came back stale): no loop.
    const again = watched();
    again.build.observe("bbb");
    hide();
    expect(again.load).not.toHaveBeenCalled();
  });

  it("reloads within 30 s of the update overlay closing, not later", () => {
    const first = watched();
    first.connection.set("updating");
    first.connection.set("connected");
    first.build.observe("bbb");
    expect(first.load).toHaveBeenCalledOnce();

    const late = watched();
    late.connection.set("updating");
    late.connection.set("connected");
    vi.advanceTimersByTime(31_000);
    late.build.observe("ccc");
    expect(late.load).not.toHaveBeenCalled();
  });

  it("after an update, waits for a visible tab's field to lose focus", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const { build, load, connection } = watched();
    connection.set("updating");
    connection.set("connected");
    build.observe("bbb");
    expect(load).not.toHaveBeenCalled();
    field.blur();
    vi.advanceTimersByTime(0);
    expect(load).toHaveBeenCalledOnce();
    field.remove();
  });

  it("never reloads an answering page, a confined session, or held work", () => {
    const answering = watched(true);
    answering.build.observe("bbb");
    hide();
    expect(answering.load).not.toHaveBeenCalled();

    const confined = watched();
    confined.build.confine(true);
    confined.build.observe("bbb");
    hide();
    expect(confined.load).not.toHaveBeenCalled();

    const held = watched();
    const release = held.build.hold();
    held.build.observe("bbb");
    hide();
    expect(held.load).not.toHaveBeenCalled();
    // The work saved, the hidden tab takes the new build.
    release();
    expect(held.load).toHaveBeenCalledOnce();
  });

  it("puts the scroll of a reloaded address back once, after the page grew", () => {
    const build = new BuildMonitor("aaa");
    // An address with a fragment: jsdom moves to it without a navigation of the document.
    window.history.replaceState(null, "", "/pools/p1#q");
    Object.defineProperty(window, "scrollY", { configurable: true, value: 640 });
    build.load(window.location.href, true);

    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    let height = 0;
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(() => height);
    build.restoreScroll();
    vi.advanceTimersByTime(300);
    expect(scrollTo).not.toHaveBeenCalled();
    height = 5_000;
    vi.advanceTimersByTime(100);
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 640);
    // Used once.
    build.restoreScroll();
    vi.advanceTimersByTime(6_000);
    expect(scrollTo).toHaveBeenCalledOnce();
  });
});
