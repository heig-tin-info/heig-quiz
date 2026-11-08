import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LayerHarness } from "../test/layerHarness";
import { renderWithProviders } from "../test/render";
import { Button, Field, Modal } from ".";

describe("Modal", () => {
  const openModal = async (onClose = vi.fn()) => {
    renderWithProviders(
      <LayerHarness
        render={(close) => (
          <Modal
            title="Archive PRG1 2026?"
            onClose={() => {
              onClose();
              close();
            }}
            footer={
              <>
                <Button variant="ghost">Cancel</Button>
                <Button>Archive</Button>
              </>
            }
          >
            The classroom disappears until you restore it.
          </Modal>
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    return { dialog: screen.getByRole("dialog"), onClose };
  };

  it("renders in a portal, named by its own title", async () => {
    const { dialog } = await openModal();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Archive PRG1 2026?");
    // Portal: the panel is a child of <body>, not of the render container.
    expect(dialog.closest("[data-testid='container']")).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("names its close button in the reader's language", async () => {
    renderWithProviders(
      <LayerHarness render={(close) => <Modal title="Archiver ?" onClose={close}>…</Modal>} />,
      { locale: "fr" },
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Fermer" })).toBeVisible();
  });

  it("closes on Escape", async () => {
    const { onClose } = await openModal();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a backdrop click (a stray click must not discard a form)", async () => {
    const { dialog, onClose } = await openModal();
    const backdrop = dialog.parentElement!;
    await userEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves the focus inside on open and back to the opener on close", async () => {
    const { dialog } = await openModal();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
    );
  });

  it("cycles the Tab order inside the panel", async () => {
    const { dialog } = await openModal();
    const stops = [
      within(dialog).getByRole("button", { name: "Close" }),
      within(dialog).getByRole("button", { name: "Cancel" }),
      within(dialog).getByRole("button", { name: "Archive" }),
    ];
    const last = stops[2]!;
    const first = stops[0]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("keeps its clicks to itself: the row that opened it never hears them", async () => {
    const onRowClick = vi.fn();
    renderWithProviders(
      // The dialog is portalled out of this div in the DOM, but it is still
      // its child in the React tree, which is what carries the bubbling.
      <div onClick={onRowClick}>
        <LayerHarness
          render={(close) => (
            <Modal title="Adjust grade" onClose={close} footer={<Button>Save</Button>}>
              <Field label="Points" defaultValue="4.5" />
            </Modal>
          )}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    onRowClick.mockClear();
    await userEvent.click(screen.getByLabelText("Points"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
