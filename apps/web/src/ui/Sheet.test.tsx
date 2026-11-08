import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LayerHarness } from "../test/layerHarness";
import { renderWithProviders } from "../test/render";
import { Button, Sheet, Textarea } from ".";

describe("Sheet", () => {
  const openSheet = async (onClose = vi.fn()) => {
    renderWithProviders(
      <LayerHarness
        render={(close) => (
          <Sheet
            title="New assignment"
            subtitle="Draft — nothing is published yet"
            onClose={() => {
              onClose();
              close();
            }}
            footer={<Button>Create assignment</Button>}
          >
            <label>
              Name
              <input />
            </label>
          </Sheet>
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    return { dialog: screen.getByRole("dialog"), onClose };
  };

  it("is a named modal dialog in a portal, with its footer", async () => {
    const { dialog } = await openSheet();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("New assignment");
    expect(within(dialog).getByText("Draft — nothing is published yet")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create assignment" })).toBeInTheDocument();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("closes on Escape and hands the focus back to the opener", async () => {
    const { dialog, onClose } = await openSheet();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
    );
  });

  it("closes on its X button", async () => {
    const { dialog, onClose } = await openSheet();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the panel", async () => {
    const { dialog } = await openSheet();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const create = within(dialog).getByRole("button", { name: "Create assignment" });
    create.focus();
    fireEvent.keyDown(create, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("keeps its clicks to itself, like the dialog", async () => {
    const onRowClick = vi.fn();
    renderWithProviders(
      <div onClick={onRowClick}>
        <LayerHarness
          render={(close) => (
            <Sheet title="Add students" onClose={close}>
              <Textarea label="Roster CSV" defaultValue="" />
            </Sheet>
          )}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    onRowClick.mockClear();
    await userEvent.click(screen.getByLabelText("Roster CSV"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
