import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Concept, QuestionMeta } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { MetaPanel } from "./MetaPanel";

/*
 * The concepts of a question in its side panel (ADR-081 third addendum §5):
 * every change of the picker is one PATCH of ids — never labels, never a
 * creation, which is the picker's own step — and a refusal is said under it.
 */

const POINTER = "00000000-0000-4000-8000-0000000000a1";
const ARRAY = "00000000-0000-4000-8000-0000000000a2";
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

function setup(patch: RouteHandler) {
  const { calls } = mockFetch({
    "GET /app/api/concepts": ok({ concepts: [concept(POINTER, "Pointeur", "Pointer"), concept(ARRAY, "Tableau", "Array")] }),
    "PATCH /app/api/questions/q1": patch,
  });
  renderWithProviders(<MetaPanel meta={META} categories={[]} poolName="Programmation C" poolConceptIds={[POINTER]} />);
  return { calls, user: userEvent.setup() };
}

describe("MetaPanel · concepts", () => {
  it("saves the question's concepts as ids when one is picked", async () => {
    const { calls, user } = setup(ok({ ...META }));
    await user.type(screen.getByLabelText("Concepts"), "array");
    await user.click(await screen.findByRole("option", { name: /Array/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ concepts: [POINTER, ARRAY] }),
    );
  });

  it("says a refusal under the picker, and goes back to what the question holds", async () => {
    const { user } = setup(fail(422, { error: "concept_not_found", ids: [ARRAY] }));
    await user.type(screen.getByLabelText("Concepts"), "array");
    await user.click(await screen.findByRole("option", { name: /Array/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("merged or deleted meanwhile");
    expect(screen.queryByRole("button", { name: "Remove the concept Array" })).toBeNull();
  });
});
