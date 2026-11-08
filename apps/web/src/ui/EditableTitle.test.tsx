import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { EditableTitle } from ".";

describe("EditableTitle", () => {
  function Harness({ onSave = vi.fn() }: { onSave?: (next: string) => void }) {
    const [value, setValue] = useState("Quiz 3");
    return (
      <EditableTitle
        value={value}
        onSave={(next) => {
          setValue(next);
          onSave(next);
        }}
        editLabel="Rename evaluation: Quiz 3"
        inputLabel="Title"
      />
    );
  }

  it("names what pressing it does, and hides the pencil from the tree", () => {
    const { container } = renderWithProviders(<Harness />);
    expect(screen.getByRole("button", { name: "Rename evaluation: Quiz 3" })).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden");
  });

  it("opens on F2 as well as on a click, and saves on blur", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithProviders(<Harness onSave={onSave} />);

    const button = screen.getByRole("button", { name: /^rename evaluation/i });
    button.focus();
    fireEvent.keyDown(button, { key: "F2" });

    const input = await screen.findByRole("textbox", { name: "Title" });
    await user.clear(input);
    await user.type(input, "Quiz 4");
    await user.tab();

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Quiz 4");
    expect(screen.getByRole("button", { name: "Rename evaluation: Quiz 3" })).toBeInTheDocument();
  });

  it("saves nothing when the value comes back unchanged", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithProviders(<Harness onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: /^rename evaluation/i }));
    await user.keyboard("{Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^rename evaluation/i })).toBeInTheDocument();
  });

  it("opens with the whole title selected, and saves once on Enter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithProviders(<Harness onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: /^rename evaluation/i }));
    const input = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Quiz 3".length]);
    await user.keyboard("Quiz 4{Enter}");

    // Enter unmounts the field; its blur must not save a second time.
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Quiz 4");
  });

  it("cancels on Escape, and the next edit starts from the stored title", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithProviders(<Harness onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: /^rename evaluation/i }));
    await user.keyboard("nonsense{Escape}");
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^rename evaluation/i }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Quiz 3");
  });

  it("reverts a blank title without saving", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderWithProviders(<Harness onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: /^rename evaluation/i }));
    await user.clear(screen.getByRole("textbox", { name: "Title" }));
    await user.keyboard("   {Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^rename evaluation/i })).toHaveTextContent("Quiz 3");
  });

  it("shows the title a save is carrying until the stored one catches up", () => {
    renderWithProviders(
      <EditableTitle value="Quiz 3" pending="Quiz 4" onSave={vi.fn()} editLabel="Rename" inputLabel="Title" />,
    );
    expect(screen.getByRole("button", { name: "Rename" })).toHaveTextContent("Quiz 4");
  });
});
