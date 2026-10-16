import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminConcept } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ConceptQueue } from "./ConceptQueue";
import { broaderTrail } from "./names";

const LIST = "GET /app/api/admin/concepts";

const concept = (n: number, fr: string, en: string, extra: Partial<AdminConcept> = {}): AdminConcept => ({
  id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status: "validated",
  mergedInto: null,
  labels: { fr, en },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  broader: [],
  related: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  questionCount: 2,
  deletable: false,
  creator: null,
  ...extra,
});

const memory = concept(1, "Mémoire", "Memory");
const pointer = concept(2, "Pointeur", "Pointer", { broader: [memory.id] });
const address = concept(3, "Adresse", "Address", { related: [] });
const arithmetic = concept(4, "Arithmétique des pointeurs", "Pointer arithmetic", { broader: [pointer.id] });
const all = [memory, pointer, address, arithmetic];

const url = (c: AdminConcept) => `/app/api/admin/concepts/${c.id}/relations`;
const openSheet = async (name: RegExp) => {
  await userEvent.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
};

describe("the relations of a concept (ADR-081 §4, sixth addendum 7c)", () => {
  it("lists the broader and related concepts as chips and removes one", async () => {
    const withRelated = { ...pointer, related: [address.id] };
    const { calls } = mockFetch({
      [LIST]: ok({ concepts: [memory, withRelated, address, arithmetic] }),
      [`DELETE ${url(pointer)}/broader/${memory.id}`]: ok({ ...withRelated, broader: [] }),
    });
    renderWithProviders(<ConceptQueue />);
    const sheet = await openSheet(/edit pointer$/i);
    const group = within(sheet).getByRole("group", { name: "Relations" });
    expect(within(group).getByText("Memory")).toBeInTheDocument();
    expect(within(group).getByText("Address")).toBeInTheDocument();
    await userEvent.click(within(group).getAllByRole("button", { name: /remove relation/i })[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/broader/${memory.id}`))).toBe(true));
  });

  it("adds a broader concept from a search, never offering the concept's own descendants or itself", async () => {
    const { calls } = mockFetch({
      [LIST]: ok({ concepts: all }),
      [`POST ${url(memory)}`]: ok({ ...memory, broader: [address.id] }),
    });
    renderWithProviders(<ConceptQueue />);
    const sheet = await openSheet(/edit memory$/i);
    const search = within(sheet).getByRole("searchbox", { name: "Search a broader concept" });
    // Pointer and Pointer arithmetic are below Memory: a cycle, so they are not offered.
    await userEvent.type(search, "pointer");
    expect(within(sheet).getByText("No concept can be offered for this search.")).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, "address");
    await userEvent.click(await within(sheet).findByRole("button", { name: "Address" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ kind: "broader", target: address.id }));
  });

  it("does not offer, as related, a concept of the same broader chain", async () => {
    mockFetch({ [LIST]: ok({ concepts: all }) });
    renderWithProviders(<ConceptQueue />);
    const sheet = await openSheet(/edit pointer arithmetic$/i);
    await userEvent.type(within(sheet).getByRole("searchbox", { name: "Search a related concept" }), "mem");
    expect(within(sheet).getByText("No concept can be offered for this search.")).toBeInTheDocument();
  });

  it("names the path of a cycle the server refuses", async () => {
    mockFetch({
      [LIST]: ok({ concepts: all }),
      [`POST ${url(address)}`]: () =>
        fail(409, {
          error: "concept_cycle",
          path: [
            { id: address.id, label: "Address", qualifier: "", status: "validated" },
            { id: memory.id, label: "Memory", qualifier: "", status: "validated" },
            { id: address.id, label: "Address", qualifier: "", status: "validated" },
          ],
        }),
    });
    renderWithProviders(<ConceptQueue />);
    const sheet = await openSheet(/edit address$/i);
    await userEvent.type(within(sheet).getByRole("searchbox", { name: "Search a broader concept" }), "memory");
    await userEvent.click(await within(sheet).findByRole("button", { name: "Memory" }));
    expect(await within(sheet).findByText(/Address › Memory › Address/)).toBeInTheDocument();
  });
});

describe("the narrower concepts of a concept (#897)", () => {
  const dynamic = concept(5, "Allocation dynamique", "Dynamic allocation", { broader: [pointer.id] });
  const leak = concept(6, "Fuite mémoire", "", { status: "proposed", labels: { fr: "Fuite mémoire", en: null }, broader: [dynamic.id] });
  const chain = [...all, dynamic, leak];
  const narrowerList = (sheet: HTMLElement) => within(sheet).getByRole("list", { name: "Narrower concepts" });

  it("lists the direct narrower concepts by name, read-only, a proposed one marked", async () => {
    mockFetch({ [LIST]: ok({ concepts: chain }) });
    renderWithProviders(<ConceptQueue />);
    let sheet = await openSheet(/edit pointer$/i);
    expect(within(sheet).getByRole("heading", { name: "Narrower concepts (2)" })).toBeInTheDocument();
    let list = narrowerList(sheet);
    // Direct ones only: Fuite mémoire is under Dynamic allocation, not listed here.
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Dynamic allocation", "Pointer arithmetic"]);
    expect(within(list).queryAllByRole("button")).toEqual([]);
    expect(within(list).queryAllByRole("link")).toEqual([]);

    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    sheet = await openSheet(/edit dynamic allocation$/i);
    list = narrowerList(sheet);
    const [item] = within(list).getAllByRole("listitem");
    expect(item).toHaveTextContent("Fuite mémoire");
    expect(within(item!).getByText("Proposed")).toBeInTheDocument();
    expect(within(list).queryAllByRole("button")).toEqual([]);
  });

  it("says so when the concept has no narrower concept", async () => {
    mockFetch({ [LIST]: ok({ concepts: chain }) });
    renderWithProviders(<ConceptQueue />);
    const sheet = await openSheet(/edit fuite mémoire$/i);
    expect(within(sheet).getByRole("heading", { name: "Narrower concepts" })).toBeInTheDocument();
    expect(within(sheet).getByText("No narrower concept.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("list", { name: "Narrower concepts" })).toBeNull();
  });

  it("names, under a broader candidate, the narrower concepts it holds already, five then +n", async () => {
    const kids = [1, 2, 3, 4, 5, 6, 7].map((n) => concept(10 + n, `Enfant ${n}`, `Child ${n}`, { broader: [memory.id] }));
    mockFetch({ [LIST]: ok({ concepts: [...chain, ...kids] }) });
    renderWithProviders(<ConceptQueue />);
    const sheet = await openSheet(/edit address$/i);
    const search = within(sheet).getByRole("searchbox", { name: "Search a broader concept" });
    await userEvent.type(search, "pointer");
    const row = (await within(sheet).findByRole("button", { name: "Pointer" })).closest("li")!;
    expect(within(row).getByText("Currently holds: Dynamic allocation, Pointer arithmetic")).toBeInTheDocument();
    // Pointer arithmetic holds nothing: no line.
    const leafRow = within(sheet).getByRole("button", { name: "Pointer arithmetic" }).closest("li")!;
    expect(within(leafRow).queryByText(/Currently holds/)).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "memory");
    const memoryRow = (await within(sheet).findByRole("button", { name: "Memory" })).closest("li")!;
    expect(within(memoryRow).getByText(/^Currently holds: Child 1, Child 2, Child 3, Child 4, Child 5/)).toHaveTextContent(/\+3$/);
  });
});

describe("broaderTrail", () => {
  const byId = new Map(all.map((c) => [c.id, c]));
  it("goes from the root down, and is empty for a root", () => {
    expect(broaderTrail(arithmetic, byId, "en")).toEqual(["Memory", "Pointer"]);
    expect(broaderTrail(memory, byId, "en")).toEqual([]);
  });
  it("follows the first parent by name when there are several", () => {
    const two = { ...arithmetic, broader: [pointer.id, address.id] };
    expect(broaderTrail(two, new Map([...byId, [two.id, two]]), "en")).toEqual(["Address"]);
  });
});
