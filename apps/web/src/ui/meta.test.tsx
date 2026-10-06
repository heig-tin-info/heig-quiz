import { fireEvent, render, screen } from "@testing-library/react";
import { Lock } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { Breadcrumb } from "./breadcrumb";
import { MetaItem, MetaLine } from "./meta";

describe("MetaItem", () => {
  it("draws a decorative icon beside its text", () => {
    const { container } = render(
      <MetaLine>
        <MetaItem icon={Lock}>indicative</MetaItem>
      </MetaLine>,
    );
    expect(screen.getByText("indicative")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveClass("size-3.5", "text-fg-faint");
  });

  it("names an icon that carries a meaning the text does not", () => {
    render(<MetaItem icon={Lock} label="Score at the deadline">7 / 10</MetaItem>);
    expect(screen.getByRole("img", { name: "Score at the deadline" })).toBeInTheDocument();
  });
});

describe("Breadcrumb", () => {
  const trail = (onNavigate = vi.fn()) => (
    <Breadcrumb
      label="Breadcrumb"
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
