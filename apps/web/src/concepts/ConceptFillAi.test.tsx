import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminConcept, ConceptFill } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ConceptSheet } from "./ConceptSheet";

const AVAILABILITY = "GET /app/api/generate/availability";

const heritage: AdminConcept = {
  id: "c0c0c0c0-0000-4000-8000-000000000002",
  status: "proposed",
  mergedInto: null,
  labels: { fr: "Héritage", en: null },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  broader: [],
  related: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  questionCount: 4,
  deletable: false,
  creator: "Marie Dupont",
};
const FILL = `POST /app/api/admin/concepts/${heritage.id}/fill`;

const none = { label: null, taken: null, close: [], description: null };
const proposal: ConceptFill = {
  fr: { ...none, description: "Proposée pour le français." },
  en: { ...none, label: { label: "Inheritance", qualifier: "" }, description: "Proposed for English." },
};

const open = () => renderWithProviders(<ConceptSheet concept={heritage} concepts={[heritage]} byId={new Map([[heritage.id, heritage]])} locale="en" onClose={() => undefined} />);
const side = (name: "French" | "English") => within(screen.getByRole("dialog")).getByRole("group", { name });

describe("Fill with AI on the concept sheet (ADR-081 §7, amendment of 2026-10-13)", () => {
  it("fills only the empty fields, sends the form as it stands, and saves nothing", async () => {
    const { calls } = mockFetch({ [AVAILABILITY]: ok({ available: true, types: [] }), [FILL]: ok(proposal) });
    open();

    const french = side("French");
    await userEvent.type(within(french).getByRole("textbox", { name: /description/i }), "Mine");
    await userEvent.click(await screen.findByRole("button", { name: /fill with ai/i }));

    const english = side("English");
    await waitFor(() => expect(within(english).getByRole("textbox", { name: /^label/i })).toHaveValue("Inheritance"));
    expect(within(english).getByRole("textbox", { name: /description/i })).toHaveValue("Proposed for English.");
    // Typed by the admin: never overwritten.
    expect(within(french).getByRole("textbox", { name: /description/i })).toHaveValue("Mine");
    expect(within(french).getByRole("textbox", { name: /^label/i })).toHaveValue("Héritage");

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      fr: { label: "Héritage", qualifier: "", description: "Mine" },
      en: { label: "", qualifier: "", description: "" },
    });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(screen.getByText(/check them, then save/i)).toBeInTheDocument();
  });

  it("leaves a taken label empty and says which concept it names", async () => {
    const taken: ConceptFill = {
      fr: none,
      en: { ...none, label: { label: "Inheritance", qualifier: "" }, taken: { id: "c0c0c0c0-0000-4000-8000-000000000009", label: "Inheritance", qualifier: "", status: "validated" } },
    };
    mockFetch({ [AVAILABILITY]: ok({ available: true, types: [] }), [FILL]: ok(taken) });
    open();

    await userEvent.click(await screen.findByRole("button", { name: /fill with ai/i }));
    expect(await screen.findByText(/already a label of “Inheritance”: a probable duplicate/)).toBeInTheDocument();
    expect(within(side("English")).getByRole("textbox", { name: /^label/i })).toHaveValue("");
  });

  it("says why the model failed", async () => {
    mockFetch({ [AVAILABILITY]: ok({ available: true, types: [] }), [FILL]: fail(502, { error: "llm_failed" }) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: /fill with ai/i }));
    expect(await screen.findByText(/could not fill the concept/i)).toBeInTheDocument();
  });

  it("is not offered without a model", async () => {
    const { calls } = mockFetch({ [AVAILABILITY]: ok({ available: false, types: [] }) });
    open();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/generate/availability"))).toBe(true));
    expect(screen.queryByRole("button", { name: /fill with ai/i })).toBeNull();
  });
});
