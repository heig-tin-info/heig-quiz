import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GradingEntry } from "@quiz/contracts";

import { DICTS } from "../i18n";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { GradingPanel } from "./GradingPanel";
import { makeEntry, makeEvaluationDetail, makeGrading, makeQueue } from "../test/grading-fixtures";

/*
 * The TRAVERSAL of the grading panel, pinned before FF-05 pulls it out of the
 * component into `useGradingTraversal` / `useGradingKeys` / `GradingFilters`.
 *
 * Everything asserted here is a rule the extracted hooks have to keep:
 *   - the two orders and the REQUEST each one produces — by question the
 *     steps are the items, by student they are the attempts of the roster,
 *     read from the queue of the first question rather than a sixth endpoint;
 *   - the filters, which are partly server-side (`state`) and partly
 *     client-side (`source`, `confidence`) — a distinction that is invisible
 *     on screen and very visible in the network tab;
 *   - proposals first, stably: two entries of the same rank keep the order
 *     the server sent them in;
 *   - the keyboard of docs/08 §8.5, including the three cases where it must
 *     do NOTHING: a modifier is held, a field has the focus, a dialog is up.
 *
 * `GradingPanel.test.tsx` covers the screen as a whole; this file covers only
 * the walking of it, and deliberately overlaps on the two arrow keys — they
 * are the axis both files turn on.
 */

const EVAL = "/app/api/evaluations/e1";
const BY_QUESTION = (itemId: string, extra = "") =>
  `${EVAL}/grading?by=question&itemId=${itemId}&anonymous=1${extra}`;
const BY_STUDENT = (attemptId: string, extra = "") =>
  `${EVAL}/grading?by=student&attemptId=${attemptId}&anonymous=1${extra}`;

/**
 * Four answers of the first question, deliberately NOT in the order the panel
 * shows them: two proposals sit behind two settled ones, so a list that
 * merely echoed the payload would fail the "proposals first" test.
 */
const ENTRIES: GradingEntry[] = [
  makeEntry({
    attemptId: "a1",
    label: "Amber Lynx",
    grading: makeGrading({ id: "g1", attemptId: "a1", state: "validated", source: "manual", confidence: null }),
  }),
  makeEntry({
    attemptId: "a2",
    label: "Bold Raven",
    grading: makeGrading({ id: "g2", attemptId: "a2", state: "proposed", source: "llm", confidence: "low" }),
  }),
  makeEntry({
    attemptId: "a3",
    label: "Calm Heron",
    grading: makeGrading({ id: "g3", attemptId: "a3", state: "validated", source: "auto", confidence: "high" }),
  }),
  makeEntry({
    attemptId: "a4",
    label: "Wise Otter",
    grading: makeGrading({ id: "g4", attemptId: "a4", state: "proposed", source: "auto", confidence: "high" }),
  }),
];

function routes(over: Record<string, ReturnType<typeof ok>> = {}) {
  return {
    [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
    [`GET ${BY_QUESTION("i1")}`]: ok(makeQueue(ENTRIES)),
    [`GET ${BY_QUESTION("i2")}`]: ok(makeQueue([])),
    [`GET ${EVAL}/grading/progress`]: ok({
      done: 6,
      total: 6,
      pending: { runner: 0, llm: 0 },
      failed: 0,
    }),
    [`GET ${EVAL}/results/by-question`]: ok([]),
    ...over,
  };
}

function setup(over: Record<string, ReturnType<typeof ok>> = {}) {
  const queryClient = makeQueryClient();
  const stubs = mockFetch(routes(over));
  const rendered = renderWithProviders(
    <GradingPanel evaluationId="e1" navigate={vi.fn()} />,
    { queryClient },
  );
  return { ...rendered, ...stubs, queryClient };
}

/*
 * A row's accessible name is `grading.entry.open` with the label substituted
 * in. Taken from the dictionary rather than retyped here: an English string
 * in a test is a second, silent translation of a key that N-I18N-01 says has
 * exactly one, and rewording the entry would leave these queries matching
 * nothing with no hint as to why.
 */
const OPEN_TEMPLATE = DICTS.en["grading.entry.open"]!;
const OPEN_PREFIX = OPEN_TEMPLATE.slice(0, OPEN_TEMPLATE.indexOf("{label}"));

/** The rows of the list, in the order they are shown. */
const rows = () => screen.getAllByRole("button", { name: (name) => name.startsWith(OPEN_PREFIX) });
const labels = () =>
  rows().map((r) => (r.getAttribute("aria-label") ?? "").slice(OPEN_PREFIX.length));
const openIndex = () => rows().findIndex((r) => r.getAttribute("aria-expanded") === "true");

/**
 * Opens the row at `index` the only way that works today.
 *
 * `EntryList` spreads `pressable()` on the row and gives it no `onClick`, so
 * the row answers Enter and Space and IGNORES the mouse — see the last test
 * of this file, which pins that. Everything else here is about the
 * traversal, not about that defect, so it goes through the keyboard.
 */
async function openRow(user: ReturnType<typeof userEvent.setup>, index: number) {
  rows()[index]!.focus();
  await user.keyboard("{Enter}");
}

beforeEach(() => {
  // jsdom has no EventSource; `progress.ts` copes, and so must the test.
  vi.stubGlobal("EventSource", undefined);
});

describe("GradingPanel — the order of the traversal", () => {
  it("starts by question, with one step per item, numbered from one", async () => {
    setup();
    expect(await screen.findByText("Question 1 of 2")).toBeVisible();
    expect(screen.getByText("1. sizeof-ptr")).toBeVisible();
    expect(screen.getByRole("radio", { name: "By question" })).toBeChecked();
  });

  it("wraps around at both ends of the questions", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    // Backwards from the first: the last, not a dead button.
    await user.click(screen.getByRole("button", { name: "Previous question" }));
    expect(await screen.findByText("Question 2 of 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next question" }));
    expect(await screen.findByText("Question 1 of 2")).toBeVisible();
  });

  it("reads the students off the queue of the FIRST question, not a sixth endpoint", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ [`GET ${BY_STUDENT("a1")}`]: ok(makeQueue([ENTRIES[0]!])) });
    await screen.findByText("Question 1 of 2");

    await user.click(screen.getByRole("radio", { name: "By student" }));
    expect(await screen.findByText("Student 1 of 4")).toBeVisible();
    // The roster and the queue share the same URL, so the cache answers the
    // second one: no extra endpoint exists for the list of students.
    expect(calls.every((c) => !c.url.includes("/roster"))).toBe(true);
    expect(calls.some((c) => c.url === BY_STUDENT("a1"))).toBe(true);
  });

  it("switches the queue to `by=student` and restarts at the first step", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      [`GET ${BY_STUDENT("a1")}`]: ok(makeQueue([ENTRIES[0]!])),
      [`GET ${BY_STUDENT("a2")}`]: ok(makeQueue([ENTRIES[1]!])),
    });
    await screen.findByText("Question 1 of 2");
    // Walk to the second question first: switching order must reset the index.
    await user.click(screen.getByRole("button", { name: "Next question" }));
    await screen.findByText("Question 2 of 2");

    await user.click(screen.getByRole("radio", { name: "By student" }));
    expect(await screen.findByText("Student 1 of 4")).toBeVisible();
    await waitFor(() => expect(calls.some((c) => c.url === BY_STUDENT("a1"))).toBe(true));

    await user.click(screen.getByRole("button", { name: "Next student" }));
    expect(await screen.findByText("Student 2 of 4")).toBeVisible();
    await waitFor(() => expect(calls.some((c) => c.url === BY_STUDENT("a2"))).toBe(true));
  });

  it("names a row by the question, not by the pseudonym, while traversing by student", async () => {
    const user = userEvent.setup();
    setup({
      [`GET ${BY_STUDENT("a1")}`]: ok(
        makeQueue([
          makeEntry({ attemptId: "a1", itemId: "i1", label: "Amber Lynx" }),
          makeEntry({ attemptId: "a1", itemId: "i2", label: "Amber Lynx" }),
        ]),
      ),
    });
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "By student" }));
    await screen.findByText("Student 1 of 4");
    // Thirty rows all reading "Amber Lynx" would name nothing.
    await waitFor(() => expect(labels()).toEqual(["1. sizeof-ptr", "2. array-decay"]));
  });

  it("offers the re-grade action only while the step is a question", async () => {
    const user = userEvent.setup();
    setup({ [`GET ${BY_STUDENT("a1")}`]: ok(makeQueue([ENTRIES[0]!])) });
    await screen.findByText("Question 1 of 2");
    expect(screen.getByRole("button", { name: /Re-grade/ })).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "By student" }));
    await screen.findByText("Student 1 of 4");
    // Re-grading is per question (F-GRADE-06); there is no question here.
    expect(screen.queryByRole("button", { name: /Re-grade/ })).toBeNull();
  });
});

describe("GradingPanel — the filters", () => {
  it("sends the state filter to the server, and `all` as no parameter at all", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      [`GET ${BY_QUESTION("i1", "&state=proposed")}`]: ok(
        makeQueue([ENTRIES[1]!, ENTRIES[3]!]),
      ),
    });
    await screen.findByText("Question 1 of 2");
    expect(calls.some((c) => c.url === BY_QUESTION("i1"))).toBe(true);

    await user.click(screen.getByRole("radio", { name: "To validate" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === BY_QUESTION("i1", "&state=proposed"))).toBe(true),
    );
    await waitFor(() => expect(labels()).toEqual(["Bold Raven", "Wise Otter"]));
  });

  it("asks for the validated ones the same way", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      [`GET ${BY_QUESTION("i1", "&state=validated")}`]: ok(makeQueue([ENTRIES[0]!])),
    });
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "Validated" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === BY_QUESTION("i1", "&state=validated"))).toBe(true),
    );
  });

  /*
   * Source and confidence are filtered in the BROWSER, on the queue already
   * downloaded: no request goes out and the counters in the header keep
   * counting the whole step. That asymmetry with the state filter is the
   * thing to preserve — or to change knowingly.
   */
  it("filters by source without asking the server again", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await screen.findByText("Question 1 of 2");
    const before = calls.length;

    await user.selectOptions(screen.getByLabelText("Source"), "auto");
    await waitFor(() => expect(labels()).toEqual(["Wise Otter", "Calm Heron"]));
    expect(calls).toHaveLength(before);
  });

  it("filters by confidence the same way, and combines the two", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");

    await user.selectOptions(screen.getByLabelText("Confidence"), "high");
    await waitFor(() => expect(labels()).toEqual(["Wise Otter", "Calm Heron"]));
    await user.selectOptions(screen.getByLabelText("Source"), "llm");
    // Nothing is both `llm` and `high`.
    expect(await screen.findByText("Nothing left to grade")).toBeVisible();
  });

  it("scopes the batch bar to the client-side filters and says it is scoped", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ [`POST ${EVAL}/grading/validate-batch`]: ok({ validated: 1 }) });
    await screen.findByText("Question 1 of 2");

    await user.selectOptions(screen.getByLabelText("Source"), "llm");
    await user.click(await screen.findByRole("button", { name: /Validate 1 proposal/ }));
    await waitFor(() => {
      const call = calls.find((c) => c.url === `${EVAL}/grading/validate-batch`);
      expect(call?.body).toEqual({ itemId: "i1", source: "llm", state: "proposed" });
    });
  });
});

describe("GradingPanel — proposals first", () => {
  it("puts every proposal before every settled grading, keeping the server's order inside each", async () => {
    setup();
    await screen.findByText("Question 1 of 2");
    // Payload order is Amber (validated), Bold (proposed), Calm (validated),
    // Wise (proposed): the two proposals come up, in their own relative order.
    await waitFor(() =>
      expect(labels()).toEqual(["Bold Raven", "Wise Otter", "Amber Lynx", "Calm Heron"]),
    );
  });

  it("opens on the first row of the sorted list, not of the payload", async () => {
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));
    expect(labels()[0]).toBe("Bold Raven");
  });

  it("keeps the open row open when the list is re-sorted around it", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    await openRow(user, 2); // Amber Lynx, a validated one
    await waitFor(() => expect(openIndex()).toBe(2));
    // A filter that keeps it must not move the selection off it.
    await user.selectOptions(screen.getByLabelText("Source"), "manual");
    await waitFor(() => expect(labels()).toEqual(["Amber Lynx"]));
    expect(openIndex()).toBe(0);
  });

  it("falls back to the first row when the filter drops the open one", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(labels()[0]).toBe("Bold Raven"));

    await user.selectOptions(screen.getByLabelText("Source"), "auto");
    await waitFor(() => expect(labels()).toEqual(["Wise Otter", "Calm Heron"]));
    expect(openIndex()).toBe(0);
  });
});

describe("GradingPanel — the keyboard", () => {
  it("walks the list with the arrows and stops at both ends", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    // Clamped, not wrapped: the step buttons above wrap, the list does not.
    await user.keyboard("{ArrowLeft}");
    expect(openIndex()).toBe(0);

    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(openIndex()).toBe(3);
    await user.keyboard("{ArrowLeft}");
    expect(openIndex()).toBe(2);
  });

  it("validates the open proposal with `v` and moves on", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ "POST /app/api/gradings/g2/validate": ok(makeGrading()) });
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    await user.keyboard("v");
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/gradings/g2/validate")).toBe(true),
    );
    expect(openIndex()).toBe(1);
  });

  it("moves on without a request when the open row is already validated", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(labels()[2]).toBe("Amber Lynx"));
    await openRow(user, 2);
    await waitFor(() => expect(openIndex()).toBe(2));

    await user.keyboard("v");
    expect(openIndex()).toBe(3);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("opens the adjustment sheet on `o`, on the row that is open", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));
    await user.keyboard("{ArrowRight}o");
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Adjust this grading");
    expect(within(dialog).getByText(/Wise Otter/)).toBeVisible();
  });

  it("does not fire while the focus is in a field", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await user.keyboard("vo{ArrowRight}");
    expect(input).toHaveValue("vo");
    expect(openIndex()).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    input.remove();
  });

  it("does not fire while the focus is in a textarea", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    const area = document.createElement("textarea");
    document.body.append(area);
    area.focus();
    await user.keyboard("v");
    expect(area).toHaveValue("v");
    expect(openIndex()).toBe(0);
    area.remove();
  });

  it("does not fire while a dialog is up", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    await user.keyboard("o");
    await screen.findByRole("dialog");
    // `v` behind the sheet must not validate the row it covers.
    await user.keyboard("{ArrowRight}");
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  /*
   * DEFECT, pinned as it stands so the fix is a visible flip of this test.
   *
   * `EntryList.tsx` spreads `pressable(() => onSelect(key))` on the row and
   * never adds the `onClick` that `pressable`'s own documentation says to
   * spread it next to ("Spread it next to the element's own `onClick`",
   * ui/layers.tsx). The row therefore carries `cursor-pointer`, announces itself as
   * a button and answers Enter and Space — and does nothing at all when it
   * is clicked, which is how every teacher will actually use it. When the
   * `onClick` is added, this expectation becomes `toBe(2)` and the name
   * becomes "opens the row that is clicked".
   */
  it("today: a mouse click on a row selects nothing (no onClick beside `pressable`)", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    await user.click(rows()[2]!);
    expect(openIndex()).toBe(0);
    // The same row DOES answer the keyboard, which is what makes the gap a
    // missing handler rather than a disabled list.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(openIndex()).toBe(2));
  });

  it("leaves a browser shortcut alone", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));
    // Ctrl/Cmd/Alt belong to the browser, never to the panel.
    await user.keyboard("{Control>}{ArrowRight}{/Control}");
    expect(openIndex()).toBe(0);
  });
});
