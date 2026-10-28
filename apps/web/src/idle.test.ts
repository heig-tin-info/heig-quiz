// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh module per test: `lastInteraction` is module state, set at load. */
async function load() {
  vi.resetModules();
  return import("./idle");
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("isIdle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T23:00:00Z"));
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the page load, then turns idle after IDLE_AFTER_MS without a gesture", async () => {
    const { isIdle, IDLE_AFTER_MS } = await load();
    expect(isIdle()).toBe(false);
    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(isIdle()).toBe(true);
  });

  it("is idle while the page is hidden, whatever the last gesture", async () => {
    const { isIdle } = await load();
    setVisibility("hidden");
    expect(isIdle()).toBe(true);
  });

  it("stays idle when the page becomes visible again without a gesture (a device waking)", async () => {
    const { isIdle, IDLE_AFTER_MS } = await load();
    isIdle();
    setVisibility("hidden");
    vi.advanceTimersByTime(IDLE_AFTER_MS * 6);
    setVisibility("visible");
    expect(isIdle()).toBe(true);
  });

  it("is not reset by a scroll event, which a re-render can fire", async () => {
    const { isIdle, IDLE_AFTER_MS } = await load();
    isIdle();
    vi.advanceTimersByTime(IDLE_AFTER_MS);
    document.body.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    expect(isIdle()).toBe(true);
  });

  it.each(["keydown", "pointerdown", "wheel", "touchstart"])("is reset by a %s", async (type) => {
    const { isIdle, IDLE_AFTER_MS } = await load();
    isIdle();
    vi.advanceTimersByTime(IDLE_AFTER_MS);
    expect(isIdle()).toBe(true);
    document.body.dispatchEvent(new Event(type, { bubbles: true }));
    expect(isIdle()).toBe(false);
  });
});
