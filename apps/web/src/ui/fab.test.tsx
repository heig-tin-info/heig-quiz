import { act, fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { viewport } from "../test/viewport";
import { PageHeader } from "./page";

const narrow = window.matchMedia;

afterEach(() => {
  vi.stubGlobal("matchMedia", narrow);
  window.scrollY = 0;
});

function header(onClick = () => {}) {
  return render(
    <PageHeader
      title="Courses"
      help="courses"
      primary={{ icon: Plus, label: "New course", onClick, coach: "home.new-course" }}
    />,
  );
}

describe("PageHeader's primary (#450)", () => {
  it("is the floating action button on a phone, never also in the header", () => {
    const onClick = vi.fn();
    header(onClick);
    const fab = screen.getByRole("button", { name: "New course" });
    expect(fab.closest("header")).toBeNull();
    const dock = fab.closest("[data-fab]");
    expect(dock).not.toBeNull();
    // The coach keeps its bubbles above it, and its tour still finds the target.
    expect(dock!.hasAttribute("data-bottom-dock")).toBe(true);
    expect(fab.getAttribute("data-coach")).toBe("home.new-course");
    fireEvent.click(fab);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("folds its label away once the page scrolls, and keeps its accessible name", () => {
    header();
    const fab = screen.getByRole("button", { name: "New course" });
    const label = fab.querySelector("span")!;
    expect(label.className).toContain("opacity-100");
    act(() => {
      window.scrollY = 200;
      window.dispatchEvent(new Event("scroll"));
    });
    expect(label.className).toContain("max-w-0");
    expect(fab.getAttribute("aria-label")).toBe("New course");
    act(() => {
      window.scrollY = 0;
      window.dispatchEvent(new Event("scroll"));
    });
    expect(label.className).toContain("opacity-100");
  });

  it("is the header's accent button from lg, with no FAB", () => {
    viewport(1440);
    header();
    const button = screen.getByRole("button", { name: "New course" });
    expect(button.closest("header")).not.toBeNull();
    expect(button.getAttribute("data-coach")).toBe("home.new-course");
    expect(document.querySelector("[data-fab]")).toBeNull();
  });
});
