import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { patchAt, RemoveRowButton, removeAt, RowHead, RowList, RowListHeader } from "./rows.js";

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

describe("RowHead", () => {
  function setup(visible: boolean) {
    const calls = {
      name: vi.fn(),
      points: vi.fn(),
      visible: vi.fn(),
      remove: vi.fn(),
    };
    render(
      <RowHead
        nameId="n"
        nameLabel="Case 1"
        nameAriaLabel="Name 1"
        name="sum"
        onNameChange={calls.name}
        pointsId="p"
        pointsLabel="Points"
        pointsAriaLabel="Points 1"
        points={2}
        onPointsChange={calls.points}
        hiddenLabel="Hidden"
        hiddenAriaLabel="Hidden 1"
        visible={visible}
        onVisibleChange={calls.visible}
        removeLabel="Remove the case sum"
        onRemove={calls.remove}
      >
        <span data-testid="extra" />
      </RowHead>,
    );
    return calls;
  }

  it("edits the name and the points, and puts the type's cells between points and Hidden", () => {
    const calls = setup(true);
    fireEvent.change(screen.getByLabelText("Name 1"), { target: { value: "total" } });
    fireEvent.change(screen.getByLabelText("Points 1"), { target: { value: "3" } });
    expect(calls.name).toHaveBeenCalledWith("total");
    expect(calls.points).toHaveBeenCalledWith(3);
    const extra = screen.getByTestId("extra");
    expect(extra.previousElementSibling?.querySelector("input")?.id).toBe("p");
    expect(extra.nextElementSibling?.textContent).toBe("Hidden");
  });

  it("ticks Hidden for an invisible row and hands back the visibility", () => {
    const calls = setup(false);
    const hidden = screen.getByLabelText("Hidden 1");
    expect(hidden).toBeChecked();
    fireEvent.click(hidden);
    expect(calls.visible).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove the case sum" }));
    expect(calls.remove).toHaveBeenCalledOnce();
  });
});
