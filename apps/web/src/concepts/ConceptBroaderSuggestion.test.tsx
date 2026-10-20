import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AdminConcept, ConceptRelationProposals } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ConceptSheet } from "./ConceptSheet";

const AVAILABILITY = "GET /app/api/generate/availability";
const AI = "POST /app/api/admin/concepts/relations/ai";

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

const pointer = concept(1, "Pointeur", "Pointer");
const allocation = concept(2, "Allocation dynamique", "Dynamic allocation", { broader: [pointer.id] });
const heap = concept(3, "Tas", "Heap", { status: "proposed" });
const stack = concept(4, "Pile", "Stack");
const arithmetic = concept(5, "Arithmétique des pointeurs", "Pointer arithmetic");
const all = [pointer, allocation, heap, stack, arithmetic];
const RELATE = `POST /app/api/admin/concepts/${heap.id}/relations`;
const created = concept(9, "Gestion de la mémoire", "Memory management", { status: "proposed" });

/** A reply that names other concepts too: only the heap's broader rows and the top listing it are this sheet's. */
const reply: ConceptRelationProposals = {
  lang: "en",
  asked: [heap.id],
  broader: [
    { concept: heap.id, target: allocation.id },
    { concept: arithmetic.id, target: pointer.id },
  ],
  related: [{ a: heap.id, b: stack.id, reason: "Two regions of memory." }],
  tops: [{ label: "Memory management", qualifier: "", reason: "The heap and the stack hold a program's data.", narrower: [heap.id, stack.id] }],
  remaining: 7,
  truncated: false,
};

const open = (concepts = all) =>
  renderWithProviders(
    <ConceptSheet concept={heap} concepts={concepts} byId={new Map(concepts.map((c) => [c.id, c]))} locale="en" onClose={() => undefined} />,
  );
const ask = async () => {
  await userEvent.click(await screen.findByRole("button", { name: /^suggest a broader concept$/i }));
  return screen.findByRole("list", { name: "Suggested broader concepts" });
};
const available = { [AVAILABILITY]: ok({ available: true, types: [] }) };

describe("Suggest a broader concept on the concept sheet (ADR-114 §3)", () => {
  it("asks for this concept only and shows its broader rows and the top concept listing it, nothing else", async () => {
    const { calls } = mockFetch({ ...available, [AI]: ok(reply) });
    open();
    const list = await ask();

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ concept: heap.id });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // The broader concept, with the path above it.
    expect(within(rows[0]!).getByText("Dynamic allocation")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Pointer")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("New concept: Memory management")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("The heap and the stack hold a program's data.")).toBeInTheDocument();
    // Another concept's row and the related pair are not this sheet's.
    expect(within(list).queryByText(/pointer arithmetic/i)).toBeNull();
    expect(within(list).queryByText("Stack")).toBeNull();
    expect(screen.queryByText("Two regions of memory.")).toBeNull();
    // Nothing is written by asking.
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual(["/app/api/admin/concepts/relations/ai"]);
  });

  it("adds a suggested broader concept through the relation route, then reads Added", async () => {
    const { calls } = mockFetch({ ...available, [AI]: ok(reply), [RELATE]: ok({ ...heap, broader: [allocation.id] }) });
    open();
    const list = await ask();
    await userEvent.click(screen.getByRole("button", { name: "Add Dynamic allocation as a broader concept" }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/relations") && c.method === "POST")?.body).toEqual({ kind: "broader", target: allocation.id }));
    // Written: the row says so at once, and offers no second write.
    const row = within(list).getAllByRole("listitem")[0]!;
    expect(await within(row).findByText("Added")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("creates a missing top concept, then adds it with the id it got", async () => {
    const { calls } = mockFetch({
      ...available,
      [AI]: ok(reply),
      "POST /app/api/concepts": ok(created),
      [RELATE]: ok({ ...heap, broader: [created.id] }),
    });
    open();
    await ask();
    await userEvent.click(screen.getByRole("button", { name: "Create Memory management and add it as a broader concept" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/relations"))).toBe(true));
    const writes = calls.filter((c) => c.method === "POST" && c.url !== "/app/api/admin/concepts/relations/ai");
    expect(writes.map((c) => [c.url, c.body])).toEqual([
      ["/app/api/concepts", { lang: "en", label: "Memory management", qualifier: "" }],
      [`/app/api/admin/concepts/${heap.id}/relations`, { kind: "broader", target: created.id }],
    ]);
  });

  it("disables a suggestion the vocabulary has moved past, naming the cycle it would close", async () => {
    // Dynamic allocation went under Heap since the reply: Heap under it would be a cycle.
    const under = { ...allocation, broader: [heap.id] };
    mockFetch({ ...available, [AI]: ok(reply) });
    open([pointer, under, heap, stack, arithmetic]);
    await ask();
    expect(screen.getByText(/Heap › Dynamic allocation › Heap/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Dynamic allocation as a broader concept" })).toBeDisabled();
  });

  it("says so when the reply holds nothing for this concept", async () => {
    mockFetch({ ...available, [AI]: ok({ ...reply, broader: [reply.broader[1]], tops: [] }) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: /^suggest a broader concept$/i }));
    expect(await screen.findByText("The AI found no broader concept.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Suggested broader concepts" })).toBeNull();
  });

  it("says why the model failed", async () => {
    mockFetch({ ...available, [AI]: fail(502, { error: "llm_failed" }) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: /^suggest a broader concept$/i }));
    expect(await screen.findByText("The AI could not suggest a broader concept")).toBeInTheDocument();
  });

  it("is not offered without a model", async () => {
    const { calls } = mockFetch({ [AVAILABILITY]: ok({ available: false, types: [] }) });
    open();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/generate/availability"))).toBe(true));
    expect(screen.queryByRole("button", { name: /suggest a broader concept/i })).toBeNull();
  });
});
