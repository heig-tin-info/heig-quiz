import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Concept } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { ConceptPicker } from "./ConceptPicker";

/*
 * The concept field of the question editor (ADR-081 §5, third addendum §5):
 * the pool's concepts first, homonyms told apart by their qualifier, the
 * keyboard of the tag field, and creation as a deliberate step whose
 * refusals are said in place.
 */

let seq = 0;
const concept = (
  fr: string | null,
  en: string | null,
  over: Partial<Pick<Concept, "status" | "qualifiers" | "descriptions">> = {},
): Concept => ({
  id: `c0c0c0c0-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`,
  status: "validated",
  mergedInto: null,
  labels: { fr, en },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  ...over,
});

const array = concept("Tableau", "Array", {
  descriptions: { fr: "", en: "Elements of one type, contiguous in memory." },
});
const pointer = concept("Pointeur", "Pointer");
const memoryAddress = concept("Adresse", "Address", {
  qualifiers: { fr: "mémoire", en: "memory" },
});
const networkAddress = concept("Adresse", "Address", {
  qualifiers: { fr: "réseau", en: "network" },
});
const recursion = concept("Récursivité", null, { status: "proposed" });
const VOCABULARY = [array, pointer, memoryAddress, networkAddress, recursion];

/** The picker with its value held, as the editor will hold it. */
function Harness({
  initial,
  pool,
  onChange,
}: {
  initial: string[];
  pool?: string[];
  onChange: (ids: string[]) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ConceptPicker
      value={value}
      poolConceptIds={pool}
      onChange={(ids) => {
        setValue(ids);
        onChange(ids);
      }}
    />
  );
}

function setup({
  initial = [],
  pool,
  create,
  locale,
}: {
  initial?: string[];
  pool?: string[];
  create?: RouteHandler;
  locale?: "en" | "fr";
} = {}) {
  const onChange = vi.fn();
  // The server's list holds what it created since.
  const created: Concept[] = [];
  const { calls } = mockFetch({
    "GET /app/api/concepts": () => ok({ concepts: [...VOCABULARY, ...created] }),
    ...(create
      ? {
          "POST /app/api/concepts": (call) => {
            const reply = typeof create === "function" ? create(call) : create;
            if (reply.status === 201) created.push(reply.body as Concept);
            return reply;
          },
        }
      : {}),
  });
  renderWithProviders(<Harness initial={initial} pool={pool} onChange={onChange} />, { locale });
  return { onChange, calls, user: userEvent.setup() };
}

const combobox = () => screen.getByRole("combobox");
const optionTexts = async () => (await screen.findAllByRole("option")).map((o) => o.textContent);

describe("ConceptPicker", () => {
  it("offers the concepts the pool already uses first, marked as such", async () => {
    const { user } = setup({ pool: [pointer.id] });
    await user.click(combobox());
    const texts = await optionTexts();
    expect(texts[0]).toBe("Pointerin this pool");
    // The rest: validated before proposed, then by name.
    expect(texts.slice(1)).toEqual([
      "Address (memory)",
      "Address (network)",
      "ArrayElements of one type, contiguous in memory.",
      "Récursivitéproposed",
    ]);
  });

  it("tells homonyms apart by their qualifier, in the reader's language", async () => {
    const { user } = setup({ locale: "fr" });
    await user.type(combobox(), "adresse");
    const texts = await optionTexts();
    expect(texts.slice(0, 2)).toEqual(["Adresse (mémoire)", "Adresse (réseau)"]);
    // Two exact matches: nothing to create.
    expect(texts.some((x) => x?.startsWith("Créer"))).toBe(false);
  });

  it("falls back to the other language for a label the reader's language lacks", async () => {
    const { user } = setup({ initial: [recursion.id] });
    // The chip of a proposed concept, in French, the only label it has.
    const chip = (await screen.findByText("Récursivité")).closest("[data-status]")!;
    expect(chip).toHaveAttribute("data-status", "proposed");
    expect(chip.querySelector("[lang=fr]")).not.toBeNull();
    await user.click(combobox());
  });

  it("picks with the arrows and Enter, and Backspace removes the last chip", async () => {
    const { user, onChange } = setup({ initial: [pointer.id] });
    await user.click(combobox());
    await screen.findAllByRole("option");
    await user.keyboard("{ArrowDown}");
    expect(combobox()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[1]!.id);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([pointer.id, networkAddress.id]);
    // The picked concept leaves the list; the list stays open for another.
    expect(await optionTexts()).not.toContain("Address (network)");

    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenLastCalledWith([pointer.id]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("removes a chip with its button", async () => {
    const { user, onChange } = setup({ initial: [pointer.id, array.id] });
    await user.click(await screen.findByRole("button", { name: "Remove the concept Pointer" }));
    expect(onChange).toHaveBeenLastCalledWith([array.id]);
  });

  it("creates a proposed concept in the interface language and picks it", async () => {
    const made = concept(null, "Linked list", {
      status: "proposed",
      qualifiers: { fr: "", en: "data" },
    });
    const { user, onChange, calls } = setup({
      create: () => ({ status: 201, body: made }),
    });
    await user.type(combobox(), "linked list (data)");
    const create = await screen.findByRole("option", {
      name: "Create “linked list (data)”",
    });
    await user.click(create);

    // The typed qualifier is split off into its own field.
    expect(screen.getByLabelText("Label")).toHaveValue("linked list");
    expect(screen.getByLabelText("Qualifier")).toHaveValue("data");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([made.id]));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      lang: "en",
      label: "linked list",
      qualifier: "data",
    });
    expect(screen.queryByLabelText("Label")).toBeNull();
    expect(await screen.findByText("Linked list")).toBeInTheDocument();
  });

  it("picks the existing concept when the label is taken (409 concept_exists), and says so", async () => {
    const { user, onChange } = setup({
      create: fail(409, {
        error: "concept_exists",
        message: "A concept with this label already exists",
        concept: pointer,
      }),
    });
    await user.type(combobox(), "pointr");
    await user.click(await screen.findByRole("option", { name: "Create “pointr”" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([pointer.id]));
    expect(screen.getByRole("status")).toHaveTextContent("“Pointer” already existed: it was added instead.");
    expect(screen.queryByLabelText("Label")).toBeNull();
  });

  it("refuses a label the admin dropped (422 concept_dropped) in place, without picking anything", async () => {
    const { user, onChange } = setup({
      create: fail(422, {
        error: "concept_dropped",
        message: "dropped",
        errors: [{ input: "c01", error: "concept_dropped", reason: "organisational" }],
      }),
    });
    await user.type(combobox(), "c01");
    await user.click(await screen.findByRole("option", { name: "Create “c01”" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("An administrator dropped this label");
    expect(onChange).not.toHaveBeenCalled();
    // The form stays, to correct the label or cancel.
    expect(screen.getByLabelText("Label")).toHaveValue("c01");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Label")).toBeNull();
  });

  it("offers no creation while the typed words name a concept", async () => {
    const { user } = setup();
    await user.type(combobox(), "Pointer");
    expect((await optionTexts()).some((x) => x?.startsWith("Create"))).toBe(false);
  });

  it('says a typed concept is already on the question rather than "no match"', async () => {
    const { user } = setup({ initial: [pointer.id] });
    await user.type(combobox(), "pointers");
    expect(await screen.findByText("This concept is already on the question.")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("says a label that cannot be a concept before Create is tried", async () => {
    const { user, calls } = setup({ create: ok() });
    await user.type(combobox(), "--");
    await user.click(await screen.findByRole("option", { name: "Create “--”" }));
    expect(screen.getByText(/it needs a letter or a digit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
