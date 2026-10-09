import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@quiz/contracts";

import { meKey } from "../queryKeys";
import { PlayerTools } from "../student/PlayerTools";
import { makeMe } from "../test/fixtures";
import { makeQueryClient, mockFetch, noContent, renderWithProviders } from "../test/render";
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

/*
 * The paste half (ADR-088 §4): a paste or a drop of a passage that was not
 * copied on the page is journaled as its length, never its text. jsdom has
 * no ClipboardEvent nor DataTransfer: a plain event carries a stand-in.
 */
const PASTE_NOTICE =
  "You probably pasted content from outside the platform. This event is recorded and visible to your teacher.";
const pasteToasts = () => screen.queryAllByText(PASTE_NOTICE).filter((el) => !el.closest(".toast-leave"));

/** A clipboard (or drag) stand-in: what a handler sets, `getData` reads. */
function transfer(text = "") {
  let data = text;
  return {
    getData: (type: string) => (type === "text/plain" ? data : ""),
    setData: (_type: string, value: string) => void (data = value),
  };
}

/** Dispatches `type` on `target`, its text in `clipboardData` (or `dataTransfer` for a drag). */
function fire(target: EventTarget, type: string, text = "") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const key = type === "drop" || type === "dragstart" ? "dataTransfer" : "clipboardData";
  Object.defineProperty(event, key, { value: transfer(text) });
  act(() => void target.dispatchEvent(event));
  return event;
}

/** A focused textarea holding `value`, all of it selected. */
function field(value: string) {
  const area = document.createElement("textarea");
  area.value = value;
  document.body.append(area);
  area.focus();
  area.setSelectionRange(0, value.length);
  return area;
}

describe("the integrity journal, paste", () => {
  const OUTSIDE = "A passage written somewhere else entirely.";

  it("journals an outside paste by its length, tells the student, and never prevents it", () => {
    const { sent } = setup();
    const event = fire(field(""), "paste", OUTSIDE);
    expect(sent()).toEqual([{ kind: "paste", details: { length: OUTSIDE.length } }]);
    expect(JSON.stringify(sent())).not.toContain("somewhere");
    expect(pasteToasts()).toHaveLength(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a passage copied on the page, whitespace aside", () => {
    const { sent } = setup();
    const copied = "int main(void) {\n    return 0;\n}  // copied on the page";
    const area = field(copied);
    fire(area, "copy");
    fire(area, "paste", copied.replace(/\n\s*/g, " "));
    // Cut too, and part of a copy.
    const other = field("Another sentence of the statement, long enough.");
    fire(other, "cut");
    fire(other, "paste", "sentence of the statement, long");
    expect(sent()).toEqual([]);
    expect(pasteToasts()).toHaveLength(0);
  });

  it("ignores what an editor of the page put on the clipboard itself", () => {
    const { sent } = setup();
    const editor = document.createElement("div");
    document.body.append(editor);
    const line = "the whole line an editor copies with nothing selected";
    editor.addEventListener("copy", (e) => {
      (e as ClipboardEvent).clipboardData!.setData("text/plain", line);
      e.preventDefault();
    });
    fire(editor, "copy");
    fire(field(""), "paste", line);
    expect(sent()).toEqual([]);
  });

  it("ignores a short paste", () => {
    const { sent } = setup();
    fire(field(""), "paste", "  nineteen   chars!  ");
    expect(sent()).toEqual([]);
  });

  it("journals a drop of outside text, not a drag inside the page", () => {
    const { sent } = setup();
    const area = field("");
    const inside = "a sentence dragged from the statement below";
    fire(area, "dragstart", inside);
    fire(area, "drop", inside);
    expect(sent()).toEqual([]);
    fire(area, "drop", OUTSIDE);
    expect(sent()).toEqual([{ kind: "paste", details: { length: OUTSIDE.length } }]);
  });

  it("posts nothing when not journaled", () => {
    const { sent } = setup({ journaled: false, notify: false });
    fire(field(""), "paste", OUTSIDE);
    expect(sent()).toEqual([]);
    expect(pasteToasts()).toHaveLength(0);
  });

  it("journals a confined session's paste without a toast", () => {
    const { sent } = setup({ notify: false });
    fire(field(""), "paste", OUTSIDE);
    expect(sent()).toHaveLength(1);
    expect(pasteToasts()).toHaveLength(0);
  });

  // ADR-090 §6: the notepad is part of the page for this check.
  it("ignores a passage copied from the notepad into an answer, and journals an outside paste into the notepad", () => {
    const attemptId = `a${++seq}`;
    const { calls } = mockFetch({ [`POST /app/api/attempts/${attemptId}/events`]: noContent() });
    const queryClient = makeQueryClient();
    queryClient.setQueryData(meKey, makeMe({ role: "student", session: { kind: "portal" } as Me["session"] }));
    renderWithProviders(
      <>
        <Probe attemptId={attemptId} flags={{ journaled: true, notify: true }} />
        <PlayerTools
          calculator="none"
          notepad="provided"
          attemptId={attemptId}
          preview={false}
          navigation="free"
          items={[]}
        />
      </>,
      { queryClient },
    );
    const sent = () => calls.filter((c) => c.url.endsWith("/events")).map((c) => c.body);
    const notes = screen.getByRole("textbox", { name: "Page 1 of 1", hidden: true }) as HTMLTextAreaElement;
    const scratch = "v = d / t = 120 / 4 = 30 m/s, keep for later";
    fireEvent.change(notes, { target: { value: scratch } });
    notes.focus();
    notes.setSelectionRange(0, scratch.length);
    fire(notes, "copy", scratch);
    fire(field(""), "paste", scratch);
    expect(sent()).toEqual([]);
    fire(notes, "paste", OUTSIDE);
    expect(sent()).toEqual([{ kind: "paste", details: { length: OUTSIDE.length } }]);
  });
});
