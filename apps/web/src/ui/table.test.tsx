import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { T, TableHead, useSortableTable, type Column, type SortState } from "./table";

/*
 * The one motif every table of the app sorts through: the hook that holds the
 * order, and the head that draws it. What is worth testing here is the part a
 * screen cannot see — that a list arrives in the order the server sent it and
 * stays there until somebody clicks, and that the head says out loud which
 * column is sorted and which way.
 */

interface Row {
  name: string;
  score: number;
}

type Key = "name" | "score";

/** Neither alphabetical nor by score: the order the server "sent". */
const ROWS: Row[] = [
  { name: "Charlie", score: 2 },
  { name: "alice", score: 10 },
  { name: "Bob", score: 5 },
];

const rank = (row: Row, key: Key) => (key === "score" ? row.score : row.name);

const names = (rows: readonly Row[]) => rows.map((r) => r.name);

describe("useSortableTable", () => {
  it("keeps the order the rows arrived in while the initial sort is null", () => {
    const { result } = renderHook(() => useSortableTable<Row, Key>(ROWS, rank, null));
    expect(result.current.sort).toBeNull();
    expect(names(result.current.sorted)).toEqual(["Charlie", "alice", "Bob"]);
  });

  it("sorts on the first toggle and flips on the second", () => {
    const { result } = renderHook(() => useSortableTable<Row, Key>(ROWS, rank, null));

    act(() => result.current.toggle("name"));
    expect(result.current.sort).toEqual({ key: "name", dir: 1 });
    expect(names(result.current.sorted)).toEqual(["alice", "Bob", "Charlie"]);

    act(() => result.current.toggle("name"));
    expect(result.current.sort).toEqual({ key: "name", dir: -1 });
    expect(names(result.current.sorted)).toEqual(["Charlie", "Bob", "alice"]);
  });

  it("selects another column ascending, and ranks numbers as numbers", () => {
    const { result } = renderHook(() => useSortableTable<Row, Key>(ROWS, rank, null));
    act(() => result.current.toggle("name"));
    act(() => result.current.toggle("score"));
    expect(result.current.sort).toEqual({ key: "score", dir: 1 });
    expect(names(result.current.sorted)).toEqual(["Charlie", "Bob", "alice"]);
  });

  it("starts on the initial sort when it is given one", () => {
    const { result } = renderHook(() =>
      useSortableTable<Row, Key>(ROWS, rank, { key: "score", dir: -1 }),
    );
    expect(names(result.current.sorted)).toEqual(["alice", "Bob", "Charlie"]);
  });
});

const COLUMNS: Column<Key>[] = [
  { key: "name", label: "Student" },
  { key: "score", label: "Score", right: true },
  { key: "note", label: "Note", sortable: false },
  { key: "actions", label: "Actions", sortable: false, srOnly: true },
];

function renderHead(sort: SortState<Key> | null, onToggle = vi.fn()) {
  render(
    <table>
      <TableHead columns={COLUMNS} sort={sort} onToggle={onToggle} />
    </table>,
  );
  return onToggle;
}

describe("TableHead", () => {
  it("makes a button of every sortable column, and of no other", () => {
    renderHead(null);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Student", "Score"]);
    const note = screen.getByRole("columnheader", { name: "Note" });
    expect(within(note).queryByRole("button")).toBeNull();
  });

  it("says which column is sorted, and which way", async () => {
    renderHead({ key: "score", dir: -1 });
    expect(screen.getByRole("columnheader", { name: "Score" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getByRole("columnheader", { name: "Student" })).not.toHaveAttribute("aria-sort");

    render(
      <table>
        <TableHead columns={COLUMNS} sort={{ key: "score", dir: 1 }} onToggle={vi.fn()} />
      </table>,
    );
    expect(screen.getAllByRole("columnheader", { name: "Score" })[1]).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("reports the click on a label", async () => {
    const onToggle = renderHead(null);
    await userEvent.click(screen.getByRole("button", { name: "Student" }));
    expect(onToggle).toHaveBeenCalledWith("name");
  });

  it("keeps the actions column's label for screen readers only", () => {
    renderHead(null);
    const actions = screen.getByRole("columnheader", { name: "Actions" });
    expect(within(actions).getByText("Actions")).toHaveClass("sr-only");
  });

  it("draws the head of a row-card table: the row mode, the roles, the sub headers set aside", () => {
    const columns: Column<Key>[] = [
      { key: "name", label: "Student", stack: "main" },
      { key: "score", label: "Score", right: true, stack: "sub" },
      { key: "actions", label: "Actions", sortable: false, srOnly: true, stack: "end" },
    ];
    render(
      <table>
        <TableHead columns={columns} sort={null} onToggle={vi.fn()} />
      </table>,
    );
    const student = screen.getByRole("columnheader", { name: "Student" });
    expect(student.closest("tr")?.className).toBe(T.stack.row);
    expect(student.className).toContain(T.stack.main);
    expect(screen.getByRole("columnheader", { name: "Score" }).className).toContain(T.stack.subHead);
    expect(screen.getByRole("columnheader", { name: "Actions" }).className).toContain(T.stack.end);
  });

  it("leaves a plain table's head row without the row-card mode", () => {
    renderHead(null);
    expect(screen.getByRole("columnheader", { name: "Student" }).closest("tr")).not.toHaveAttribute("class");
  });
});
