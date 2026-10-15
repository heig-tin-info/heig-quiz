import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminConcept, ConceptRelationCandidates, ConceptRelationProposals } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ConceptQueue } from "./ConceptQueue";

const LIST = "GET /app/api/admin/concepts";
const CANDIDATES = "GET /app/api/admin/concepts/relations/candidates";

const concept = (n: number, en: string, extra: Partial<AdminConcept> = {}): AdminConcept => ({
  id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status: "validated",
  mergedInto: null,
  labels: { fr: en, en },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  broader: [],
  related: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  questionCount: 4,
  deletable: false,
  creator: null,
  ...extra,
});

const pointer = concept(1, "Pointer");
const arithmetic = concept(2, "Pointer arithmetic");
const recursion = concept(3, "Recursion");
const stack = concept(4, "Stack");
const all = [pointer, arithmetic, recursion, stack];

const candidates: ConceptRelationCandidates = {
  candidates: [
    { kind: "broader", concept: arithmetic.id, target: pointer.id, questions: null },
    { kind: "related", concept: recursion.id, target: stack.id, questions: 3 },
  ],
};

const BROADER = /pointer arithmetic under pointer/i;
const RELATED = /recursion related to stack/i;

async function openRelations() {
  renderWithProviders(<ConceptQueue />);
  await userEvent.click(await screen.findByRole("radio", { name: /^relations$/i }));
  return screen.findByRole("checkbox", { name: BROADER });
}

const count = (calls: { method: string; url: string }[], route: string) =>
  calls.filter((c) => `${c.method} ${c.url}` === route).length;

describe("the Relations view of the curation queue (ADR-114)", () => {
  it("lists the candidates in their sections, nothing checked, no bar, and no Validate", async () => {
    const { calls } = mockFetch({ [LIST]: ok({ concepts: [...all, concept(5, "Heap", { status: "proposed" })] }), [CANDIDATES]: ok(candidates) });
    await openRelations();

    const contained = screen.getByRole("region", { name: /label inside another/i });
    expect(within(contained).getByRole("checkbox", { name: BROADER })).not.toBeChecked();
    const together = screen.getByRole("region", { name: /used together/i });
    expect(within(together).getByRole("checkbox", { name: RELATED })).not.toBeChecked();
    expect(within(together).getByText("Used together on 3 questions")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /selected/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^validate/i })).toBeNull();
    expect(count(calls, CANDIDATES)).toBe(1);
  });

  it("accepts the ticked rows broader first, shows a refusal on its row, and refreshes the vocabulary once", async () => {
    const cycle = {
      error: "concept_cycle",
      message: "This would make a concept broader than itself",
      path: [arithmetic, pointer, arithmetic].map((c) => ({ id: c.id, label: c.labels.en, qualifier: "", status: c.status })),
    };
    const { calls } = mockFetch({
      [LIST]: ok({ concepts: all }),
      [CANDIDATES]: ok(candidates),
      [`POST /app/api/admin/concepts/${arithmetic.id}/relations`]: fail(409, cycle),
      [`POST /app/api/admin/concepts/${recursion.id}/relations`]: ok(recursion),
    });
    await openRelations();

    await userEvent.click(screen.getByRole("checkbox", { name: RELATED }));
    await userEvent.click(screen.getByRole("checkbox", { name: BROADER }));
    expect(screen.getByRole("region", { name: "2 selected" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Accept the 2 selected" }));

    await waitFor(() => expect(screen.getByText("Added: 1. Refused: 1.")).toBeInTheDocument());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [c.url, c.body])).toEqual([
      [`/app/api/admin/concepts/${arithmetic.id}/relations`, { kind: "broader", target: pointer.id }],
      [`/app/api/admin/concepts/${recursion.id}/relations`, { kind: "related", target: stack.id }],
    ]);
    const row = screen.getByRole("checkbox", { name: BROADER }).closest("li")!;
    expect(within(row).getByText(/pointer arithmetic › pointer › pointer arithmetic/i)).toBeInTheDocument();
    await waitFor(() => expect(count(calls, LIST)).toBe(2));
    // The candidates are not asked again: the rows read their state from the refreshed vocabulary.
    expect(count(calls, CANDIDATES)).toBe(1);
    expect(screen.queryByRole("region", { name: /selected/i })).toBeNull();
  });

  it("reads Added, disabled, for a row whose edge exists", async () => {
    mockFetch({ [LIST]: ok({ concepts: [pointer, concept(2, "Pointer arithmetic", { broader: [pointer.id] }), recursion, stack] }), [CANDIDATES]: ok(candidates) });
    const box = await openRelations();
    expect(box).toBeDisabled();
    expect(within(box.closest("li")!).getByText("Added")).toBeInTheDocument();
  });

  it("dismisses a row until reload, and narrows the rows by the search", async () => {
    const { calls } = mockFetch({ [LIST]: ok({ concepts: all }), [CANDIDATES]: ok(candidates) });
    await openRelations();

    await userEvent.type(screen.getByRole("searchbox", { name: /search a concept/i }), "stack");
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: BROADER })).toBeNull());
    expect(screen.getByRole("checkbox", { name: RELATED })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /dismiss: recursion related to stack/i }));
    expect(screen.queryByRole("checkbox", { name: RELATED })).toBeNull();
    expect(screen.getByText("No relation to propose")).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("the AI proposals of the Relations view (ADR-114 §2)", () => {
  const AVAILABILITY = "GET /app/api/generate/availability";
  const AI = "POST /app/api/admin/concepts/relations/ai";
  const array = concept(5, "Array");
  const queue = concept(6, "Queue");
  const vocabulary = [...all, array, queue];
  const proposals: ConceptRelationProposals = {
    lang: "en",
    asked: [recursion.id, stack.id, array.id, queue.id],
    broader: [
      // The pre-pass lists it already.
      { concept: arithmetic.id, target: pointer.id },
      // Refused once the pre-pass's related pair is ticked.
      { concept: stack.id, target: recursion.id },
      { concept: array.id, target: pointer.id },
    ],
    related: [{ a: queue.id, b: stack.id, reason: "Both hold elements in order." }],
    tops: [{ label: "Data structure", qualifier: "", reason: "They organise data.", narrower: [stack.id, queue.id] }],
    remaining: 3,
    truncated: false,
  };
  const ARRAY = /array under pointer/i;
  const QUEUE = /queue related to stack/i;
  const STACK_TOP = /stack under data structure/i;
  const created = concept(7, "Data structure", { status: "proposed" });

  async function askAi(routes: Parameters<typeof mockFetch>[0] = {}) {
    const mocked = mockFetch({
      [LIST]: ok({ concepts: vocabulary }),
      [CANDIDATES]: ok(candidates),
      [AVAILABILITY]: ok({ available: true, types: [] }),
      [AI]: ok(proposals),
      ...routes,
    });
    await openRelations();
    await userEvent.click(await screen.findByRole("button", { name: "Propose relations with AI" }));
    await screen.findByRole("checkbox", { name: ARRAY });
    return mocked;
  }

  it("is offered only when the platform has a model", async () => {
    mockFetch({ [LIST]: ok({ concepts: vocabulary }), [CANDIDATES]: ok(candidates), [AVAILABILITY]: ok({ available: false, types: [] }) });
    await openRelations();
    await waitFor(() => expect(screen.queryByRole("button", { name: /propose relations with ai/i })).toBeNull());
  });

  it("lists the model's rows apart, once each, with the missing top concepts, and asks again while some remain", async () => {
    const { calls } = await askAi();
    expect(calls.find((c) => `${c.method} ${c.url}` === AI)?.body).toEqual({ exclude: [] });
    const broader = screen.getByRole("region", { name: "Broader concepts proposed by the AI" });
    expect(within(broader).getByRole("checkbox", { name: ARRAY })).not.toBeChecked();
    expect(screen.getAllByRole("checkbox", { name: BROADER })).toHaveLength(1);
    const related = screen.getByRole("region", { name: "Related concepts proposed by the AI" });
    expect(within(related).getByText("Both hold elements in order.")).toBeInTheDocument();
    const tops = screen.getByRole("region", { name: "Missing top concepts" });
    expect(within(tops).getByText("New concept: Data structure")).toBeInTheDocument();
    expect(within(tops).getByText("Proposed")).toBeInTheDocument();
    expect(within(tops).getByText("They organise data.")).toBeInTheDocument();
    expect(within(tops).getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByText(/3 unplaced concepts are still to ask about/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Ask again" }));
    await waitFor(() => expect(count(calls, AI)).toBe(2));
    // Ask again moves past what the page asked about already.
    expect(calls.filter((c) => `${c.method} ${c.url}` === AI).at(-1)?.body).toEqual({ exclude: proposals.asked });
  });

  it("creates the top concept first, then writes the edges broader first, a refusal on its row only", async () => {
    const cycle = {
      error: "concept_cycle",
      path: [array, pointer, array].map((c) => ({ id: c.id, label: c.labels.en, qualifier: "", status: c.status })),
    };
    const { calls } = await askAi({
      "POST /app/api/concepts": ok(created),
      [`POST /app/api/admin/concepts/${array.id}/relations`]: fail(409, cycle),
      [`POST /app/api/admin/concepts/${stack.id}/relations`]: ok(stack),
      [`POST /app/api/admin/concepts/${queue.id}/relations`]: ok(queue),
    });
    await userEvent.click(screen.getByRole("checkbox", { name: QUEUE }));
    await userEvent.click(screen.getByRole("checkbox", { name: STACK_TOP }));
    await userEvent.click(screen.getByRole("checkbox", { name: ARRAY }));
    await userEvent.click(screen.getByRole("button", { name: "Accept the 3 selected" }));

    await waitFor(() => expect(screen.getByText("Added: 2. Refused: 1.")).toBeInTheDocument());
    expect(calls.filter((c) => c.method === "POST" && !c.url.endsWith("/ai")).map((c) => [c.url, c.body])).toEqual([
      ["/app/api/concepts", { lang: "en", label: "Data structure", qualifier: "" }],
      [`/app/api/admin/concepts/${array.id}/relations`, { kind: "broader", target: pointer.id }],
      [`/app/api/admin/concepts/${stack.id}/relations`, { kind: "broader", target: created.id }],
      [`/app/api/admin/concepts/${queue.id}/relations`, { kind: "related", target: stack.id }],
    ]);
    const row = screen.getByRole("checkbox", { name: ARRAY }).closest("li")!;
    expect(within(row).getByText(/array › pointer › array/i)).toBeInTheDocument();
  });

  it("disables a row that conflicts with a ticked one, across the two lists", async () => {
    await askAi();
    const ai = screen.getByRole("checkbox", { name: /stack under recursion/i });
    expect(ai).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: RELATED }));
    expect(ai).toBeDisabled();
    expect(ai).toHaveAccessibleDescription("Conflicts with a selected relation.");
    await userEvent.click(screen.getByRole("checkbox", { name: RELATED }));
    expect(ai).toBeEnabled();
  });

  it("says why the AI could not answer", async () => {
    mockFetch({
      [LIST]: ok({ concepts: vocabulary }),
      [CANDIDATES]: ok(candidates),
      [AVAILABILITY]: ok({ available: true, types: [] }),
      [AI]: fail(429, { error: "llm_budget_exhausted", message: "The AI budget is spent." }),
    });
    await openRelations();
    await userEvent.click(await screen.findByRole("button", { name: "Propose relations with AI" }));
    expect(await screen.findByText("The AI could not propose relations")).toBeInTheDocument();
  });
});
