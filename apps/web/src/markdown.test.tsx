import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { linkTarget, Markdown } from "./markdown";

const here = window.location.origin;

describe("linkTarget", () => {
  it("lets the help we write link anywhere on the web, never to a script", () => {
    expect(linkTarget("https://heig-vd.ch/x", "web")).toEqual({ href: "https://heig-vd.ch/x", external: true });
    expect(linkTarget("javascript:alert(1)", "web")).toBeNull();
    expect(linkTarget("/pools", "web")).toBeNull();
  });

  it("lets an assistant's answer link to this app only (ADR-080 P2, item 8)", () => {
    expect(linkTarget(`${here}/pools/abc?tab=x#y`, "same-origin")).toEqual({ href: "/pools/abc?tab=x#y", external: false });
    expect(linkTarget("/classrooms/abc", "same-origin")).toEqual({ href: "/classrooms/abc", external: false });
    for (const href of [
      "https://evil.example/collect?names=Ada%20Doe",
      "//evil.example/x",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "mailto:someone@evil.example?body=grades",
      `https://evil.example/${here}`,
    ]) {
      expect(linkTarget(href, "same-origin"), href).toBeNull();
    }
  });
});

describe("Markdown links", () => {
  it("renders a foreign link of an answer as plain text, and the app's own as a link", () => {
    render(
      <Markdown
        links="same-origin"
        source={`See [the pool](${here}/pools/p1) or [this summary](https://evil.example/c?d=Ada%20Doe).`}
      />,
    );
    expect(screen.getByRole("link", { name: "the pool" })).toHaveAttribute("href", "/pools/p1");
    expect(screen.queryByRole("link", { name: "this summary" })).toBeNull();
    expect(screen.getByText(/this summary/)).toBeVisible();
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  it("keeps the help's external links, in a new tab", () => {
    render(<Markdown source="Read [the docs](https://heig-vd.ch/docs)." />);
    const link = screen.getByRole("link", { name: "the docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
