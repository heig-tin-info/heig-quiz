import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Concept, TagSorting, TagSortingRow } from "@quiz/contracts";

import { ConceptsSection } from "./ConceptsSection";
import { fail, mockFetch, ok, renderWithProviders, type RecordedCall } from "../test/render";

const LIST = "GET /app/api/admin/concept-sorting";
const CONCEPTS = "GET /app/api/concepts";
const ACCEPT = "POST /app/api/admin/concept-sorting/accept";

const INFO1 = "c0a1b2c3-0000-4000-8000-0000000000a1";
const PROGC = "c0a1b2c3-0000-4000-8000-0000000000c1";

const row = (poolId: string, poolName: string, tag: string, group: string, count: number, description = ""): TagSortingRow => ({
  poolId,
  poolName,
  tag,
  count,
  description,
  excerpts: [],
  group,
  sorting: null,
});

const pointer: Concept = {
  id: "c0c0c0c0-0000-4000-8000-000000000001",
  status: "validated",
  mergedInto: null,
  labels: { fr: "Pointeur", en: "Pointer" },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "Variable qui contient une adresse.", en: "" },
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
};

const ROWS = [
  row(INFO1, "Info1", "pointeurs", "pointeur", 18, "Adresses et déréférencement."),
  row(PROGC, "Prog C — C10", "pointeur", "pointeur", 9),
  row(INFO1, "Info1", "lecture-de-code", "lecture-code", 12),
];

/** A stored decision: a mapping to `pointer` unless `over` says otherwise. */
const sorting = (over: Partial<TagSorting> = {}): TagSorting => ({
  decision: "concept",
  concept: pointer,
  dropReason: null,
  proposal: null,
  decidedBy: null,
  decidedAt: null,
  ...over,
});

const acceptBody = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST").at(-1)?.body;
const accepted = (items: { poolId: string; tag: string }[], stored: TagSorting = sorting()) =>
  ok({ rows: items.map((i) => ({ poolId: i.poolId, tag: i.tag, sorting: stored })), created: [] });

/** Ticks the group's checkbox: every pair of it at once. */
async function selectGroup(group: string) {
  await userEvent.click(await screen.findByRole("checkbox", { name: `Select every tag of ${group}` }));
}

const bar = () => screen.getByRole("region", { name: /selected/i });

describe("the concepts tab: sorting the tags (ADR-081, second addendum)", () => {
  it("groups the pairs by their concept key and selects a group at once", async () => {
    mockFetch({ [LIST]: ok({ rows: ROWS }) });
    renderWithProviders(<ConceptsSection />);

    const head = (await screen.findByText("pointeur", { selector: "span" })).closest("tr")!;
    expect(within(head).getByText(/2 tags · 27 questions/)).toBeInTheDocument();
    // The group's header comes first, then its two pairs, then the next group.
    const order = screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label") ?? c.closest("label")!.textContent);
    expect(order).toEqual([
      "Select every tag of pointeur",
      "Select pointeurs in Info1",
      "Select pointeur in Prog C — C10",
      "Select every tag of lecture-code",
      "Select lecture-de-code in Info1",
    ]);
    expect(screen.getByText("0 of 3 tags sorted")).toBeInTheDocument();

    await selectGroup("pointeur");
    expect(screen.getByRole("checkbox", { name: "Select pointeurs in Info1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select pointeur in Prog C — C10" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select lecture-de-code in Info1" })).not.toBeChecked();
    expect(within(bar()).getByText("2 selected")).toBeInTheDocument();
    // No decision yet: nothing to accept.
    expect(within(bar()).getByRole("button", { name: /accept \(0\)/i })).toBeDisabled();
  });

  it("accepts a new concept for a group, French seeded from the tag and the pool description", async () => {
    const { calls } = mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [ACCEPT]: accepted(ROWS.slice(0, 2)),
    });
    renderWithProviders(<ConceptsSection />);
    await selectGroup("pointeur");
    await userEvent.click(within(bar()).getByRole("button", { name: /new concept/i }));

    const sheet = await screen.findByRole("dialog");
    const labels = within(sheet).getAllByRole("textbox", { name: /^label/i });
    expect(labels[0]).toHaveValue("Pointeurs");
    expect(within(sheet).getAllByRole("textbox", { name: /description/i })[0]).toHaveValue("Adresses et déréférencement.");
    const apply = within(sheet).getByRole("button", { name: /apply to 2 tags/i });
    // A validated concept has both labels: English is required.
    expect(apply).toBeDisabled();
    await userEvent.type(labels[1]!, "Pointers");
    await userEvent.click(apply);

    expect(screen.getAllByText("New: Pointeurs")).toHaveLength(2);
    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(2\)/i }));
    const side = { fr: { label: "Pointeurs", qualifier: "", description: "Adresses et déréférencement." }, en: { label: "Pointers", qualifier: "", description: "" } };
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [
          { poolId: INFO1, tag: "pointeurs", decision: { kind: "new", ...side } },
          { poolId: PROGC, tag: "pointeur", decision: { kind: "new", ...side } },
        ],
      }),
    );
    // Accepted, the pairs leave the "to sort" list.
    await waitFor(() => expect(screen.queryByText("pointeurs")).toBeNull());
    expect(screen.getByText("2 of 3 tags sorted")).toBeInTheDocument();
  });

  it("maps a pair to an existing concept found by its tag", async () => {
    const { calls } = mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [CONCEPTS]: ok({ concepts: [pointer, { ...pointer, id: "c0c0c0c0-0000-4000-8000-000000000002", labels: { fr: "Tableau", en: "Array" } }] }),
      [ACCEPT]: accepted([ROWS[1]!]),
    });
    renderWithProviders(<ConceptsSection />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select pointeur in Prog C — C10" }));
    await userEvent.click(within(bar()).getByRole("button", { name: /map to a concept/i }));

    const dialog = await screen.findByRole("dialog");
    // The search starts on the tag: `pointeur` finds Pointer, not Array.
    const choice = await within(dialog).findByRole("radio", { name: /pointer/i });
    expect(within(dialog).queryByRole("radio", { name: /array/i })).toBeNull();
    await userEvent.click(choice);
    await userEvent.click(within(dialog).getByRole("button", { name: /^map$/i }));

    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(1\)/i }));
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [{ poolId: PROGC, tag: "pointeur", decision: { kind: "concept", conceptId: pointer.id } }],
      }),
    );
  });

  it("drops a group with its reason", async () => {
    const { calls } = mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [ACCEPT]: accepted([ROWS[2]!], sorting({ decision: "drop", concept: null, dropReason: "task_kind" })),
    });
    renderWithProviders(<ConceptsSection />);
    await selectGroup("lecture-code");
    await userEvent.click(within(bar()).getByRole("button", { name: /^drop$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /kind of task/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^drop$/i }));
    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(1\)/i }));
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [{ poolId: INFO1, tag: "lecture-de-code", decision: { kind: "drop", reason: "task_kind" } }],
      }),
    );
  });

  it("offers, on a 409, to map the items to the concept holding the label, in one click", async () => {
    let attempt = 0;
    const { calls } = mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [ACCEPT]: () =>
        (attempt += 1) === 1
          ? fail(409, { error: "concept_exists", conflicts: [{ concept: pointer, items: [{ poolId: INFO1, tag: "pointeurs" }, { poolId: PROGC, tag: "pointeur" }] }] })
          : accepted(ROWS.slice(0, 2)),
    });
    renderWithProviders(<ConceptsSection />);
    await selectGroup("pointeur");
    await userEvent.click(within(bar()).getByRole("button", { name: /new concept/i }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.type(within(sheet).getAllByRole("textbox", { name: /^label/i })[1]!, "Pointer");
    await userEvent.click(within(sheet).getByRole("button", { name: /apply to/i }));
    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(2\)/i }));

    expect(await screen.findByText(/“Pointer” already exists: 2 tags/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Map to Pointer" }));
    expect(screen.queryByText(/already exists/)).toBeNull();
    expect(screen.getAllByText("Pointer")).toHaveLength(2);

    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(2\)/i }));
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [
          { poolId: INFO1, tag: "pointeurs", decision: { kind: "concept", conceptId: pointer.id } },
          { poolId: PROGC, tag: "pointeur", decision: { kind: "concept", conceptId: pointer.id } },
        ],
      }),
    );
  });

  it("names the pairs a 422 refuses, on their row", async () => {
    mockFetch({
      [LIST]: ok({ rows: ROWS }),
      [ACCEPT]: fail(422, { error: "tag_unknown", items: [{ poolId: INFO1, tag: "lecture-de-code" }] }),
    });
    renderWithProviders(<ConceptsSection />);
    await selectGroup("lecture-code");
    await userEvent.click(within(bar()).getByRole("button", { name: /^drop$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /noise/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^drop$/i }));
    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(1\)/i }));

    const cells = await screen.findAllByText("No question wears this tag any more.");
    // On the row, and in the notice above the bar.
    expect(cells).toHaveLength(2);
    expect(screen.getByText("lecture-de-code", { selector: "div" }).closest("tr")).toContainElement(cells[0]!);
  });

  it("marks a group partly ticked as mixed, and clears a pending decision", async () => {
    mockFetch({ [LIST]: ok({ rows: ROWS }) });
    renderWithProviders(<ConceptsSection />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Select pointeurs in Info1" }));
    expect(screen.getByRole("checkbox", { name: "Select every tag of pointeur" })).toBePartiallyChecked();

    await userEvent.click(within(bar()).getByRole("button", { name: /^drop$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /noise/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^drop$/i }));
    expect(screen.getByText("To accept: Drop · Noise")).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: /accept \(1\)/i })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Clear the decision for pointeurs" }));
    expect(screen.queryByText(/to accept:/i)).toBeNull();
    const accept = within(bar()).getByRole("button", { name: /accept \(0\)/i });
    expect(accept).toBeDisabled();
    // Why it is off, said in the bar and tied to the button.
    expect(accept).toHaveAccessibleDescription("Choose a decision first.");
  });

  it("changes an accepted decision from the Sorted list, showing the one it replaces", async () => {
    const done = { ...ROWS[2]!, sorting: sorting({ decision: "drop", concept: null, dropReason: "organisational" }) };
    const { calls } = mockFetch({
      [LIST]: ok({ rows: [...ROWS.slice(0, 2), done] }),
      [ACCEPT]: accepted([done], sorting({ decision: "drop", concept: null, dropReason: "task_kind" })),
    });
    renderWithProviders(<ConceptsSection />);
    await screen.findByText("pointeurs");
    expect(screen.queryByText("lecture-de-code", { selector: "div" })).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Sorted" }));
    expect(screen.getByText("Drop · Organisational label")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Select lecture-de-code in Info1" }));
    await userEvent.click(within(bar()).getByRole("button", { name: /^drop$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /kind of task/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^drop$/i }));
    expect(screen.getByText("Now: Drop · Organisational label")).toBeInTheDocument();
    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(1\)/i }));
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [{ poolId: INFO1, tag: "lecture-de-code", decision: { kind: "drop", reason: "task_kind" } }],
      }),
    );
    expect(await screen.findByText("Drop · Kind of task")).toBeInTheDocument();
  });

  it("never sends a ticked pair the search hides", async () => {
    const { calls } = mockFetch({ [LIST]: ok({ rows: ROWS }), [ACCEPT]: accepted([ROWS[0]!]) });
    renderWithProviders(<ConceptsSection />);
    await selectGroup("pointeur");
    await userEvent.click(within(bar()).getByRole("button", { name: /^drop$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: /noise/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^drop$/i }));

    await userEvent.type(screen.getByRole("searchbox", { name: /search a tag/i }), "Info1");
    expect(within(bar()).getByText("1 selected")).toBeInTheDocument();
    await userEvent.click(within(bar()).getByRole("button", { name: /accept \(1\)/i }));
    await waitFor(() =>
      expect(acceptBody(calls)).toEqual({
        items: [{ poolId: INFO1, tag: "pointeurs", decision: { kind: "drop", reason: "noise" } }],
      }),
    );
  });

  it("shows a mapping whose concept did not come back as decided, by an unknown concept", async () => {
    mockFetch({ [LIST]: ok({ rows: [{ ...ROWS[0]!, sorting: sorting({ concept: null }) }] }) });
    renderWithProviders(<ConceptsSection />);
    await userEvent.click(await screen.findByRole("radio", { name: "All" }));
    expect(screen.getByText("Unknown concept")).toBeInTheDocument();
    expect(screen.getByText("1 of 1 tags sorted")).toBeInTheDocument();
  });

  it("shows the empty and the failed list", async () => {
    mockFetch({ [LIST]: ok({ rows: [] }) });
    const { unmount } = renderWithProviders(<ConceptsSection />);
    expect(await screen.findByText(/no tag to sort/i)).toBeInTheDocument();
    unmount();

    mockFetch({ [LIST]: fail(500, { error: "internal_error" }) });
    renderWithProviders(<ConceptsSection />);
    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
