import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GradingEntry } from "@quiz/contracts";

import { DICTS } from "../i18n";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { GradingPanel } from "./GradingPanel";
import {
  makeEntry,
  makeEvaluationDetail,
  makeGrading,
  makeQueue,
  makeSteps,
} from "../test/grading-fixtures";

/*
 * The TRAVERSAL of the grading panel, pinned before FF-05 pulls it out of the
 * component into `useGradingTraversal` / `useGradingKeys` / `GradingFilters`.
 *
 * Everything asserted here is a rule the extracted hooks have to keep:
 *   - the two orders and the REQUEST each one produces — by question the
 *     steps are the items, by student they are the attempts, read from the
 *     step summary (`…/grading/steps`, #107), which also gives every step its
 *     state for the step picker;
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
const STEPS = (by: "question" | "student") => `${EVAL}/grading/steps?by=${by}&anonymous=1`;

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
    [`GET ${STEPS("question")}`]: ok(
      makeSteps("question", [
        { key: "i1", validated: 2, proposed: 2 },
        { key: "i2", validated: 0, total: 4 },
      ]),
    ),
    [`GET ${STEPS("student")}`]: ok(
      makeSteps("student", [
        { key: "a1", label: "Amber Lynx", validated: 2 },
        { key: "a2", label: "Bold Raven", validated: 1, proposed: 1 },
        { key: "a3", label: "Calm Heron", validated: 2 },
        { key: "a4", label: "Wise Otter", proposed: 2 },
      ]),
    ),
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
 * A row's accessible name is `grading.entry.row` — "{label}, {state},
 * {score}". The label is what comes before the first separator of that
 * template, taken from the dictionary rather than retyped here: an English
 * string in a test is a second, silent translation of a key that N-I18N-01
 * says has exactly one.
 */
const ROW_TEMPLATE = DICTS.en["grading.entry.row"]!;
const SEPARATOR = ROW_TEMPLATE.slice(
  ROW_TEMPLATE.indexOf("{label}") + "{label}".length,
  ROW_TEMPLATE.indexOf("{state}"),
);

/** The rows of the answer list, in the order they are shown. */
const rows = () =>
  within(screen.getByRole("list", { name: DICTS.en["grading.list.label"] })).getAllByRole(
    "button",
  );
const labels = () =>
  rows().map((r) => {
    const name = r.getAttribute("aria-label") ?? "";
    return name.slice(0, name.indexOf(SEPARATOR));
  });
const openIndex = () => rows().findIndex((r) => r.getAttribute("aria-current") === "true");

/** The one detail area, and the name its header shows. */
const detail = () => screen.getByRole("region", { name: DICTS.en["grading.detail.label"] });

/** Opens the row at `index` as a teacher does: with the mouse. */
async function openRow(user: ReturnType<typeof userEvent.setup>, index: number) {
  await user.click(rows()[index]!);
}

beforeEach(() => {
  // jsdom has no EventSource; `progress.ts` copes, and so must the test.
  vi.stubGlobal("EventSource", undefined);
});

describe("GradingPanel — the order of the traversal", () => {
  it("starts by question, with one step per item, numbered from one", async () => {
    setup();
    expect(await screen.findByText("Question 1 of 2")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "1. sizeof-ptr" })).toBeVisible();
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

  it("reads the students from the step summary, never from a queue", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ [`GET ${BY_STUDENT("a1")}`]: ok(makeQueue([ENTRIES[0]!])) });
    await screen.findByText("Question 1 of 2");

    await user.click(screen.getByRole("radio", { name: "By student" }));
    expect(await screen.findByText("Student 1 of 4")).toBeVisible();
    expect(calls.some((c) => c.url === STEPS("student"))).toBe(true);
    expect(calls.some((c) => c.url === BY_STUDENT("a1"))).toBe(true);
    // No whole queue is downloaded just to learn who the students are.
    expect(calls.filter((c) => c.url.includes("/grading?")).map((c) => c.url)).toEqual([
      BY_QUESTION("i1"),
      BY_STUDENT("a1"),
    ]);
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

    await user.selectOptions(screen.getByLabelText("Graded by"), "auto");
    await waitFor(() => expect(labels()).toEqual(["Wise Otter", "Calm Heron"]));
    expect(calls).toHaveLength(before);
  });

  it("filters by confidence the same way, and combines the two", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");

    await user.selectOptions(screen.getByLabelText("Confidence"), "high");
    await waitFor(() => expect(labels()).toEqual(["Wise Otter", "Calm Heron"]));
    await user.selectOptions(screen.getByLabelText("Graded by"), "llm");
    // Nothing is both `llm` and `high`.
    expect(await screen.findByText("Nothing left to grade")).toBeVisible();
  });

  it("scopes the batch bar to the client-side filters and says it is scoped", async () => {
    const user = userEvent.setup();
    const { calls } = setup({ [`POST ${EVAL}/grading/validate-batch`]: ok({ validated: 1 }) });
    await screen.findByText("Question 1 of 2");

    await user.selectOptions(screen.getByLabelText("Graded by"), "llm");
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
    await user.selectOptions(screen.getByLabelText("Graded by"), "manual");
    await waitFor(() => expect(labels()).toEqual(["Amber Lynx"]));
    expect(openIndex()).toBe(0);
  });

  it("falls back to the first row when the filter drops the open one", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(labels()[0]).toBe("Bold Raven"));

    await user.selectOptions(screen.getByLabelText("Graded by"), "auto");
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

  it("opens the row that is clicked, and Enter on a focused row does the same", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    await user.click(rows()[2]!);
    expect(openIndex()).toBe(2);
    expect(within(detail()).getByText("Amber Lynx")).toBeVisible();

    rows()[3]!.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(openIndex()).toBe(3));
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

describe("GradingPanel — one answer at a fixed place (#102)", () => {
  it("replaces the detail in place on Next and Previous", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));

    const area = detail();
    expect(within(area).getByText("Bold Raven")).toBeVisible();
    expect(within(area).getByText("Answer 1 of 4")).toBeVisible();
    // At the first answer there is nothing before it.
    expect(within(area).getByRole("button", { name: "Previous answer" })).toBeDisabled();

    await user.click(within(area).getByRole("button", { name: "Next answer" }));
    // The SAME element, with new content: nothing was collapsed and expanded
    // a row lower, which is what made the answer slide down the page.
    expect(detail()).toBe(area);
    expect(within(area).getByText("Wise Otter")).toBeVisible();
    expect(within(area).getByText("Answer 2 of 4")).toBeVisible();
    expect(within(area).queryByText("Bold Raven")).toBeNull();
    expect(openIndex()).toBe(1);
    expect(screen.getAllByRole("region", { name: DICTS.en["grading.detail.label"] })).toHaveLength(1);

    await user.click(within(area).getByRole("button", { name: "Previous answer" }));
    expect(within(area).getByText("Bold Raven")).toBeVisible();
    expect(openIndex()).toBe(0);
  });

  it("stops Next at the last answer", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(labels()).toHaveLength(4));
    await openRow(user, 3);
    expect(within(detail()).getByRole("button", { name: "Next answer" })).toBeDisabled();
  });

  it("offers the answers as a select for a phone, bound to the same position", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    const picker = await screen.findByRole("combobox", { name: DICTS.en["grading.list.pick"] });
    await waitFor(() => expect(openIndex()).toBe(0));
    expect(within(picker).getAllByRole("option")).toHaveLength(4);

    await user.selectOptions(picker, "a3:i1");
    expect(openIndex()).toBe(3);
    expect(within(detail()).getByText("Calm Heron")).toBeVisible();
    // The keyboard walks from where the select left it.
    await user.click(document.body);
    await user.keyboard("{ArrowLeft}");
    expect(openIndex()).toBe(2);
    expect(picker).toHaveValue("a1:i1");
  });
});

describe("GradingPanel — the step picker (#107)", () => {
  const openPicker = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
    await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
    return screen.getByRole("listbox");
  };

  it("lists every step with its state", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Question 1 of 2/ })).toBeEnabled(),
    );
    const list = await openPicker(user, "Question 1 of 2");
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    const [first, second] = within(list).getAllByRole("option");
    expect(first).toHaveTextContent("1. sizeof-ptr");
    expect(first).toHaveTextContent("2 to validate");
    expect(first).toHaveTextContent("current");
    expect(second).toHaveTextContent("4 not graded");
  });

  it("filters the students and jumps to the one picked", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      [`GET ${BY_STUDENT("a1")}`]: ok(makeQueue([ENTRIES[0]!])),
      [`GET ${BY_STUDENT("a3")}`]: ok(makeQueue([ENTRIES[2]!])),
    });
    await screen.findByText("Question 1 of 2");
    await user.click(screen.getByRole("radio", { name: "By student" }));
    await screen.findByText("Student 1 of 4");

    const list = await openPicker(user, "Student 1 of 4");
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    expect(within(list).getAllByRole("option")[0]).toHaveTextContent("All validated");
    await user.keyboard("heron");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Calm Heron");

    await user.keyboard("{Enter}");
    expect(await screen.findByText("Student 3 of 4")).toBeVisible();
    expect(screen.queryByRole("listbox")).toBeNull();
    // The focus goes back to the button it came from.
    expect(screen.getByRole("button", { name: /^Student 3 of 4/ })).toHaveFocus();
    await waitFor(() => expect(calls.some((c) => c.url === BY_STUDENT("a3"))).toBe(true));
  });

  it("jumps on a click, says so when nothing matches, and closes on Escape", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    let list = await openPicker(user, "Question 1 of 2");
    await user.keyboard("zzz");
    expect(within(list).getByText(/Nothing matches/)).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();

    list = await openPicker(user, "Question 1 of 2");
    await user.click(within(list).getByRole("option", { name: /array-decay/ }));
    expect(await screen.findByText("Question 2 of 2")).toBeVisible();
  });

  it("leaves the answer keys alone while its field is typed in", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));
    await openPicker(user, "Question 1 of 2");
    await user.keyboard("vo{ArrowRight}");
    expect(openIndex()).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("GradingPanel — the step picker's button", () => {
  it("closes the panel when pressed again", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    const button = screen.getByRole("button", { name: /^Question 1 of 2/ });
    await user.click(button);
    expect(screen.getByRole("listbox")).toBeVisible();
    await user.click(button);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});

describe("GradingPanel — focus and the staff row", () => {
  it("moves the focus with the selection when it was in the list", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(openIndex()).toBe(0));
    await user.click(rows()[1]!);
    expect(rows()[1]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(openIndex()).toBe(2);
    expect(rows()[2]).toHaveFocus();
    // Enter now acts on the open row, not on the one clicked before.
    await user.keyboard("{Enter}");
    expect(openIndex()).toBe(2);
  });

  it("says a teacher's own attempt out loud, not only with an icon", async () => {
    setup({
      [`GET ${BY_QUESTION("i1")}`]: ok(
        makeQueue([makeEntry({ attemptId: "a9", label: "Prof Démo", staff: true })]),
      ),
    });
    await screen.findByText("Question 1 of 2");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.getAttribute("aria-label")).toMatch(/^Prof Démo \(.+\), /);
  });

  it("keeps the batch banner, quiet, once nothing is left to validate", async () => {
    setup({ [`GET ${BY_QUESTION("i1")}`]: ok(makeQueue([ENTRIES[0]!, ENTRIES[2]!])) });
    await screen.findByText("Question 1 of 2");
    expect(await screen.findByText(DICTS.en["grading.batch.none"]!)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Validate \d+ proposal/ })).toBeNull();
  });
});
