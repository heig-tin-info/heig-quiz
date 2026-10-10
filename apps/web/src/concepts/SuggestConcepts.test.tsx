import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Concept, ConceptSuggestions, QuestionMeta } from "@quiz/contracts";

import { MetaPanel } from "../question/MetaPanel";
import { fail, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { SuggestConcepts } from "./SuggestConcepts";

/*
 * "Suggest concepts" (ADR-081 sixth addendum §6), the editor's AI card button
 * (the card's own tests are in `QuestionEditor.test.tsx`): the draft sent as
 * it stands, the ticked concepts added through the question's own concept
 * write, and a new label handed to the picker's create form, never created on
 * its own.
 */

const POINTER = "00000000-0000-4000-8000-0000000000a1";
const ARRAY = "00000000-0000-4000-8000-0000000000a2";
const HEAP = "00000000-0000-4000-8000-0000000000a3";
const concept = (id: string, fr: string, en: string): Concept => ({
  id,
  status: "validated",
  mergedInto: null,
  labels: { fr, en },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
});

const META: QuestionMeta = {
  id: "q1",
  poolId: "p1",
  type: "mcq",
  internalName: "ptr-null-check",
  categoryId: null,
  difficulty: 2,
  shuffleable: true,
  randomizable: false,
  concepts: [{ id: POINTER, label: "Pointer", qualifier: "", status: "validated" }],
  createdBy: "u-me",
  originQuestionId: null,
  deletedAt: null,
  updatedAt: "2026-09-01T08:00:00.000Z",
};
const DRAFT = { prompt: "What does *p hold?" };

const SUGGESTIONS: ConceptSuggestions = {
  existing: [
    { concept: { id: ARRAY, label: "Array", qualifier: "", status: "validated" }, reason: "Elements are indexed." },
    {
      concept: { id: HEAP, label: "Heap", qualifier: "", status: "validated" },
      reason: "Allocation is hinted at.",
      asked: { label: "Memory allocation", qualifier: "" },
    },
  ],
  created: [{ label: "Address", qualifier: "postal", reason: "The central idea is missing." }],
};

function setup(suggest: RouteHandler | ReturnType<typeof ok> = ok(SUGGESTIONS)) {
  const onCreate = vi.fn();
  const { calls } = mockFetch({
    "POST /app/api/questions/q1/suggest-concepts": suggest,
    "PATCH /app/api/questions/q1": ok({ ...META }),
  });
  renderWithProviders(<SuggestConcepts meta={META} config={DRAFT} onCreate={onCreate} />);
  return { calls, onCreate, user: userEvent.setup() };
}

describe("SuggestConcepts", () => {
  it("sends the draft as it stands, lists the suggestions unticked, and adds the ticked ones to the question's", async () => {
    const { calls, user } = setup();
    await user.click(screen.getByRole("button", { name: "Suggest concepts" }));
    expect(await screen.findByText("Elements are indexed.")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ config: DRAFT });
    expect(screen.getByText(/Suggested “Memory allocation”; did you mean this one\?/)).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Add 0 selected" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Array/ }));
    await user.click(screen.getByRole("button", { name: "Add 1 selected" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ concepts: [POINTER, ARRAY] }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hands a new label, with its qualifier, to the editor and creates nothing", async () => {
    const { calls, onCreate, user } = setup();
    await user.click(screen.getByRole("button", { name: "Suggest concepts" }));
    await user.click(await screen.findByRole("button", { name: "Create…" }));
    expect(onCreate).toHaveBeenCalledWith({ label: "Address", qualifier: "postal" });
    expect(calls.some((c) => c.method === "PATCH" || c.url === "/app/api/concepts")).toBe(false);
  });

  it("says when nothing fits", async () => {
    const { user } = setup(ok({ existing: [], created: [] }));
    await user.click(screen.getByRole("button", { name: "Suggest concepts" }));
    expect(await screen.findByText("No concept to suggest for this question.")).toBeInTheDocument();
  });

  it("words a refusal and asks again on Retry", async () => {
    const { calls, user } = setup(fail(429, { error: "llm_budget_exhausted", reason: "budget_exhausted" }));
    await user.click(screen.getByRole("button", { name: "Suggest concepts" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
  });
});

describe("MetaPanel · a suggested new concept", () => {
  it("opens the picker's create form with the label and qualifier, and creates nothing by itself", async () => {
    const { calls } = mockFetch({ "GET /app/api/concepts": ok({ concepts: [concept(POINTER, "Pointeur", "Pointer")] }) });
    renderWithProviders(
      <MetaPanel meta={META} categories={[]} poolName="C" conceptPrefill={{ label: "Address", qualifier: "postal" }} />,
    );
    expect(await screen.findByLabelText("Label")).toHaveValue("Address");
    expect(screen.getByLabelText(/Qualifier/)).toHaveValue("postal");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});
