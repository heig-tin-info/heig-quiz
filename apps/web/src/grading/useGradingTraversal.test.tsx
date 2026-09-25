import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { GradingEntry } from "@quiz/contracts";

import {
  makeEntry,
  makeEvaluationDetail,
  makeGrading,
  makeQueue,
  makeSteps,
} from "../test/grading-fixtures";
import { makeQueryClient, mockFetch, ok } from "../test/render";
import { proposalsFirst } from "./labels";
import {
  ANY,
  neighbour,
  stepStatus,
  useGradingTraversal,
  type TraversalChoices,
} from "./useGradingTraversal";

/*
 * The hook half of FF-05: which requests a set of choices produces, and what
 * it derives from the answers. `GradingPanel.traversal.test.tsx` walks the
 * same rules through the screen; this pins them without a DOM.
 */

const EVAL = "/app/api/evaluations/e1";
const BY_QUESTION = (itemId: string, anonymous = "1", extra = "") =>
  `${EVAL}/grading?by=question&itemId=${itemId}&anonymous=${anonymous}${extra}`;
const BY_STUDENT = (attemptId: string) =>
  `${EVAL}/grading?by=student&attemptId=${attemptId}&anonymous=1`;

const entry = (attemptId: string, label: string, state: "proposed" | "validated", source: "auto" | "llm" | "manual" = "auto") =>
  makeEntry({
    attemptId,
    label,
    grading: makeGrading({ id: `g-${attemptId}`, attemptId, state, source, confidence: "high" }),
  });

/** Server order: validated, proposed, validated, proposed. */
const ENTRIES: GradingEntry[] = [
  entry("a1", "Amber Lynx", "validated", "manual"),
  entry("a2", "Bold Raven", "proposed", "llm"),
  entry("a3", "Calm Heron", "validated"),
  entry("a4", "Wise Otter", "proposed"),
];

const BASE: Record<string, ReturnType<typeof ok>> = {
  [`GET ${EVAL}`]: ok(makeEvaluationDetail()),
  [`GET ${BY_QUESTION("i1")}`]: ok(makeQueue(ENTRIES)),
  [`GET ${EVAL}/grading/steps?by=question&anonymous=1`]: ok(
    makeSteps("question", [{ key: "i1", validated: 2, proposed: 2 }, { key: "i2", total: 4 }]),
  ),
  [`GET ${EVAL}/grading/steps?by=student&anonymous=1`]: ok(
    makeSteps("student", [
      { key: "a1", label: "Amber Lynx" },
      { key: "a2", label: "Bold Raven", proposed: 1 },
      { key: "a3", label: "Calm Heron" },
      { key: "a4", label: "Wise Otter", staff: true },
    ]),
  ),
  [`GET ${EVAL}/grading/progress`]: ok({ done: 4, total: 4, pending: { runner: 0, llm: 0 }, failed: 0 }),
  [`GET ${EVAL}/results/by-question`]: ok([
    { item: { id: "i1" }, explanation: "Pointers are 8 bytes." },
    { item: { id: "i2" }, explanation: null },
  ]),
};

const CHOICES: TraversalChoices = {
  order: "question",
  index: 0,
  stateFilter: "all",
  source: ANY,
  confidence: ANY,
  showNames: false,
};

function setup(choices: Partial<TraversalChoices> = {}, routes: Record<string, ReturnType<typeof ok>> = {}) {
  const fetch = mockFetch({ ...BASE, ...routes });
  const client = makeQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook((c: TraversalChoices) => useGradingTraversal("e1", c), {
    wrapper,
    initialProps: { ...CHOICES, ...choices },
  });
  return { ...hook, calls: fetch.calls };
}

const labels = (entries: GradingEntry[]) => entries.map((e) => e.label);

describe("useGradingTraversal", () => {
  it("by question: one step per item, numbered from 1, and the queue of the first", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.entries).toHaveLength(4));
    expect(result.current.step?.label).toBe("1. sizeof-ptr");
    // The labels are the items'; the state joins them once the summary lands.
    await waitFor(() =>
      expect(result.current.steps).toEqual([
        { key: "i1", label: "1. sizeof-ptr", state: { total: 4, validated: 2, proposed: 2 } },
        { key: "i2", label: "2. array-decay", state: { total: 4, validated: 0, proposed: 0 } },
      ]),
    );
    expect(result.current.itemsById.get("i2")?.points).toBe(3);
  });

  it("proposals first, each rank in the order the server sent", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.entries).toHaveLength(4));
    expect(labels(result.current.entries)).toEqual(["Bold Raven", "Wise Otter", "Amber Lynx", "Calm Heron"]);
  });

  it("counts come from the queue, and default to zero before it lands", async () => {
    const { result } = setup();
    expect(result.current.counts).toEqual({ total: 0, validated: 0, proposed: 0, missing: 0 });
    await waitFor(() => expect(result.current.counts.total).toBe(4));
    expect(result.current.counts).toEqual({ total: 4, validated: 2, proposed: 2, missing: 0 });
  });

  it("the state filter is a server parameter; source is filtered client-side", async () => {
    const proposedOnly = ENTRIES.filter((e) => e.grading?.state === "proposed");
    const { result, calls } = setup(
      { stateFilter: "proposed", source: "llm" },
      { [`GET ${BY_QUESTION("i1", "1", "&state=proposed")}`]: ok(makeQueue(proposedOnly)) },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(labels(result.current.entries)).toEqual(["Bold Raven"]);
    expect(calls.map((c) => c.url)).toContain(BY_QUESTION("i1", "1", "&state=proposed"));
  });

  it("by student: the steps come from the step summary, and the queue is per attempt", async () => {
    const { result, calls } = setup(
      { order: "student", index: 1 },
      { [`GET ${BY_STUDENT("a2")}`]: ok(makeQueue([ENTRIES[1]!], { order: "student" })) },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.steps.map((s) => s.key)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(result.current.step).toMatchObject({ key: "a2", label: "Bold Raven", staff: false });
    expect(result.current.steps[3]).toMatchObject({ label: "Wise Otter", staff: true });
    expect(calls.map((c) => c.url)).toContain(`${EVAL}/grading/steps?by=student&anonymous=1`);
    expect(calls.map((c) => c.url)).toContain(BY_STUDENT("a2"));
  });

  it("names are a request: showNames asks for anonymous=0", async () => {
    const { result, calls } = setup(
      { showNames: true },
      { [`GET ${BY_QUESTION("i1", "0")}`]: ok(makeQueue(ENTRIES)) },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(4));
    expect(calls.map((c) => c.url)).toContain(BY_QUESTION("i1", "0"));
    expect(calls.map((c) => c.url)).not.toContain(BY_QUESTION("i1", "1"));
  });

  it("explanations keep only the items that have one", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.explanations.size).toBe(1));
    expect(result.current.explanations.get("i1")).toBe("Pointers are 8 bytes.");
  });

  it("an index past the end clamps to the last step", async () => {
    const { result } = setup(
      { index: 9 },
      { [`GET ${BY_QUESTION("i2")}`]: ok(makeQueue([])) },
    );
    await waitFor(() => expect(result.current.step?.key).toBe("i2"));
  });
});

describe("the position", () => {
  it("resolves the open answer and its place among the sorted entries", async () => {
    const { result } = setup({ selected: "a4:i1" });
    await waitFor(() => expect(result.current.current?.index).toBe(1));
    expect(result.current.current?.entry.label).toBe("Wise Otter");
  });

  it("is null while nothing is open", async () => {
    const { result } = setup({ selected: null });
    await waitFor(() => expect(result.current.entries).toHaveLength(4));
    expect(result.current.current).toBeNull();
  });

  it("neighbour clamps at both ends and starts from the top when nothing is open", () => {
    const sorted = proposalsFirst(ENTRIES);
    expect(neighbour(sorted, "a2:i1", -1)).toBe("a2:i1");
    expect(neighbour(sorted, "a2:i1", 1)).toBe("a4:i1");
    expect(neighbour(sorted, "a3:i1", 1)).toBe("a3:i1");
    expect(neighbour(sorted, null, 1)).toBe("a2:i1");
    expect(neighbour([], "a2:i1", 1)).toBeNull();
  });

  it("stepStatus: proposals first, then all validated, else ungraded", () => {
    expect(stepStatus({ total: 4, validated: 3, proposed: 1 })).toBe("toValidate");
    expect(stepStatus({ total: 4, validated: 4, proposed: 0 })).toBe("done");
    expect(stepStatus({ total: 4, validated: 2, proposed: 0 })).toBe("ungraded");
  });
});

describe("proposalsFirst", () => {
  it("is stable within a rank and leaves the input alone", () => {
    const input = [...ENTRIES];
    expect(labels(proposalsFirst(input))).toEqual(["Bold Raven", "Wise Otter", "Amber Lynx", "Calm Heron"]);
    expect(input).toEqual(ENTRIES);
  });

  it("puts an ungraded cell with the settled ones", () => {
    const blank = makeEntry({ attemptId: "a5", label: "Quiet Fox", grading: null });
    expect(labels(proposalsFirst([blank, ENTRIES[1]!]))).toEqual(["Bold Raven", "Quiet Fox"]);
  });
});
