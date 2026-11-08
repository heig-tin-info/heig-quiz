import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { NotePanel } from ".";

describe("NotePanel", () => {
  it("names its body with the eyebrow, in one panel shape", () => {
    renderWithProviders(
      <NotePanel eyebrow="Explanation">
        <p>Because pointers are addresses.</p>
      </NotePanel>,
    );
    const panel = screen.getByText("Explanation").closest("div")!;
    expect(panel).toHaveClass("bg-surface-2");
    expect(screen.getByText("Because pointers are addresses.")).toBeVisible();
  });

  it("outlines what a person wrote", () => {
    renderWithProviders(
      <NotePanel eyebrow="Comment" tone="outlined">
        <p>Good start.</p>
      </NotePanel>,
    );
    const panel = screen.getByText("Comment").closest("div")!;
    expect(panel).toHaveClass("border");
    expect(panel).not.toHaveClass("bg-surface-2");
  });
});
