import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockFetch, noContent, renderWithProviders } from "../test/render";
import { NOTICE_INTERVAL_MS, useIntegrityJournal } from "./integrity";
import { useJournal } from "./signals";

/*
 * F-EVAL-13, the focus half of the integrity journal: what leaves the
 * browser as the student leaves the page and comes back, and when they are
 * told so. The server times every entry; the client only decides the toast.
 * Which attempts journal and notify is the player's (`Player.test.tsx`).
 */

interface Flags {
  journaled: boolean;
  notify: boolean;
}

const NOTICE = "You left the evaluation page. This event is recorded and visible to your teacher.";

let seq = 0;

function Probe({ attemptId, flags }: { attemptId: string; flags: Flags }) {
  const report = useJournal(attemptId, false);
  useIntegrityJournal(attemptId, report, flags);
  return null;
}

function setup(flags: Partial<Flags> = {}) {
  // A fresh attempt per test: the toast's rate limit is kept per attempt.
  const attemptId = `a${++seq}`;
  const { calls } = mockFetch({ [`POST /app/api/attempts/${attemptId}/events`]: noContent() });
  renderWithProviders(<Probe attemptId={attemptId} flags={{ journaled: true, notify: true, ...flags }} />);
  const sent = () => calls.filter((c) => c.url.endsWith("/events")).map((c) => c.body);
  return { sent };
}

let visibility: DocumentVisibilityState = "visible";

const blur = () =>
  act(() => {
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(0);
  });
const focus = () => act(() => void window.dispatchEvent(new Event("focus")));
const setVisibility = (state: DocumentVisibilityState) =>
  act(() => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
  });
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
// Standing toasts: one that timed out plays its exit (jsdom never ends it).
const toasts = () => screen.queryAllByText(NOTICE).filter((el) => !el.closest(".toast-leave"));

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the integrity journal, focus", () => {
  it("journals a blur and the return at once, and tells the student after a second away", () => {
    const { sent } = setup();
    blur();
    expect(sent()).toEqual([{ kind: "focus", details: { focused: false } }]);
    wait(1_500);
    focus();
    expect(sent()).toEqual([
      { kind: "focus", details: { focused: false } },
      { kind: "focus", details: { focused: true } },
    ]);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.closest("[role=status]")).not.toBeNull();
  });

  it("journals a hidden tab as visibility, and tells the student as it shows again", () => {
    const { sent } = setup();
    setVisibility("hidden");
    wait(2_000);
    setVisibility("visible");
    expect(sent()).toEqual([
      { kind: "visibility", details: { state: "hidden" } },
      { kind: "visibility", details: { state: "visible" } },
    ]);
    expect(toasts()).toHaveLength(1);
  });

  it("ignores a blur that moved the focus into an iframe of the page", () => {
    const { sent } = setup();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
    blur();
    wait(3_000);
    focus();
    expect(sent()).toEqual([]);
    expect(toasts()).toHaveLength(0);
  });

  it("journals an absence under a second, but does not toast it", () => {
    const { sent } = setup();
    blur();
    wait(400);
    focus();
    expect(sent()).toHaveLength(2);
    expect(toasts()).toHaveLength(0);
  });

  it("toasts at most once in five minutes", () => {
    setup();
    blur();
    wait(1_000);
    focus();
    expect(toasts()).toHaveLength(1);
    wait(10_000); // the toast is gone by itself
    blur();
    wait(5_000);
    focus();
    expect(toasts()).toHaveLength(0);
    wait(NOTICE_INTERVAL_MS);
    blur();
    wait(1_000);
    focus();
    expect(toasts()).toHaveLength(1);
  });

  /** Leaves by a blur, then hides, comes back after five seconds. */
  const leaveLong = () => {
    blur();
    setVisibility("hidden");
    wait(5_000);
    setVisibility("visible");
    focus();
  };

  it("posts nothing and toasts nothing when not journaled", () => {
    const { sent } = setup({ journaled: false, notify: false });
    leaveLong();
    expect(sent()).toEqual([]);
    expect(toasts()).toHaveLength(0);
  });

  it("still journals a confined session (seb, kiosk)", () => {
    const { sent } = setup({ notify: false });
    leaveLong();
    expect(sent()).toEqual([
      { kind: "focus", details: { focused: false } },
      { kind: "visibility", details: { state: "hidden" } },
      { kind: "visibility", details: { state: "visible" } },
      { kind: "focus", details: { focused: true } },
    ]);
  });

  it("shows a confined session no toast", () => {
    setup({ notify: false });
    leaveLong();
    expect(toasts()).toHaveLength(0);
  });
});
