import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminConcept, AdminConceptList } from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { ConceptQueue } from "./ConceptQueue";

const LIST = "GET /app/api/admin/concepts";

const concept = (n: number, extra: Partial<AdminConcept> = {}): AdminConcept => ({
  id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status: "proposed",
  mergedInto: null,
  labels: { fr: "Recursion", en: "Recursion" },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
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

const page = (concepts: AdminConcept[]): AdminConceptList => ({ concepts });

const validateOf = (c: AdminConcept) => `POST /app/api/admin/concepts/${c.id}/validate`;

describe("the concept curation queue (ADR-081, fifth addendum)", () => {
  it("lists the concepts with their usage, and offers Validate on the proposed ones only", async () => {
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

  it("narrows to the concepts to validate and searches by text, without asking the server again", async () => {
    const { calls } = mockFetch({ [LIST]: ok(page([ready, validated])) });
    renderWithProviders(<ConceptQueue />);
    await screen.findByText("Pointer");

    await userEvent.click(screen.getByRole("radio", { name: /to validate \(1\)/i }));
    await waitFor(() => expect(screen.queryByText("Pointer")).toBeNull());
    expect(screen.getByText("Recursion")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: /^all$/i }));
    await userEvent.type(screen.getByRole("searchbox", { name: /search a concept/i }), "pointe");
    await waitFor(() => expect(screen.queryByText("Recursion")).toBeNull());
    expect(screen.getByText("Pointer")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it("keeps the proposed concepts ahead of the validated ones under a search", async () => {
    const both = concept(4, { labels: { fr: "Pointeur nul", en: "Null pointer" } });
    mockFetch({ [LIST]: ok(page([both, validated])) });
    renderWithProviders(<ConceptQueue />);
    await userEvent.type(await screen.findByRole("searchbox", { name: /search a concept/i }), "pointe");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Null pointer");
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

  it("offers Merge into… instead of Delete while a question uses the concept", async () => {
    mockFetch({ [LIST]: ok(page([validated])) });
    renderWithProviders(<ConceptQueue />);

    await userEvent.click(await screen.findByRole("button", { name: /edit pointer/i }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: /delete concept/i })).toBeNull();
    expect(within(sheet).getByRole("button", { name: /merge into/i })).toBeEnabled();
  });

  it("holds the merge back while the sheet has unsaved edits, and says why", async () => {
    mockFetch({ [LIST]: ok(page([validated])) });
    renderWithProviders(<ConceptQueue />);

    await userEvent.click(await screen.findByRole("button", { name: /edit pointer/i }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.type(within(within(sheet).getByRole("group", { name: "English" })).getByRole("textbox", { name: /label/i }), "s");
    const merge = within(sheet).getByRole("button", { name: /merge into/i });
    expect(merge).toBeDisabled();
    expect(merge).toHaveAccessibleDescription(/save or cancel your edits/i);
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

  describe("the aliases of a concept (ADR-081 §6)", () => {
    const withAlias = concept(6, {
      status: "validated",
      labels: { fr: "Dépassement", en: "Overflow" },
      aliases: ["Débordement"],
      questionCount: 2,
      deletable: false,
    });
    const aliasUrl = (c: AdminConcept) => `/app/api/admin/concepts/${c.id}/aliases`;
    const openSheet = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /edit overflow/i }));
      return screen.findByRole("dialog");
    };

    it("lists the aliases as chips, and removes one by its key", async () => {
      const { calls } = mockFetch({
        [LIST]: ok(page([withAlias])),
        [`DELETE ${aliasUrl(withAlias)}/${encodeURIComponent("Débordement")}`]: ok({ ...withAlias, aliases: [] }),
      });
      renderWithProviders(<ConceptQueue />);
      const sheet = await openSheet();
      const group = within(sheet).getByRole("group", { name: "Aliases" });
      expect(within(group).getByText("Débordement")).toBeInTheDocument();
      await userEvent.click(within(group).getByRole("button", { name: "Remove alias — Débordement" }));
      await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/aliases/${encodeURIComponent("Débordement")}`))).toBe(true));
    });

    it("adds an alias, apart from the labels' Save", async () => {
      const { calls } = mockFetch({
        [LIST]: ok(page([withAlias])),
        [`POST ${aliasUrl(withAlias)}`]: ok({ ...withAlias, aliases: ["Débordement", "Trop-plein"] }),
      });
      renderWithProviders(<ConceptQueue />);
      const sheet = await openSheet();
      const add = within(sheet).getByRole("button", { name: "Add alias" });
      expect(add).toBeDisabled();
      await userEvent.type(within(sheet).getByRole("textbox", { name: "New alias" }), "Trop-plein");
      await userEvent.click(add);
      await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ alias: "Trop-plein" }));
      expect(within(sheet).getByRole("button", { name: /^save$/i })).toBeDisabled();
    });

    it("names the colliding concept and adds only after the admin confirms", async () => {
      const collision = {
        error: "alias_collision",
        collisions: [{ via: "label", concept: { id: validated.id, label: "Pointer", qualifier: "", status: "validated" } }],
      };
      let posts = 0;
      const { calls } = mockFetch({
        [LIST]: ok(page([withAlias, validated])),
        [`POST ${aliasUrl(withAlias)}`]: () =>
          ++posts === 1 ? fail(409, collision) : ok({ ...withAlias, aliases: ["Débordement", "pointers"] }),
      });
      renderWithProviders(<ConceptQueue />);
      const sheet = await openSheet();
      await userEvent.type(within(sheet).getByRole("textbox", { name: "New alias" }), "pointers");
      await userEvent.click(within(sheet).getByRole("button", { name: "Add alias" }));

      const warning = await screen.findByRole("dialog", { name: /already designates another concept/i });
      expect(warning).toHaveTextContent("\u201cpointers\u201d already designates another concept");
      expect(warning).toHaveTextContent("Pointer: its label");
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);

      await userEvent.click(within(warning).getByRole("button", { name: "Add anyway" }));
      await waitFor(() => expect(calls.filter((c) => c.method === "POST")[1]?.body).toEqual({ alias: "pointers", force: true }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /already designates/i })).toBeNull());
    });

    it("says why an alias equal to the label is refused", async () => {
      mockFetch({
        [LIST]: ok(page([withAlias])),
        [`POST ${aliasUrl(withAlias)}`]: fail(422, { error: "alias_redundant" }),
      });
      renderWithProviders(<ConceptQueue />);
      const sheet = await openSheet();
      await userEvent.type(within(sheet).getByRole("textbox", { name: "New alias" }), "overflow");
      await userEvent.click(within(sheet).getByRole("button", { name: "Add alias" }));
      expect(await within(sheet).findByText("This is already a label of the concept.")).toBeInTheDocument();
    });
  });

  describe("merging a concept into a validated one", () => {
    const target = concept(5, { status: "validated", labels: { fr: "Récursion", en: "Recursive call" }, questionCount: 3, deletable: false });
    const mergeOf = (c: AdminConcept) => `POST /app/api/admin/concepts/${c.id}/merge`;

    const openDialog = async (loser: AdminConcept) => {
      await userEvent.click(await screen.findByRole("button", { name: new RegExp(`edit ${loser.labels.en ?? loser.labels.fr}`, "i") }));
      const sheet = await screen.findByRole("dialog");
      await userEvent.click(within(sheet).getByRole("button", { name: /merge into/i }));
      return screen.findByRole("dialog", { name: /merge .* into another concept/i });
    };

    it("offers the validated concepts only, never the concept itself, with both usage counts", async () => {
      mockFetch({ [LIST]: ok(page([halfDone, ready, validated, target])) });
      renderWithProviders(<ConceptQueue />);
      const dialog = await openDialog(halfDone);

      expect(within(dialog).getByText("4 questions")).toBeInTheDocument();
      expect(within(dialog).getByRole("radio", { name: /pointer/i })).toBeInTheDocument();
      expect(within(dialog).getByRole("radio", { name: /recursive call/i })).toBeInTheDocument();
      // A proposed concept cannot absorb another, nor can the concept absorb itself.
      expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
      expect(within(dialog).queryByRole("radio", { name: /recursion/i })).toBeNull();
      expect(within(dialog).getByRole("button", { name: /^merge$/i })).toBeDisabled();
    });

    it("says what happens, then merges and refreshes the queue", async () => {
      const { calls } = mockFetch({
        [LIST]: ok(page([halfDone, validated])),
        [mergeOf(halfDone)]: ok(validated),
      });
      renderWithProviders(<ConceptQueue />);
      const dialog = await openDialog(halfDone);

      await userEvent.click(within(dialog).getByRole("radio", { name: /pointer/i }));
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "The 4 questions that use Héritage will use Pointer. The label Héritage will no longer designate a concept.",
      );
      await userEvent.click(within(dialog).getByRole("checkbox"));
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "The 4 questions that use Héritage will use Pointer. Héritage will remain an alias of Pointer.",
      );
      await userEvent.click(within(dialog).getByRole("checkbox"));
      await userEvent.click(within(dialog).getByRole("button", { name: /^merge$/i }));
      await waitFor(() => expect(calls.find((c) => c.url.endsWith("/merge"))?.body).toEqual({ into: validated.id, keepAsAlias: false }));
      // The queue is read again: the merged concept is gone from the next answer.
      await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/admin/concepts")).length).toBeGreaterThan(1));
    });

    it("drops the merged label by default, and keeps it as an alias when asked", async () => {
      const { calls } = mockFetch({
        [LIST]: ok(page([halfDone, validated])),
        [mergeOf(halfDone)]: ok(validated),
      });
      renderWithProviders(<ConceptQueue />);
      const dialog = await openDialog(halfDone);
      expect(within(dialog).queryByRole("checkbox")).toBeNull();
      await userEvent.click(within(dialog).getByRole("radio", { name: /pointer/i }));
      const keep = within(dialog).getByRole("checkbox", { name: "Keep Héritage as an alias of Pointer" });
      expect(keep).not.toBeChecked();
      await userEvent.click(keep);
      await userEvent.click(within(dialog).getByRole("button", { name: /^merge$/i }));
      await waitFor(() => expect(calls.find((c) => c.url.endsWith("/merge"))?.body).toEqual({ into: validated.id, keepAsAlias: true }));
    });

    it("searches the targets with the picker's rule", async () => {
      mockFetch({ [LIST]: ok(page([halfDone, validated, target])) });
      renderWithProviders(<ConceptQueue />);
      const dialog = await openDialog(halfDone);

      await userEvent.type(within(dialog).getByRole("searchbox", { name: /search a validated concept/i }), "pointe");
      await waitFor(() => expect(within(dialog).queryByRole("radio", { name: /recursive call/i })).toBeNull());
      expect(within(dialog).getByRole("radio", { name: /pointer/i })).toBeInTheDocument();
      await userEvent.clear(within(dialog).getByRole("searchbox"));
      await userEvent.type(within(dialog).getByRole("searchbox"), "zzzz");
      expect(await within(dialog).findByText("No validated concept matches")).toBeInTheDocument();
    });

    it("shows a refusal and keeps the dialog open", async () => {
      mockFetch({
        [LIST]: ok(page([halfDone, validated])),
        [mergeOf(halfDone)]: fail(409, { error: "concept_merged" }),
      });
      renderWithProviders(<ConceptQueue />);
      const dialog = await openDialog(halfDone);
      await userEvent.click(within(dialog).getByRole("radio", { name: /pointer/i }));
      await userEvent.click(within(dialog).getByRole("button", { name: /^merge$/i }));
      expect(await within(dialog).findByText(/merged in the meantime/i)).toBeInTheDocument();
    });
  });

  describe("probable duplicates", () => {
    const pointer = concept(10, { status: "validated", labels: { fr: "Allocation dynamique", en: "Dynamic allocation" }, questionCount: 5, deletable: false, aliases: ["Tas"] });
    const typo = concept(11, { labels: { fr: "Alocation dynamique", en: null }, questionCount: 2, deletable: false });
    const heap = concept(12, { labels: { fr: "Tas", en: "Heap" } });
    const hash = concept(13, { labels: { fr: "Hash table", en: null } });
    const hashEn = concept(14, { labels: { fr: null, en: "Hash table" } });
    const memory = concept(15, { status: "validated", labels: { fr: "Adresse", en: "Address" }, qualifiers: { fr: "mémoire", en: "memory" }, deletable: false });
    const network = concept(16, { status: "validated", labels: { fr: "Adresse", en: "Address" }, qualifiers: { fr: "réseau", en: "network" }, deletable: false });
    const all = [pointer, typo, heap, hash, hashEn, memory, network, ready];
    const mergeOf = (c: AdminConcept) => `POST /app/api/admin/concepts/${c.id}/merge`;

    const open = async () => {
      renderWithProviders(<ConceptQueue />);
      await userEvent.click(await screen.findByRole("radio", { name: /^duplicates/i }));
    };

    it("counts the pairs on the filter and says why each pair is listed", async () => {
      mockFetch({ [LIST]: ok(page(all)) });
      await open();
      expect(screen.getByRole("radio", { name: /^duplicates \(4\)/i })).toBeChecked();
      for (const badge of ["Alias clash", "Translation", "Close labels", "Same label"]) {
        expect(screen.getByText(badge)).toBeInTheDocument();
      }
    });

    it("opens the merge with the other concept already chosen", async () => {
      const { calls } = mockFetch({ [LIST]: ok(page(all)), [mergeOf(typo)]: ok(pointer) });
      await open();
      await userEvent.click(screen.getByRole("button", { name: /merge alocation dynamique into dynamic allocation/i }));
      const dialog = await screen.findByRole("dialog", { name: /merge .* into another concept/i });
      expect(within(dialog).getByRole("radio", { name: /dynamic allocation/i })).toBeChecked();
      await userEvent.click(within(dialog).getByRole("button", { name: /^merge$/i }));
      await waitFor(() => expect(calls.find((c) => c.url.endsWith("/merge"))?.body).toEqual({ into: pointer.id, keepAsAlias: false }));
    });

    it("offers no merge for homonym candidates, and none while neither is validated", async () => {
      mockFetch({ [LIST]: ok(page([memory, network, hash, hashEn])) });
      await open();
      // The pair's own row comes before the concept lines nested in it.
      const rows = screen.getAllByRole("listitem");
      const homonyms = rows.find((li) => within(li).queryByText("Same label"));
      expect(homonyms).toBeDefined();
      expect(within(homonyms!).queryByRole("button", { name: /merge/i })).toBeNull();
      expect(within(homonyms!).getByText(/check the qualifiers/i)).toBeInTheDocument();
      const translation = rows.find((li) => within(li).queryByText("Translation"));
      // Each concept shows the label that matches, with its language.
      expect(within(translation!).getByText("Hash table (FR)")).toBeInTheDocument();
      expect(within(translation!).getByText("Hash table (EN)")).toBeInTheDocument();
      expect(within(translation!).queryByRole("button", { name: /merge/i })).toBeNull();
      expect(within(translation!).getByText(/validate one of them/i)).toBeInTheDocument();
    });

    it("opens a concept's sheet from a pair, and narrows with the search", async () => {
      mockFetch({ [LIST]: ok(page(all)) });
      await open();
      await userEvent.type(screen.getByRole("searchbox", { name: /search a concept/i }), "heap");
      await waitFor(() => expect(screen.queryByText("Close labels")).toBeNull());
      expect(screen.getByText("Alias clash")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /edit heap/i }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

    it("says so when there is none", async () => {
      mockFetch({ [LIST]: ok(page([validated, ready])) });
      await open();
      expect(await screen.findByText("No probable duplicates")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /^duplicates$/i })).toBeChecked();
    });
  });

  it("has a done state", async () => {
    mockFetch({
      [LIST]: ok(page([validated])),
    });
    renderWithProviders(<ConceptQueue />);
    await userEvent.click(await screen.findByRole("radio", { name: /^to validate$/i }));
    expect(await screen.findByText("Nothing left to validate")).toBeInTheDocument();
  });

  it("shows the failure of the list", async () => {
    mockFetch({ [LIST]: fail(500, { message: "boom" }) });
    renderWithProviders(<ConceptQueue />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
