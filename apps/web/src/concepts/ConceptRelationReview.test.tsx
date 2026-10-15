import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminConcept, ConceptRelationCandidates } from "@quiz/contracts";

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
  contained: [{ concept: arithmetic.id, target: pointer.id }],
  together: [{ a: recursion.id, b: stack.id, questions: 3 }],
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

  it("accepts the ticked rows broader first, shows a refusal on its row, and refreshes once", async () => {
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
    await waitFor(() => expect(count(calls, CANDIDATES)).toBe(2));
    expect(count(calls, LIST)).toBe(2);
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
