import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { CoachLayer, visibleBottom } from "./CoachLayer";

/*
 * The layer over a real target. jsdom lays nothing out, so every element
 * reports a zero box and the layer would take them all for hidden: the
 * `data-coach` ones get a box of their own.
 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const box = this.hasAttribute("data-coach") ? { width: 120, height: 32 } : { width: 0, height: 0 };
    return { x: 400, y: 80, left: 400, top: 80, right: 400 + box.width, bottom: 80 + box.height, ...box, toJSON: () => ({}) };
  });
});
afterEach(() => vi.restoreAllMocks());

function Pool() {
  return (
    <button type="button" data-coach="pool.new-question">
      New question
    </button>
  );
}

const slow = { timeout: 3000 };

describe("CoachLayer", () => {
  it("plays the screen's tour and reports what was read", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({ "POST /app/api/me/coach": ok({ seen: ["pool.new-question"] }) });
    renderWithProviders(
      <>
        <Pool />
        <CoachLayer me={makeMe({ coach: { enabled: null, seen: [] } })} view="pool" teacherUi />
      </>,
    );

    expect(await screen.findByText("Write a question", undefined, slow)).toBeInTheDocument();
    // The search field of the pool is not on this page (yet): "Next" finds
    // nothing more to point at and ends the walk.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post?.body).toEqual({ seen: ["pool.new-question"] });
    }, slow);
  });

  it("never shows a bubble already read", async () => {
    mockFetch({});
    renderWithProviders(
      <>
        <Pool />
        <CoachLayer
          me={makeMe({ coach: { enabled: null, seen: ["pool.new-question", "pool.search"] } })}
          view="pool"
          teacherUi
        />
      </>,
    );
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays silent when turned off", async () => {
    mockFetch({});
    renderWithProviders(
      <>
        <Pool />
        <CoachLayer me={makeMe({ coach: { enabled: false, seen: [] } })} view="pool" teacherUi />
      </>,
    );
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    expect(screen.queryByText("Write a question")).toBeNull();
  });

  it("waits for a dialog to close before it starts", async () => {
    mockFetch({});
    const { rerender } = renderWithProviders(
      <>
        <Pool />
        <div role="dialog" aria-modal="true" />
        <CoachLayer me={makeMe({ coach: { enabled: null, seen: [] } })} view="pool" teacherUi />
      </>,
    );
    await act(() => new Promise((r) => setTimeout(r, 1500)));
    expect(screen.queryByText("Write a question")).toBeNull();

    rerender(
      <>
        <Pool />
        <CoachLayer me={makeMe({ coach: { enabled: null, seen: [] } })} view="pool" teacherUi />
      </>,
    );
    expect(await screen.findByText("Write a question", undefined, slow)).toBeInTheDocument();
  });
});

describe("visibleBottom (#191)", () => {
  const dock = (top: number, height: number) => {
    const el = document.createElement("nav");
    el.setAttribute("data-bottom-dock", "");
    el.getBoundingClientRect = () =>
      ({ top, height, bottom: top + height, left: 0, right: 390, width: 390, x: 0, y: top }) as DOMRect;
    document.body.append(el);
    return el;
  };
  afterEach(() => document.querySelectorAll("[data-bottom-dock]").forEach((el) => el.remove()));

  it("is the window's bottom without a dock", () => {
    expect(visibleBottom()).toBe(window.innerHeight);
  });

  it("stops at the top of a bar docked on the window's bottom edge", () => {
    dock(window.innerHeight - 56, 56);
    expect(visibleBottom()).toBe(window.innerHeight - 56);
  });

  it("leaves the whole window to a target inside the dock itself", () => {
    const slot = dock(window.innerHeight - 56, 56).appendChild(document.createElement("a"));
    expect(visibleBottom(slot)).toBe(window.innerHeight);
  });

  it("ignores a dock in the flow away from the edge, and one not drawn", () => {
    dock(200, 56);
    dock(window.innerHeight, 0);
    expect(visibleBottom()).toBe(window.innerHeight);
  });
});
