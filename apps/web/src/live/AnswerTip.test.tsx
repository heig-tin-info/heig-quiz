import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttemptInspect, DashboardView, ServerEvent } from "@quiz/contracts";

import { initialGrid } from "../realtime/grid";
import { resetEventStream } from "../realtime/useEventStream";
import { EVALUATION_ID, id, makeDashboard, makeEvaluationDetail } from "../test/live-fixtures";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { attemptInspectKey, dashboardKey } from "../queryKeys";
import { ANSWER_TIP_DELAY } from "./AnswerTip";
import { LiveDashboard } from "./LiveDashboard";
import { LIVE_TOGGLES_KEY } from "./toggles";

/*
 * The tooltip of a grid cell (#94): the complete answer, fetched on demand
 * through the inspection endpoint, only while the answers are shown, and
 * never older than the cell it hangs from.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  readyState = 1;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  removeEventListener() {}
  close() {}
  send(event: ServerEvent) {
    const frame = new MessageEvent(event.type, { data: JSON.stringify(event) });
    for (const fn of this.listeners.get(event.type) ?? []) fn(frame);
  }
}

const ATTEMPT = id("attempt", 1);
const INSPECT_URL = `GET /app/api/evaluations/${EVALUATION_ID}/attempts/${ATTEMPT}`;

/** Row 1 has answered question 2 (a short answer), summarised as the server would. */
function dashboard(): DashboardView {
  const view = makeDashboard(3, 4);
  const cell = view.rows[1]!.cells[1]!;
  Object.assign(cell, { status: "in_progress", revision: 1, summary: "The pointer…" });
  return view;
}

function paper(text: string, revision = 1): AttemptInspect & { serverNow: string } {
  const view = makeDashboard(3, 4);
  return {
    attempt: {
      id: ATTEMPT,
      userId: id("user", 1),
      displayName: "Nadia Roux 1",
      pseudonym: "Amber Lynx",
      state: "in_progress",
      startedAt: null,
      deadlineAt: null,
      submittedAt: null,
    },
    items: view.items.map((item, i) => ({
      item: { id: item.id, position: item.position, points: 1, type: item.type, internalName: "q" },
      // Each type's own student view: the modal renders every item through
      // its type's Review.
      studentConfig:
        item.type === "mcq"
          ? { prompt: "?", mode: "single", choices: [{ id: 0, text: "yes" }] }
          : { prompt: "?", kind: "text", constraints: {} },
      answer: i === 1 ? { text } : null,
      revision: i === 1 ? revision : 0,
      markedDone: false,
      skipped: false,
      flagged: false,
      solution: null,
    })),
    events: [],
    serverNow: new Date().toISOString(),
  };
}

/** What the server holds for question 2 of row 1, read at every request. */
interface Held {
  text: string;
  revision: number;
}

function setup(answer: () => string | Held) {
  const view = dashboard();
  const queryClient = makeQueryClient();
  queryClient.setQueryData(dashboardKey(EVALUATION_ID, true, true), initialGrid(view));
  const stubs = mockFetch({
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(makeEvaluationDetail()),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=0&results=1`]: ok(view),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=1&results=1`]: ok(view),
    [INSPECT_URL]: () => {
      const held = answer();
      return ok(typeof held === "string" ? paper(held) : paper(held.text, held.revision));
    },
  });
  renderWithProviders(<LiveDashboard id={EVALUATION_ID} navigate={vi.fn()} />, { queryClient });
  return { ...stubs, queryClient };
}

/** One `dashboard.cell` frame for row 1, the way the server sends it. */
function cellFrame(itemIndex: number, revision: number, summary: string) {
  act(() => {
    FakeEventSource.instances.at(-1)!.send({
      type: "dashboard.cell",
      flagged: false,
      evaluationId: EVALUATION_ID,
      attemptId: ATTEMPT,
      itemId: id("item", itemIndex),
      status: "in_progress",
      revision,
      points: null,
      summary,
      verdict: null,
    });
  });
}

const cellButton = () =>
  screen.findByRole("button", { name: /Nadia Roux 1 · Question 2$/ }, { timeout: 10_000 });
const inspectCalls = (calls: { url: string }[]) =>
  calls.filter((c) => c.url.endsWith(`/attempts/${ATTEMPT}`)).length;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  resetEventStream();
  vi.useRealTimers();
});

describe("AnswerTip (#94)", () => {
  it("shows the complete answer after a short hover, and describes the cell with it", async () => {
    const full = "The pointer p holds the address of x, so *p reads 42.";
    const { calls } = setup(() => full);
    const cell = await cellButton();

    fireEvent.mouseEnter(cell.parentElement!);
    // Nothing asked while the pointer is merely passing.
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(inspectCalls(calls)).toBe(0);

    const tip = await screen.findByRole("tooltip", {}, { timeout: ANSWER_TIP_DELAY + 1000 });
    expect(await screen.findByText(full)).toBeInTheDocument();
    expect(cell).toHaveAttribute("aria-describedby", tip.id);
    expect(inspectCalls(calls)).toBe(1);

    fireEvent.mouseLeave(cell.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(cell).not.toHaveAttribute("aria-describedby");
  });

  it("opens on keyboard focus and closes with Escape", async () => {
    const user = userEvent.setup();
    setup(() => "42");
    const cell = await cellButton();
    act(() => cell.focus());
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(cell).toHaveFocus();
  });

  it("offers nothing, and fetches nothing, while the answers are hidden", async () => {
    localStorage.setItem(LIVE_TOGGLES_KEY, JSON.stringify({ names: true, answers: false, results: true }));
    const { calls } = setup(() => "secret");
    const cell = await cellButton();
    act(() => cell.focus());
    fireEvent.mouseEnter(cell.parentElement!);
    await new Promise((r) => setTimeout(r, ANSWER_TIP_DELAY + 100));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(inspectCalls(calls)).toBe(0);
  });

  it("offers nothing on a cell without an answer", async () => {
    const { calls } = setup(() => "unused");
    const empty = await screen.findByRole("button", { name: /Nadia Roux 1 · Question 1$/ });
    act(() => empty.focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(inspectCalls(calls)).toBe(0);
  });

  it("re-reads the answer when the student writes while it is open", async () => {
    let held: Held = { text: "first draft", revision: 1 };
    const { calls } = setup(() => held);
    const cell = await cellButton();
    act(() => cell.focus());
    expect(await screen.findByText("first draft")).toBeInTheDocument();

    held = { text: "second draft", revision: 2 };
    cellFrame(1, 2, "second…");
    expect(await screen.findByText("second draft")).toBeInTheDocument();
    await waitFor(() => expect(inspectCalls(calls)).toBe(2));
  });

  it("never shows a cached answer older than its cell, on the next hover either", async () => {
    const user = userEvent.setup();
    let held: Held = { text: "first draft", revision: 1 };
    const { fetchMock } = setup(() => held);
    const cell = await cellButton();
    act(() => cell.focus());
    expect(await screen.findByText("first draft")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // The student writes; the frame only MARKS the paper stale.
    held = { text: "second draft", revision: 2 };
    cellFrame(1, 2, "second…");
    // Hold the next read of the paper, to look at the tooltip meanwhile.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async (...args: Parameters<typeof fetch>) => {
      await gate;
      return real(...args);
    });

    act(() => cell.blur());
    act(() => cell.focus());
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(/reading the answer/i);
    expect(tip).not.toHaveTextContent("first draft");
    release();
    expect(await screen.findByText("second draft")).toBeInTheDocument();
  });

  it("keeps the keyboard focus on a cell when its first answer arrives", async () => {
    setup(() => "unused");
    const empty = await screen.findByRole("button", { name: /Nadia Roux 1 · Question 1$/ });
    act(() => empty.focus());
    cellFrame(0, 1, "B");
    await waitFor(() => expect(empty).toHaveTextContent("B"));
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveFocus();
  });

  it("marks the cached paper stale when the attempt is closed, without re-reading it", async () => {
    const { calls, queryClient } = setup(() => "42");
    const cell = await cellButton();
    act(() => cell.focus());
    expect(await screen.findByText("42")).toBeInTheDocument();
    act(() => {
      FakeEventSource.instances.at(-1)!.send({
        type: "attempt.closed",
        attemptId: ATTEMPT,
        evaluationId: EVALUATION_ID,
        closedBy: "teacher",
        serverNow: new Date().toISOString(),
      });
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(attemptInspectKey(EVALUATION_ID, ATTEMPT))?.isInvalidated,
      ).toBe(true),
    );
    expect(inspectCalls(calls)).toBe(1);
  });

  it("still opens the student's paper on a click, sharing the cached query", async () => {
    const user = userEvent.setup();
    const { calls } = setup(() => "42");
    const cell = await cellButton();
    act(() => cell.focus());
    expect(await screen.findByText("42")).toBeInTheDocument();
    await user.click(cell);
    // Generous timeouts: the modal is the heaviest render of the file, and
    // under a full parallel run the default second is about the machine.
    expect(
      await screen.findByRole("dialog", { name: /answers of nadia roux 1/i }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).toBeNull();
    // The modal read the paper the tooltip had already fetched.
    expect(inspectCalls(calls)).toBe(1);
  }, 30_000);
});

/*
 * The inspection modal under the same frames (#94 review): a student typing
 * sends a `dashboard.cell` a second, and the modal must neither re-read the
 * whole paper at that pace nor, when it does re-read it, throw the teacher
 * back to the question they clicked.
 */
describe("InspectModal under live frames", () => {
  const scrollTops = new WeakMap<Element, number>();
  const saved = {
    rect: Element.prototype.getBoundingClientRect,
    scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
    scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
  };

  beforeEach(() => {
    // jsdom has no layout: every question sits 400 px down a list that
    // scrolls, and `scrollTop` remembers what it is given.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { top: this.tagName === "LI" ? 400 : 0 } as DOMRect;
    };
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) {
        return scrollTops.get(this) ?? 0;
      },
      set(this: Element, v: number) {
        scrollTops.set(this, v);
      },
    });
    Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => 500 });
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = saved.rect;
    for (const key of ["scrollTop", "scrollHeight", "clientHeight"] as const) {
      const d = saved[key];
      if (d) Object.defineProperty(Element.prototype, key, d);
      else delete (Element.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it("keeps the teacher's scroll position through frames and re-reads", async () => {
    const user = userEvent.setup();
    let held: Held = { text: "first draft", revision: 1 };
    const { calls, queryClient } = setup(() => held);
    await user.click(await cellButton());
    const dialog = await screen.findByRole("dialog", { name: /answers of nadia roux 1/i }, { timeout: 10_000 });
    // The list of questions: the first list of the dialog (a type may hold its own).
    const list = (await within(dialog).findAllByRole("list"))[0]!;
    // Opened onto the clicked question…
    await waitFor(() => expect(list.scrollTop).toBe(400));
    // …then the teacher scrolls on to read another one.
    list.scrollTop = 1234;

    held = { text: "second draft", revision: 2 };
    cellFrame(1, 2, "second…");
    // A frame marks the paper stale; it does not re-read it under the modal.
    await new Promise((r) => setTimeout(r, 50));
    expect(inspectCalls(calls)).toBe(1);

    // A real re-read (a reconnect re-reads every cached paper) lands new
    // data, and the list stays where the teacher put it.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: attemptInspectKey(EVALUATION_ID, ATTEMPT) });
    });
    await waitFor(() => expect(inspectCalls(calls)).toBe(2));
    expect(list.scrollTop).toBe(1234);
  }, 30_000);
});
