import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardKey } from "../evaluation/common";
import { initialGrid } from "../realtime/grid";
import { resetEventStream } from "../realtime/useEventStream";
import { EVALUATION_ID, makeDashboard, makeEvaluationDetail } from "../test/live-fixtures";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { LiveDashboard } from "./LiveDashboard";

/*
 * The full-screen mode of the live dashboard, pinned before FF-06 moves
 * `useFullscreen` into the shared primitives.
 *
 * There are TWO full screens stacked here and the distinction is the whole
 * point: the page-level one (a `fixed inset-0` overlay, which is all a
 * projector really needs) and the browser's own `requestFullscreen`, which
 * is attempted on top and whose refusal is swallowed on purpose. The
 * dashboard's copy of the hook drives the first from React state and fires
 * the second as a side effect — and, unlike `PollProjection`'s copy, it
 * NEVER LISTENS to `fullscreenchange`, which is the defect the last block of
 * this file pins so the fix shows up as a flipped test.
 */

class SilentEventSource {
  onopen = null;
  onerror = null;
  onmessage = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

/*
 * Rebuilt in `beforeEach` rather than declared once: the `dom` project runs
 * with `restoreMocks`, which restores spies but leaves a module-level
 * `vi.fn()` carrying its calls into the next test — and every assertion
 * below is a call COUNT.
 */
let requestFullscreen: ReturnType<typeof vi.fn<() => Promise<void>>>;
let exitFullscreen: ReturnType<typeof vi.fn<() => Promise<void>>>;

function setFullscreenElement(element: Element | null) {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => element,
  });
}

function setup(state: "running" | "closed" = "running") {
  const view = makeDashboard(2, 2);
  view.evaluation.state = state;
  const queryClient = makeQueryClient();
  queryClient.setQueryData(dashboardKey(EVALUATION_ID, true, true), initialGrid(view));
  const stubs = mockFetch({
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(makeEvaluationDetail()),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=1&results=1`]: ok(view),
  });
  const rendered = renderWithProviders(
    <LiveDashboard id={EVALUATION_ID} navigate={vi.fn()} />,
    { queryClient },
  );
  return { ...rendered, ...stubs };
}

/**
 * The page-level overlay, the thing a teacher is actually looking at.
 *
 * By its `data-testid` and not by `div.fixed.inset-0.z-30`: nine of the ten
 * tests below turn on this query, and the overlay's utilities are styling
 * the refactoring is free to change. The marker is the one production line
 * this test-only branch touches.
 */
const overlay = () => screen.queryByTestId("live-fullscreen-stage");
const enterButton = () => screen.getByRole("button", { name: "Full screen" });
const leaveButton = () => screen.getByRole("button", { name: "Leave full screen" });

beforeEach(() => {
  vi.stubGlobal("EventSource", SilentEventSource);
  requestFullscreen = vi.fn(() => Promise.resolve());
  exitFullscreen = vi.fn(() => Promise.resolve());
  // jsdom implements neither call; the component reaches for both through
  // `?.()`, so without these stubs the browser half is simply skipped and
  // there would be nothing to assert about it.
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    writable: true,
    value: requestFullscreen,
  });
  Object.defineProperty(document, "exitFullscreen", {
    configurable: true,
    writable: true,
    value: exitFullscreen,
  });
  setFullscreenElement(null);
});

afterEach(() => {
  resetEventStream();
});

describe("LiveDashboard — entering and leaving full screen", () => {
  it("starts in the page, with the button offering to go full screen", async () => {
    setup();
    await screen.findByText("Nadia Roux 0");
    expect(enterButton()).toHaveAttribute("aria-pressed", "false");
    expect(overlay()).toBeNull();
  });

  it("`F` raises the page overlay and asks the browser for its own full screen", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");

    await user.keyboard("f");
    await waitFor(() => expect(overlay()).not.toBeNull());
    expect(leaveButton()).toHaveAttribute("aria-pressed", "true");
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    // The grid is still the grid; only its container changed.
    expect(screen.getByText("Nadia Roux 0")).toBeVisible();
  });

  it("`F` again drops the overlay and leaves the browser's full screen", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");

    await user.keyboard("f");
    await waitFor(() => expect(overlay()).not.toBeNull());
    // The browser granted it, so `document.fullscreenElement` is set: this is
    // the only condition under which the component calls `exitFullscreen`.
    setFullscreenElement(document.documentElement);

    await user.keyboard("f");
    await waitFor(() => expect(overlay()).toBeNull());
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(enterButton()).toHaveAttribute("aria-pressed", "false");
  });

  it("the header button does exactly what `F` does", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");

    await user.click(enterButton());
    await waitFor(() => expect(overlay()).not.toBeNull());
    await user.click(leaveButton());
    await waitFor(() => expect(overlay()).toBeNull());
  });

  it("does not ask the browser to leave a full screen it never granted", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");
    await user.keyboard("f");
    await waitFor(() => expect(overlay()).not.toBeNull());
    // `fullscreenElement` stays null — a permissions policy refused it.
    await user.keyboard("f");
    await waitFor(() => expect(overlay()).toBeNull());
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("keeps the page overlay when the browser refuses its own full screen", async () => {
    const user = userEvent.setup();
    requestFullscreen.mockRejectedValueOnce(new Error("disallowed by permissions policy"));
    setup();
    await screen.findByText("Nadia Roux 0");

    await user.keyboard("f");
    // The rejection is swallowed on purpose: a projector still gets the
    // page-level version.
    await waitFor(() => expect(overlay()).not.toBeNull());
  });

  it("is available whatever the evaluation is doing", async () => {
    const user = userEvent.setup();
    setup("closed");
    await screen.findByText("Nadia Roux 0");
    // Unlike Space, `f` is not gated on the quiz being live: a closed
    // evaluation is still something a teacher projects.
    await user.keyboard("f");
    await waitFor(() => expect(overlay()).not.toBeNull());
  });

  it("does not fire from a field", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("f");
    expect(overlay()).toBeNull();
    expect(input).toHaveValue("f");
    input.remove();
  });
});

describe("LiveDashboard — the browser leaving full screen on its own", () => {
  /*
   * DEFECT (FF-06), pinned as it stands TODAY so the fix flips this test.
   *
   * `PollProjection` listens for `fullscreenchange` and follows it;
   * `LiveDashboard`'s copy of the same hook does not. So when the browser
   * leaves full screen without going through the component — Escape, F11,
   * a tab switch, the operating system — React's `fullscreen` stays true and
   * the teacher is left inside the `fixed inset-0` overlay with a header
   * button that now says "Leave full screen" while the browser has already
   * left it.
   *
   * When the listener is added (the shared `useFullscreen` of FF-06), these
   * two expectations become `toBeNull()` and "Full screen", and the test is
   * renamed "follows the browser out of full screen".
   */
  it("today: does NOT follow the browser out — the overlay stays up after `fullscreenchange`", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");

    await user.keyboard("f");
    await waitFor(() => expect(overlay()).not.toBeNull());

    // Exactly what Escape produces in a real browser: the element is gone
    // and the event is dispatched on the document.
    setFullscreenElement(null);
    document.dispatchEvent(new Event("fullscreenchange"));

    await waitFor(() => expect(overlay()).not.toBeNull());
    expect(leaveButton()).toHaveAttribute("aria-pressed", "true");
  });

  it("today: `F` after such an exit toggles the overlay off rather than back on", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Nadia Roux 0");

    await user.keyboard("f");
    await waitFor(() => expect(overlay()).not.toBeNull());
    setFullscreenElement(null);
    document.dispatchEvent(new Event("fullscreenchange"));

    // The state and the browser disagree, so the next `f` undoes the state
    // instead of restoring the browser's full screen: the teacher presses it
    // expecting to come back and lands in the page. That inversion is the
    // user-visible cost of the missing listener.
    await user.keyboard("f");
    await waitFor(() => expect(overlay()).toBeNull());
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });
});
