import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttemptInspect, DashboardView, ServerEvent } from "@quiz/contracts";

import { initialGrid } from "../realtime/grid";
import { resetEventStream } from "../realtime/useEventStream";
import { EVALUATION_ID, id, makeDashboard, makeEvaluationDetail } from "../test/live-fixtures";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { dashboardKey } from "../queryKeys";
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

function paper(text: string): AttemptInspect & { serverNow: string } {
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
      studentConfig: { prompt: "?", kind: "text", constraints: {} },
      answer: i === 1 ? { text } : null,
      revision: i === 1 ? 1 : 0,
      markedDone: false,
      solution: null,
    })),
    events: [],
    serverNow: new Date().toISOString(),
  };
}

function setup(answer: () => string) {
  const view = dashboard();
  const queryClient = makeQueryClient();
  queryClient.setQueryData(dashboardKey(EVALUATION_ID, true, true), initialGrid(view));
  const stubs = mockFetch({
    [`GET /app/api/evaluations/${EVALUATION_ID}`]: ok(makeEvaluationDetail()),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=0&results=1`]: ok(view),
    [`GET /app/api/evaluations/${EVALUATION_ID}/dashboard?includeAnswers=1&results=1`]: ok(view),
    [INSPECT_URL]: () => ok(paper(answer())),
  });
  renderWithProviders(<LiveDashboard id={EVALUATION_ID} navigate={vi.fn()} />, { queryClient });
  return stubs;
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

  it("re-reads the answer when the student writes, instead of showing a stale one", async () => {
    let current = "first draft";
    const { calls } = setup(() => current);
    const cell = await cellButton();
    act(() => cell.focus());
    expect(await screen.findByText("first draft")).toBeInTheDocument();

    current = "second draft";
    act(() => {
      FakeEventSource.instances.at(-1)!.send({
        type: "dashboard.cell",
        evaluationId: EVALUATION_ID,
        attemptId: ATTEMPT,
        itemId: id("item", 1),
        status: "in_progress",
        revision: 2,
        points: null,
        summary: "second draft",
        verdict: null,
      });
    });
    expect(await screen.findByText("second draft", { selector: "p" })).toBeInTheDocument();
    await waitFor(() => expect(inspectCalls(calls)).toBe(2));
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
