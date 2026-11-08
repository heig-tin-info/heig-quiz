import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { VerdictCell, type VerdictState } from ".";

describe("VerdictCell", () => {
  const states: VerdictState[] = [
    "blank",
    "inProgress",
    "answered",
    "skipped",
    "done",
    "correct",
    "partial",
    "wrong",
    "pending",
  ];

  it("carries a word in every one of its states, and an icon wherever the shape is not enough", () => {
    for (const state of states) {
      const { container, unmount } = renderWithProviders(<VerdictCell state={state} />);
      expect(container.textContent?.trim()).not.toBe("");
      // #227: opened-and-empty and answered are plain shapes — an outlined
      // box and a filled one. Every other state keeps a mark.
      const plain = state === "inProgress" || state === "answered";
      expect(container.querySelector("svg") === null).toBe(plain);
      unmount();
    }
  });

  it("tells opened from answered by shape, and answered from validated by more than the blue", () => {
    const chrome = (state: VerdictState) => {
      const { container, unmount } = renderWithProviders(<VerdictCell state={state} />);
      const el = container.firstElementChild as HTMLElement;
      const out = { className: el.className, icon: el.querySelector("svg") !== null };
      unmount();
      return out;
    };
    // An outline with nothing inside, then a fill.
    expect(chrome("inProgress").className).toMatch(/\bborder\b/);
    expect(chrome("inProgress").className).not.toMatch(/\bbg-/);
    expect(chrome("answered").className).toMatch(/\bbg-/);
    // `done` is the darker blue AND a check, never the colour alone.
    expect(chrome("done").icon).toBe(true);
  });

  it("names the state for a reader and shows the answer for everyone else", () => {
    renderWithProviders(<VerdictCell state="correct" value="NULL" />);
    expect(screen.getByText("Correct")).toHaveClass("sr-only");
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("separates correct, partial and wrong by icon, not only by tint", () => {
    const paths = (state: VerdictState) => {
      const { container, unmount } = renderWithProviders(<VerdictCell state={state} />);
      const d = container.querySelector("svg")!.innerHTML;
      unmount();
      return d;
    };
    const [ok, partial, bad] = [paths("correct"), paths("partial"), paths("wrong")];
    expect(new Set([ok, partial, bad]).size).toBe(3);
  });

  it("becomes a real button when the dashboard can inspect it", async () => {
    const onClick = vi.fn();
    renderWithProviders(<VerdictCell state="partial" value="2/3" onClick={onClick} label="Nadia, question 5: partly correct" />);
    const cell = screen.getByRole("button", { name: "Nadia, question 5: partly correct" });
    await userEvent.click(cell);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("speaks French when the locale does", () => {
    renderWithProviders(<VerdictCell state="wrong" />, { locale: "fr" });
    expect(screen.getByText("Faux")).toBeInTheDocument();
  });
});
