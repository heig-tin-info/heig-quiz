import { act, renderHook, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CrashBoundary } from "./CrashBoundary";
import { lazyPage } from "./lazyPage";
import { build } from "./realtime/build";
import { useLeaveGuard, useRoute } from "./router";
import { renderWithProviders } from "./test/render";

/*
 * ADR-110, as the router and the page loader apply it to a stale tab: the
 * next screen comes from the new build, except from an attempt, in a
 * confined session, or past a screen's leave guard. This file's tabs are all
 * stale (the monitor is a module singleton).
 */
build.markStale();
const goTo = (url: string) => window.history.replaceState(null, "", url);
let load: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  build.confine(false);
  sessionStorage.clear();
  load = vi.spyOn(build, "load").mockImplementation(() => {});
});

describe("a stale tab's next screen", () => {
  it("is a full load of its address", async () => {
    goTo("/classrooms/c1");
    const { result } = renderHook(() => useRoute());
    await act(async () => {
      await result.current[1]({ view: "settings" });
    });
    expect(load).toHaveBeenCalledWith("/settings", undefined);
    expect(window.location.pathname).toBe("/classrooms/c1");
  });

  it("stays in the app from an attempt, and in a confined session", async () => {
    goTo("/take/e1");
    const attempt = renderHook(() => useRoute());
    await act(async () => {
      await attempt.result.current[1]({ view: "feedback", attemptId: "a1" });
    });
    expect(window.location.pathname).toBe("/attempts/a1/feedback");
    build.confine(true);
    goTo("/classrooms/c1");
    const seb = renderHook(() => useRoute());
    await act(async () => {
      await seb.result.current[1]({ view: "settings" });
    });
    expect(window.location.pathname).toBe("/settings");
    expect(load).not.toHaveBeenCalled();
  });

  it("asks the leave guard first, and then stays in the app", async () => {
    goTo("/classrooms/c1");
    const ask = vi.fn().mockResolvedValue(true);
    renderHook(() => useLeaveGuard(true, ask));
    const { result } = renderHook(() => useRoute());
    await act(async () => {
      await result.current[1]({ view: "settings" });
    });
    expect(ask).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/settings");
  });

  it("takes Back as a full load of where it lands", () => {
    goTo("/classrooms/c1");
    renderHook(() => useRoute());
    act(() => {
      goTo("/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(load).toHaveBeenCalledWith("/settings", true);
  });
});

describe("a page whose chunk is gone", () => {
  const brokenPage = () =>
    lazyPage<() => null>(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
  const show = (route: string) => {
    const Page = brokenPage();
    return renderWithProviders(
      <CrashBoundary>
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      </CrashBoundary>,
      { route },
    );
  };

  it("reloads its address once, then falls back to the crash screen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = show("/classrooms/c1");
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith(window.location.href, true));
    first.unmount();
    show("/classrooms/c1");
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(load).toHaveBeenCalledOnce();
  });

  it("leaves the reload to the student during an attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    show("/take/e1");
    expect(await screen.findByText("Quiz has been updated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });
});
