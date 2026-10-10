import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminConcept, AdminConceptList } from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { ConceptQueue } from "./ConceptQueue";

const LIST = "GET /app/api/admin/concepts?limit=100&offset=0";

const concept = (n: number, extra: Partial<AdminConcept> = {}): AdminConcept => ({
  id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status: "proposed",
  mergedInto: null,
  labels: { fr: "Recursion", en: "Recursion" },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  questionCount: 0,
  deletable: true,
  creator: "Marie Dupont",
  ...extra,
});

const ready = concept(1);
const halfDone = concept(2, { labels: { fr: "Héritage", en: null }, questionCount: 4, deletable: false });
const validated = concept(3, {
  status: "validated",
  labels: { fr: "Pointer", en: "Pointer" },
  questionCount: 12,
  deletable: false,
  creator: null,
});

const page = (concepts: AdminConcept[], total = concepts.length): AdminConceptList => ({
  concepts,
  total,
  proposed: concepts.filter((c) => c.status === "proposed").length,
});

const validateOf = (c: AdminConcept) => `POST /app/api/admin/concepts/${c.id}/validate`;

describe("the concept curation queue (ADR-081, fifth addendum)", () => {
  it("lists the concepts with their usage, and Validate is the primary action of a proposed one", async () => {
    const { calls } = mockFetch({
      [LIST]: ok(page([ready, halfDone, validated])),
      [validateOf(ready)]: ok({ ...ready, status: "validated" }),
    });
    renderWithProviders(<ConceptQueue />);

    expect(await screen.findByText("Pointer")).toBeInTheDocument();
    expect(screen.getByText("12 questions")).toBeInTheDocument();
    expect(screen.getByText("Unused")).toBeInTheDocument();
    expect(screen.getAllByText(/Proposed by Marie Dupont/)[0]).toBeInTheDocument();
    // A validated concept is edited, never validated again.
    expect(screen.getAllByRole("button", { name: /^validate /i })).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /validate recursion/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/validate"))).toBe(true));
  });

  it("disables Validate for a concept missing a language, and says why", async () => {
    mockFetch({ [LIST]: ok(page([halfDone])) });
    renderWithProviders(<ConceptQueue />);

    const validate = await screen.findByRole("button", { name: /validate héritage/i });
    expect(validate).toBeDisabled();
    expect(screen.getAllByText("English label missing").length).toBeGreaterThan(0);
    expect(validate).toHaveAccessibleDescription(/add an english label/i);
  });

  it("narrows to the concepts to validate and searches by text", async () => {
    mockFetch({
      [LIST]: ok(page([ready, validated])),
      "GET /app/api/admin/concepts?limit=100&offset=0&status=proposed": ok(page([ready])),
      "GET /app/api/admin/concepts?limit=100&offset=0&q=poin": ok(page([validated])),
    });
    renderWithProviders(<ConceptQueue />);
    await screen.findByText("Pointer");

    await userEvent.click(screen.getByRole("radio", { name: /to validate/i }));
    await waitFor(() => expect(screen.queryByText("Pointer")).toBeNull());
    expect(screen.getByText("Recursion")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /^all$/i }));
    await userEvent.type(screen.getByRole("searchbox", { name: /search a concept/i }), "poin");
    expect(await screen.findByText("Pointer")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Recursion")).toBeNull());
  });

  it("deletes an unused concept from its sheet, after a confirmation", async () => {
    const { calls } = mockFetch({
      [LIST]: ok(page([ready])),
      [`DELETE /app/api/admin/concepts/${ready.id}`]: noContent(),
    });
    renderWithProviders(<ConceptQueue />);

    await userEvent.click(await screen.findByRole("button", { name: /edit recursion/i }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(within(sheet).getByRole("button", { name: /delete concept/i }));
    const confirm = await screen.findByRole("dialog", { name: /delete recursion/i });
    await userEvent.click(within(confirm).getByRole("button", { name: /delete concept/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("offers no deletion while a question uses the concept, and says so", async () => {
    mockFetch({ [LIST]: ok(page([validated])) });
    renderWithProviders(<ConceptQueue />);

    await userEvent.click(await screen.findByRole("button", { name: /edit pointer/i }));
    const sheet = await screen.findByRole("dialog");
    const remove = within(sheet).getByRole("button", { name: /delete concept/i });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(/12 questions use this concept/i);
  });

  it("saves only what changed, filling the missing language", async () => {
    const { calls } = mockFetch({
      [LIST]: ok(page([halfDone])),
      [`PATCH /app/api/concepts/${halfDone.id}`]: ok({ ...halfDone, labels: { fr: "Héritage", en: "Inheritance" } }),
    });
    renderWithProviders(<ConceptQueue />);

    await userEvent.click(await screen.findByRole("button", { name: /edit héritage/i }));
    const sheet = await screen.findByRole("dialog");
    const save = within(sheet).getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();
    const english = within(sheet).getByRole("group", { name: "English" });
    await userEvent.type(within(english).getByRole("textbox", { name: /label/i }), "Inheritance");
    await userEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ en: { label: "Inheritance" } }));
  });

  it("tells a taken label from any other failure", async () => {
    mockFetch({
      [LIST]: ok(page([halfDone])),
      [`PATCH /app/api/concepts/${halfDone.id}`]: fail(409, { error: "concept_exists" }),
    });
    renderWithProviders(<ConceptQueue />);

    await userEvent.click(await screen.findByRole("button", { name: /edit héritage/i }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.type(within(within(sheet).getByRole("group", { name: "English" })).getByRole("textbox", { name: /label/i }), "Inheritance");
    await userEvent.click(within(sheet).getByRole("button", { name: /^save$/i }));
    expect(await within(sheet).findByText(/another concept already has this label/i)).toBeInTheDocument();
  });

  it("has an empty state, a done state and an error state", async () => {
    mockFetch({
      [LIST]: ok(page([])),
      "GET /app/api/admin/concepts?limit=100&offset=0&status=proposed": ok(page([])),
    });
    renderWithProviders(<ConceptQueue />);
    expect(await screen.findByText("No concepts yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /to validate/i }));
    expect(await screen.findByText("Nothing left to validate")).toBeInTheDocument();
  });

  it("shows the failure of the list", async () => {
    mockFetch({ [LIST]: fail(500, { message: "boom" }) });
    renderWithProviders(<ConceptQueue />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
