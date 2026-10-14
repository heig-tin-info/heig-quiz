import { describe, expect, it } from "vitest";

import { BuildMonitor } from "./build";

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
