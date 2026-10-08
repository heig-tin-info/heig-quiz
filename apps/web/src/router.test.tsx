import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useLeaveGuard, useRoute, useSearchParam } from "./router";

/*
 * `useSearchParam` backs the in-page tabs. The contract it has to keep: a
 * reload lands on the same tab, and Back still leaves the page instead of
 * walking through every tab the reader looked at (hence replaceState).
 *
 * The pure parts of the router (parsePath / routeToPath) stay in
 * router.test.ts, which runs in the node project without a DOM.
 */

const goTo = (url: string) => window.history.replaceState(null, "", url);

describe("useSearchParam", () => {
  it("reads the parameter from the URL", () => {
    goTo("/classrooms/c1?tab=students");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    expect(result.current[0]).toBe("students");
  });

  it("falls back when the parameter is absent", () => {
    goTo("/classrooms/c1");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    expect(result.current[0]).toBe("assignments");
  });

  it("writes the parameter without pushing a history entry", () => {
    goTo("/classrooms/c1");
    const before = window.history.length;
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    act(() => result.current[1]("staff"));
    expect(result.current[0]).toBe("staff");
    expect(window.location.pathname).toBe("/classrooms/c1");
    expect(window.location.search).toBe("?tab=staff");
    // Back must leave the classroom, not undo a tab click.
    expect(window.history.length).toBe(before);
  });

  it("clears the parameter when the value goes back to the fallback", () => {
    goTo("/classrooms/c1?tab=staff");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    act(() => result.current[1]("assignments"));
    expect(result.current[0]).toBe("assignments");
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/classrooms/c1");
  });

  it("follows Back and Forward", () => {
    goTo("/classrooms/c1?tab=students");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    expect(result.current[0]).toBe("students");
    // The browser has already changed the URL by the time popstate fires; the
    // hook used to ignore it and keep showing the previous tab.
    act(() => {
      window.history.replaceState(null, "", "/classrooms/c1?tab=staff");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("staff");
    act(() => {
      window.history.replaceState(null, "", "/classrooms/c1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("assignments");
  });

  it("keeps two instances of the same parameter in sync", () => {
    // The sidebar's category tree and the pool page are two hooks on one
    // screen. `replaceState` fires no `popstate`, so without the event the
    // hook dispatches, the one that did not write stayed on its stale value.
    goTo("/pools/p1");
    const sidebar = renderHook(() => useSearchParam("category", ""));
    const page = renderHook(() => useSearchParam("category", ""));
    act(() => sidebar.result.current[1]("cat-2"));
    expect(sidebar.result.current[0]).toBe("cat-2");
    expect(page.result.current[0]).toBe("cat-2");
    // And back the other way, down to the fallback that clears the parameter.
    act(() => page.result.current[1](""));
    expect(sidebar.result.current[0]).toBe("");
    expect(window.location.search).toBe("");
  });

  it("leaves the other parameters of the URL alone", () => {
    goTo("/classrooms/c1?tab=staff&q=rochat");
    const { result } = renderHook(() => useSearchParam("tab", "assignments"));
    act(() => result.current[1]("students"));
    expect(new URLSearchParams(window.location.search).get("q")).toBe("rochat");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("students");
    act(() => result.current[1]("assignments"));
    expect(new URLSearchParams(window.location.search).get("q")).toBe("rochat");
    expect(new URLSearchParams(window.location.search).has("tab")).toBe(false);
  });
});

/*
 * `navigate` lands on the route's whole address. A page that stays mounted
 * from one classroom to the next must not keep the previous address's tab,
 * and a click on the classroom on view leaves its tab too.
 */
describe("useRoute and the query string", () => {
  const routeAndTab = () =>
    renderHook(() => ({ route: useRoute(), tab: useSearchParam("tab", "evaluations") }));

  it("hands the next page its own query, not the previous one's", () => {
    goTo("/classrooms/c1?tab=roster");
    const { result } = routeAndTab();
    expect(result.current.tab[0]).toBe("roster");
    act(() => {
      void result.current.route[1]({ view: "classroom", id: "c2" });
    });
    expect(window.location.pathname + window.location.search).toBe("/classrooms/c2");
    expect(result.current.tab[0]).toBe("evaluations");
  });

  it("drops the query of the page on view when it is navigated to again", () => {
    goTo("/classrooms/c1?tab=roster");
    const { result } = routeAndTab();
    act(() => {
      void result.current.route[1]({ view: "classroom", id: "c1" });
    });
    expect(window.location.pathname + window.location.search).toBe("/classrooms/c1");
    expect(result.current.tab[0]).toBe("evaluations");
  });

  it("pushes nothing when the address is already the route's", () => {
    goTo("/classrooms/c1");
    const before = window.history.length;
    const { result } = routeAndTab();
    act(() => {
      void result.current.route[1]({ view: "classroom", id: "c1" });
    });
    expect(window.history.length).toBe(before);
  });
});

/*
 * The leave guard (M4-06): a screen holding unsaved work asks before the app
 * navigates away, by `navigate` or by Back, and the browser asks on a reload.
 */
describe("useLeaveGuard", () => {
  const guarded = (dirty: boolean, answer: boolean) => {
    const ask = vi.fn(async () => answer);
    const hooks = renderHook(
      ({ isDirty }) => {
        useLeaveGuard(isDirty, ask);
        return useRoute();
      },
      { initialProps: { isDirty: dirty } },
    );
    return { ask, ...hooks };
  };

  it("lets `navigate` go at once while nothing is at stake", () => {
    goTo("/activities");
    const { result, ask } = guarded(false, false);
    act(() => {
      void result.current[1]({ view: "pools" });
    });
    expect(ask).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/pools");
  });

  it("holds `navigate` until the screen answers, and stays on a no", async () => {
    goTo("/activities");
    const { result, ask } = guarded(true, false);
    let moved: boolean | void = undefined;
    await act(async () => {
      moved = await result.current[1]({ view: "pools" });
    });
    // It says it stayed (the assistant's "Stayed on this screen", ADR-080 P2b).
    expect(moved).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/activities");
    expect(result.current[0].view).not.toBe("pools");
  });

  it("goes on a yes", async () => {
    goTo("/activities");
    const { result } = guarded(true, true);
    let moved: boolean | void = undefined;
    await act(async () => {
      moved = await result.current[1]({ view: "pools" });
    });
    expect(moved).toBe(true);
    expect(window.location.pathname).toBe("/pools");
    expect(result.current[0]).toEqual({ view: "pools" });
  });

  it("puts the page back on Back, and asks", async () => {
    goTo("/activities");
    const { ask } = guarded(true, false);
    window.history.replaceState(null, "", "/pools");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/activities");
  });

  it("asks the browser on a reload, and stops once the work is saved", () => {
    goTo("/activities");
    const { rerender } = guarded(true, false);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    rerender({ isDirty: false });
    const again = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });
});
