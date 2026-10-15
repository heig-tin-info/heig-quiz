import { fireEvent, render, screen } from "@testing-library/react";
import { Lock } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { Breadcrumb } from "./breadcrumb";
import { IconTip } from "./meta";

describe("IconTip", () => {
  it("names its icon for a screen reader", () => {
    render(<IconTip icon={Lock} label="Project" />);
    expect(screen.getByRole("img", { name: "Project" })).toBeInTheDocument();
  });
});

describe("Breadcrumb", () => {
  const trail = (onNavigate = vi.fn()) => (
    <Breadcrumb
      label="Breadcrumb"
      backLabel={(parent) => `Back to ${parent}`}
      items={[
        { label: "Courses", href: "/courses", onNavigate },
        { label: "PRG1-2026", href: "/classrooms/r1", onNavigate },
        { label: "Labo 1" },
      ]}
    />
  );

  it("is a named navigation: links for the ancestors, the page itself last", () => {
    render(trail());
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Courses" })).toHaveAttribute("href", "/courses");
    expect(screen.getByRole("link", { name: "PRG1-2026" })).toHaveAttribute("href", "/classrooms/r1");
    expect(screen.queryByRole("link", { name: "Labo 1" })).toBeNull();
    expect(screen.getByText("Labo 1")).toHaveAttribute("aria-current", "page");
    // The separators are decoration.
    expect(nav.querySelectorAll("li[aria-hidden]")).toHaveLength(2);
  });

  it("offers the phone just the way back: a link named for the immediate parent", () => {
    const onNavigate = vi.fn();
    render(trail(onNavigate));
    const back = screen.getByRole("link", { name: "Back to PRG1-2026" });
    expect(back).toHaveAttribute("href", "/classrooms/r1");
    expect(back).toHaveClass("sm:hidden");
    expect(screen.getByRole("list")).toHaveClass("max-sm:hidden");
    expect(fireEvent.click(back)).toBe(false);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("keeps a location's current item beside the way back on a phone", () => {
    render(
      <Breadcrumb
        label="Path"
        backLabel={(parent) => `Back to ${parent}`}
        current="location"
        items={[
          { label: "All concepts", href: "/pools/p1", onNavigate: vi.fn() },
          { label: "Pointer", href: "/pools/p1?at=a", onNavigate: vi.fn() },
          { label: "Allocation" },
        ]}
      />,
    );
    expect(screen.getByText("Allocation")).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("link", { name: "Back to Pointer" })).toHaveClass("sm:hidden");
    expect(screen.getByRole("list")).not.toHaveClass("max-sm:hidden");
    // The ancestors and the separators give way on a phone; the current item stays.
    expect(screen.getByRole("link", { name: "Pointer" }).closest("li")).toHaveClass("max-sm:hidden");
    expect(screen.getByText("Allocation").closest("li")).not.toHaveClass("max-sm:hidden");
  });

  it("routes a plain click in the app and leaves a modified click to the browser", () => {
    const onNavigate = vi.fn();
    render(trail(onNavigate));
    const link = screen.getByRole("link", { name: "Courses" });
    expect(fireEvent.click(link)).toBe(false);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
