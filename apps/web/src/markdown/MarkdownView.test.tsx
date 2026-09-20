import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { MarkdownView } from "./MarkdownView";
import { assetMarkdown, assetUrl, renderMarkdown } from "./render";

/*
 * The sanitising pipeline is the whole point of this component, so most of
 * what follows is an attack and its expected outcome. If one of these ever
 * goes green with the wrong answer, a question prompt has become a script
 * tag on the screen of thirty students under exam conditions.
 */

/** Renders and returns the container, so a test can query the raw DOM. */
function view(source: string) {
  const { container } = renderWithProviders(<MarkdownView source={source} />);
  return container.querySelector(".md-body") as HTMLElement;
}

describe("MarkdownView — sanitisation", () => {
  it("strips a <script> block entirely", () => {
    const body = view("Before\n\n<script>alert('xss')</script>\n\nAfter");
    expect(body.querySelector("script")).toBeNull();
    expect(body.innerHTML).not.toContain("alert");
    expect(body.textContent).toContain("Before");
    expect(body.textContent).toContain("After");
  });

  it("strips an event handler attribute", () => {
    const body = view('<p onerror="alert(1)" onclick="alert(2)">boom</p>');
    expect(body.innerHTML).not.toContain("onerror");
    expect(body.innerHTML).not.toContain("onclick");
    expect(body.textContent).toContain("boom");
  });

  it("drops a javascript: link and the anchor with it, keeping the text", () => {
    const body = view("[click me](javascript:alert(1))");
    // No anchor at all: an <a> with no href would promise a link that does
    // nothing, underlined in the accent colour.
    expect(body.querySelector("a")).toBeNull();
    expect(body.textContent).toContain("click me");
  });

  it("drops an external image, in markdown and in raw HTML alike", () => {
    const body = view(
      '![pixel](https://evil.example/p.png)\n\n<img src="https://evil.example/q.png" onerror="alert(1)">',
    );
    expect(body.querySelectorAll("img")).toHaveLength(0);
    expect(body.innerHTML).not.toContain("evil.example");
    // The alt text stays, so the teacher sees the image did not take.
    expect(body.textContent).toContain("pixel");
  });

  it("refuses a data: URI image", () => {
    const body = view("![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)");
    expect(body.querySelector("img")).toBeNull();
  });

  it("keeps an http link but sends it to its own tab without a referrer", () => {
    const body = view("[docs](https://example.org/a)");
    const link = body.querySelector("a")!;
    expect(link).toHaveAttribute("href", "https://example.org/a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("MarkdownView — assets", () => {
  it("rewrites asset:<id> to the same-origin endpoint", () => {
    const body = view(assetMarkdown("abc-123", "a diagram"));
    const img = body.querySelector("img")!;
    expect(img).toHaveAttribute("src", "/app/api/assets/abc-123");
    expect(img).toHaveAttribute("alt", "a diagram");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("recognises an asset reference and nothing else", () => {
    expect(assetUrl("asset:xyz")).toBe("/app/api/assets/xyz");
    expect(assetUrl("asset:../../etc/passwd")).toBeNull();
    expect(assetUrl("https://example.org/a.png")).toBeNull();
  });
});

describe("MarkdownView — content", () => {
  it("renders KaTeX for inline and display math", () => {
    const body = view("Inline $x^2$ and display:\n\n$$\\frac{a}{b}$$");
    expect(body.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(body.querySelector(".md-math-display")).not.toBeNull();
    // KaTeX's own markup survived sanitisation (it is produced after it).
    expect(body.innerHTML).toContain("katex-html");
  });

  it("leaves a dollar sign inside code alone", () => {
    const body = view("```sh\necho $HOME\n```");
    expect(body.querySelector("code")?.textContent).toContain("$HOME");
    expect(body.querySelector(".katex")).toBeNull();
  });

  it("gives a fenced block its language class and token spans", () => {
    const body = view('```c\nint n = 3; // note\n```');
    const code = body.querySelector("pre code")!;
    expect(code).toHaveClass("language-c");
    expect(code.querySelector(".tok-kw")?.textContent).toBe("int");
    expect(code.querySelector(".tok-num")?.textContent).toBe("3");
    expect(code.querySelector(".tok-com")?.textContent).toBe("// note");
  });

  /*
   * W10: a fenced block scrolls sideways at 390 px, and a scroll container
   * with nothing focusable inside it cannot be reached from a keyboard at
   * all — a student with no mouse could not read past the fold.
   */
  it("makes a fenced block a focusable, named scroll region", () => {
    const body = view('```c\nint n = 3;\n```');
    const pre = body.querySelector("pre")!;
    expect(pre).toHaveAttribute("tabindex", "0");
    // A group and not a landmark: two fences in one prompt would otherwise be
    // two landmarks with the same name.
    expect(pre).toHaveAttribute("role", "group");
    expect(pre).toHaveAccessibleName("Code block, scrollable");
  });

  it("names the block in French when the locale does (N-I18N-01)", () => {
    const { container } = renderWithProviders(<MarkdownView source={'```c\nint n;\n```'} />, {
      locale: "fr",
    });
    expect(container.querySelector("pre")).toHaveAccessibleName("Bloc de code, défilable");
  });

  it("renders a GFM table", () => {
    const body = view("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(body.querySelectorAll("th")).toHaveLength(2);
    expect(body.querySelectorAll("tbody td")).toHaveLength(2);
  });

  it("renders a task list, always disabled", () => {
    const body = view("- [x] done\n- [ ] todo");
    const boxes = body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).toBeDisabled();
  });

  it("renders nothing at all for empty source", () => {
    const { container } = renderWithProviders(<MarkdownView source={"   \n  "} />);
    expect(container.querySelector(".md-body")).toBeNull();
    expect(renderMarkdown("")).toBe("");
  });

  it("takes the dense variant and an inline host when asked", () => {
    renderWithProviders(<MarkdownView source="**hi**" size="sm" as="span" className="mine" />);
    const body = document.querySelector(".md-body")!;
    expect(body.tagName).toBe("SPAN");
    expect(body).toHaveClass("md-sm", "mine");
    expect(screen.getByText("hi").tagName).toBe("STRONG");
  });
});
