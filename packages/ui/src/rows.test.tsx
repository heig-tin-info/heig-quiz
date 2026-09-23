import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { patchAt, RemoveRowButton, removeAt, RowList, RowListHeader } from "./rows.js";

describe("patchAt / removeAt", () => {
  const list = [
    { name: "a", points: 1 },
    { name: "b", points: 2 },
  ];

  it("merges a patch into one row and copies the list", () => {
    const next = patchAt(list, 1, { points: 5 });
    expect(next).toEqual([
      { name: "a", points: 1 },
      { name: "b", points: 5 },
    ]);
    expect(next[0]).toBe(list[0]);
    expect(list[1]?.points).toBe(2);
  });

  it("drops one row", () => {
    expect(removeAt(list, 0)).toEqual([{ name: "b", points: 2 }]);
  });
});

describe("RowList", () => {
  it("draws one panel per row, in order", () => {
    render(<RowList items={["x", "y"]}>{(item, i) => <span>{`${i}:${item}`}</span>}</RowList>);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((li) => li.textContent)).toEqual(["0:x", "1:y"]);
    expect(rows[0]?.className).toContain("rounded-card");
  });
});

describe("RowListHeader and RemoveRowButton", () => {
  it("adds and removes through their callbacks", () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(
      <>
        <RowListHeader title="Cases" count="3 points" addLabel="Add a case" onAdd={onAdd} />
        <RemoveRowButton label="Remove the case sum" onClick={onRemove} disabled={false} />
      </>,
    );
    expect(screen.getByRole("heading", { name: "Cases" })).toBeInTheDocument();
    expect(screen.getByText("3 points")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a case" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove the case sum" }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
