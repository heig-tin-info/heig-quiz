import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Concept, ConceptSuggestions, QuestionMeta } from "@quiz/contracts";

import { MetaPanel } from "../question/MetaPanel";
import { fail, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";

/*
 * "Suggest concepts" (ADR-081 sixth addendum §6) in the question editor's
 * Properties panel: absent without a model, the draft sent as it stands, the
 * ticked concepts added through the question's own concept write, and a new
 * label handed to the picker's create form, never created on its own.
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
    { concept: { id: HEAP, label: "Heap", qualifier: "", status: "validated" }, reason: "Allocation is hinted at.", asked: "Memory allocation" },
  ],
  created: [{ label: "Dereferencing", reason: "The central idea is missing." }],
};

function setup({ available = true, suggest = ok(SUGGESTIONS) as RouteHandler | ReturnType<typeof ok> } = {}) {
  const { calls } = mockFetch({
    "GET /app/api/generate/availability": ok({ available, types: ["mcq"] }),
    "GET /app/api/concepts": ok({
      concepts: [concept(POINTER, "Pointeur", "Pointer"), concept(ARRAY, "Tableau", "Array"), concept(HEAP, "Tas", "Heap")],
    }),
    "POST /app/api/questions/q1/suggest-concepts": suggest,
    "PATCH /app/api/questions/q1": ok({ ...META }),
  });
  renderWithProviders(<MetaPanel meta={META} categories={[]} poolName="Programmation C" draftConfig={DRAFT} />);
  return { calls, user: userEvent.setup() };
}

describe("MetaPanel · Suggest concepts", () => {
  it("is absent while the platform has no model", async () => {
    const { calls } = setup({ available: false });
    await screen.findByLabelText("Concepts");
    await waitFor(() => expect(calls.some((c) => c.url === "/app/api/generate/availability")).toBe(true));
    expect(screen.queryByRole("button", { name: "Suggest concepts" })).toBeNull();
  });

  it("sends the draft as it stands, lists the suggestions unticked, and adds the ticked ones to the question's", async () => {
    const { calls, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Suggest concepts" }));
    expect(await screen.findByText("Elements are indexed.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ config: DRAFT });
    expect(screen.getByText(/Suggested “Memory allocation”; did you mean this one\?/)).toBeInTheDocument();

    const add = screen.getByRole("button", { name: "Add 0 selected" });
    expect(add).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Array/ }));
    await user.click(screen.getByRole("button", { name: "Add 1 selected" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ concepts: [POINTER, ARRAY] }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hands a new label to the picker's create form, prefilled, and creates nothing", async () => {
    const { calls, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Suggest concepts" }));
    await user.click(await screen.findByRole("button", { name: "Create…" }));
    expect(await screen.findByLabelText("Label")).toHaveValue("Dereferencing");
    expect(calls.some((c) => c.method === "POST" && c.url === "/app/api/concepts")).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("says when nothing fits", async () => {
    const { user } = setup({ suggest: ok({ existing: [], created: [] }) });
    await user.click(await screen.findByRole("button", { name: "Suggest concepts" }));
    expect(await screen.findByText("No concept to suggest for this question.")).toBeInTheDocument();
  });

  it("words a refusal and offers to retry", async () => {
    const { calls, user } = setup({ suggest: fail(429, { error: "llm_budget_exhausted", reason: "budget_exhausted" }) });
    await user.click(await screen.findByRole("button", { name: "Suggest concepts" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
  });
});
