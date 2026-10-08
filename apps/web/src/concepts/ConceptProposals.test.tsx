import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Concept, ConceptSortRun, TagSorting, TagSortingProposal, TagSortingRow } from "@quiz/contracts";

import { ConceptsSection } from "./ConceptsSection";
import { RUN_POLL_MS } from "./ProposeAction";
import { fail, mockFetch, ok, renderWithProviders, type RecordedCall } from "../test/render";

const LIST = "GET /app/api/admin/concept-sorting";
const CONCEPTS = "GET /app/api/concepts";
const ACCEPT = "POST /app/api/admin/concept-sorting/accept";
const AVAILABILITY = "GET /app/api/generate/availability";
const RUN = "GET /app/api/admin/concept-sorting/run";
const PROPOSE = "POST /app/api/admin/concept-sorting/propose";

const INFO1 = "c0a1b2c3-0000-4000-8000-0000000000a1";
const PROGC = "c0a1b2c3-0000-4000-8000-0000000000c1";

const pointer: Concept = {
  id: "c0c0c0c0-0000-4000-8000-000000000001",
  status: "validated",
  mergedInto: null,
  labels: { fr: "Pointeur", en: "Pointer" },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
};

const proposed = (proposal: TagSortingProposal, over: Partial<TagSorting> = {}): TagSorting => ({
  decision: null,
  concept: null,
  dropReason: null,
  proposal,
  decidedBy: null,
  decidedAt: null,
  ...over,
});

const row = (poolId: string, poolName: string, tag: string, group: string, sorting: TagSorting | null = null): TagSortingRow => ({
  poolId,
  poolName,
  tag,
  count: 3,
  description: "",
  excerpts: [],
  group,
  sorting,
});

const MODEL = "claude-haiku-4-5";
const toPointer = proposed({ kind: "concept", conceptId: pointer.id, model: MODEL, note: "Plural of an existing concept." });
const ROWS = [
  row(INFO1, "Info1", "pointeurs", "pointeur", toPointer),
  row(PROGC, "Prog C — C10", "pointeur", "pointeur", toPointer),
  row(INFO1, "Info1", "lecture-de-code", "lecture-code", proposed({ kind: "drop", dropReason: "task_kind", model: MODEL })),
  row(
    INFO1,
    "Info1",
    "récursivité",
    "recursivite",
    proposed({
      kind: "new",
      model: MODEL,
      newConcept: {
        fr: { label: "Récursivité", qualifier: "", description: "Une fonction qui s'appelle." },
        en: { label: "Recursion", qualifier: "", description: "" },
      },
    }),
  ),
];

const acceptBody = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST").at(-1)?.body;
const bar = () => screen.getByRole("region", { name: /selected/i });
const llm = (available: boolean) => ok({ available, types: [] });

describe("the concepts tab: the model's proposals (ADR-081, second addendum §3)", () => {
  afterEach(() => vi.useRealTimers());

  it("shows each proposal as a suggested pending decision, accepted with the very payload", async () => {
    const { calls } = mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [CONCEPTS]: ok({ concepts: [pointer] }),
      [ACCEPT]: ok({ rows: [], created: [] }),
    });
    renderWithProviders(<ConceptsSection />);

    expect(await screen.findAllByText("Suggested by the model: Pointer")).toHaveLength(2);
    expect(screen.getByText("Suggested by the model: Drop · Kind of task")).toBeInTheDocument();
    expect(screen.getByText("Suggested by the model: New: Récursivité")).toBeInTheDocument();
    // The model's note, beside its proposal.
    expect(screen.getAllByText("Plural of an existing concept.")).toHaveLength(2);

    // A group whose pairs all carry a proposal is ready at once.
    await userEvent.click(screen.getByRole("checkbox", { name: "Select every tag of pointeur" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select every tag of recursivite" }));
    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(3\)/i }));
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [
          { poolId: INFO1, tag: "pointeurs", decision: { kind: "concept", conceptId: pointer.id } },
          { poolId: PROGC, tag: "pointeur", decision: { kind: "concept", conceptId: pointer.id } },
          {
            poolId: INFO1,
            tag: "récursivité",
            decision: {
              kind: "new",
              fr: { label: "Récursivité", qualifier: "", description: "Une fonction qui s'appelle." },
              en: { label: "Recursion", qualifier: "", description: "" },
            },
          },
        ],
      }),
    );
  });

  it("shows no proposal on an accepted row, nor one naming a concept the vocabulary lacks", async () => {
    const done = { ...ROWS[2]!, sorting: { ...ROWS[2]!.sorting!, decision: "drop" as const, dropReason: "noise" as const } };
    mockFetch({ [LIST]: ok({ rows: [ROWS[0]!, done] }), [CONCEPTS]: ok({ concepts: [] }) });
    renderWithProviders(<ConceptsSection />);
    await userEvent.click(await screen.findByRole("radio", { name: "All" }));
    expect(screen.getByText("Drop · Noise")).toBeInTheDocument();
    expect(screen.queryByText(/suggested by the model/i)).toBeNull();
    expect(screen.getAllByText("Not sorted")).toHaveLength(1);
  });

  it("lets the admin's decision override a proposal; clearing it brings the proposal back, clearing that dismisses it", async () => {
    const { calls } = mockFetch({
      [LIST]: ok({ rows: [ROWS[2]!] }),
      [ACCEPT]: ok({ rows: [], created: [] }),
    });
    renderWithProviders(<ConceptsSection />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select lecture-de-code in Info1" }));
    await userEvent.click(within(bar()).getByRole("button", { name: /^drop$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /noise/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^drop$/i }));
    expect(screen.getByText("To accept: Drop · Noise")).toBeInTheDocument();
    expect(screen.queryByText(/suggested by the model/i)).toBeNull();

    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(1\)/i }));
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [{ poolId: INFO1, tag: "lecture-de-code", decision: { kind: "drop", reason: "noise" } }],
      }),
    );

    const clear = () => userEvent.click(screen.getByRole("button", { name: "Clear the decision for lecture-de-code" }));
    await clear();
    expect(screen.getByText("Suggested by the model: Drop · Kind of task")).toBeInTheDocument();
    await clear();
    expect(screen.queryByText(/suggested by the model/i)).toBeNull();
    expect(screen.getByText("Not sorted")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: /accept \(0\)/i })).toBeDisabled();
  });

  it("hides Propose with AI when the platform has no model", async () => {
    mockFetch({ [LIST]: ok({ rows: ROWS }), [AVAILABILITY]: llm(false) });
    renderWithProviders(<ConceptsSection />);
    await screen.findByText("pointeurs");
    await waitFor(() => expect(screen.queryByRole("button", { name: /propose with ai/i })).toBeNull());
  });

  it("starts a run, shows its progress, and reads the list again when it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = (groupsDone: number): ConceptSortRun => ({
      state: "running",
      groupsDone,
      groupsTotal: 3,
      batchesFailed: 0,
      startedAt: "2026-10-08T08:00:00.000Z",
      finishedAt: null,
      error: null,
    });
    const polls = [running(2), { ...running(3), state: "done" as const, batchesFailed: 1, finishedAt: "2026-10-08T08:01:00.000Z" }];
    let reads = 0;
    const { calls } = mockFetch({
      [LIST]: () => ((reads += 1) === 1 ? ok({ rows: [row(INFO1, "Info1", "c01", "c01")] }) : ok({ rows: [row(INFO1, "Info1", "c01", "c01", proposed({ kind: "drop", dropReason: "organisational", model: MODEL }))] })),
      [AVAILABILITY]: llm(true),
      [RUN]: () => ok({ run: calls.some((c) => c.method === "POST") ? (polls.shift() ?? null) : null }),
      [PROPOSE]: ok({ run: running(0) }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<ConceptsSection />);

    await user.click(await screen.findByRole("button", { name: /propose with ai/i }));
    expect(await screen.findByText("Proposing… 0 / 3 groups")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RUN_POLL_MS));
    expect(await screen.findByText("Proposing… 2 / 3 groups")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RUN_POLL_MS));
    expect(await screen.findByText("Proposals ready; 1 batch got none, run again to retry it")).toBeInTheDocument();
    expect(await screen.findByText("Suggested by the model: Drop · Organisational label")).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it("shows a fresh proposal again after the admin dismissed an older one", async () => {
    let reads = 0;
    const second = proposed({ kind: "drop", dropReason: "noise", model: MODEL });
    mockFetch({ [LIST]: () => ok({ rows: [(reads += 1) === 1 ? ROWS[2]! : { ...ROWS[2]!, sorting: second }] }) });
    const { queryClient } = renderWithProviders(<ConceptsSection />);
    await screen.findByText("Suggested by the model: Drop · Kind of task");
    await userEvent.click(screen.getByRole("button", { name: "Clear the decision for lecture-de-code" }));
    expect(screen.getByText("Not sorted")).toBeInTheDocument();

    // A new run proposes something else: it shows.
    await act(() => queryClient.invalidateQueries());
    expect(await screen.findByText("Suggested by the model: Drop · Noise")).toBeInTheDocument();
  });

  it("words why a run failed, and toasts a refused start", async () => {
    const failed: ConceptSortRun = {
      state: "failed",
      groupsDone: 1,
      groupsTotal: 4,
      batchesFailed: 0,
      startedAt: "2026-10-08T08:00:00.000Z",
      finishedAt: "2026-10-08T08:01:00.000Z",
      error: "budget_exhausted",
    };
    mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [AVAILABILITY]: llm(true),
      [RUN]: ok({ run: failed }),
      [PROPOSE]: fail(409, { error: "llm_not_configured", reason: "not_configured" }),
    });
    renderWithProviders(<ConceptsSection />);
    expect(await screen.findByText("The proposal stopped: today's spending cap is reached.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /propose with ai/i }));
    expect(await screen.findByText("The AI is not set up on this platform yet.")).toBeInTheDocument();
  });

  it("shows the run already going when the start answers concept_sort_running", async () => {
    let started = false;
    mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [AVAILABILITY]: llm(true),
      [RUN]: () =>
        ok({
          run: started
            ? { state: "running", groupsDone: 1, groupsTotal: 5, batchesFailed: 0, startedAt: "2026-10-08T08:00:00.000Z", finishedAt: null, error: null }
            : null,
        }),
      [PROPOSE]: () => {
        started = true;
        return fail(409, { error: "concept_sort_running" });
      },
    });
    renderWithProviders(<ConceptsSection />);
    await userEvent.click(await screen.findByRole("button", { name: /propose with ai/i }));
    expect(await screen.findByText("Proposing… 1 / 5 groups")).toBeInTheDocument();
  });
});
