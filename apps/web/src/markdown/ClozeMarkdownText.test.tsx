import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { clozeStudentTemplate, parseCloze } from "@quiz/domain/cloze";

import { QuestionHost } from "../student/QuestionHost";
import { renderWithProviders } from "../test/render";
import { renderMarkdown } from "./render";

/*
 * Issue #100: a list in a question's text rendered in the editor and not in
 * the student view. For a cloze question the host never handed the package
 * its markdown pipeline, so the package's small fallback — paragraphs,
 * tables, fences — flattened `- a\n- b` into one line of text. These tests
 * go through the student host, exactly as the exam screen does.
 */

function studentOf(source: string) {
  return clozeStudentTemplate(parseCloze(source), 0, "test-item", false);
}

function renderCloze(source: string) {
  return renderWithProviders(
    <QuestionHost
      type="cloze"
      student={studentOf(source)}
      answer={null}
      onChange={() => {}}
      readOnly={false}
    />,
  );
}

describe("cloze text through the app's markdown pipeline", () => {
  it("renders a bulleted and a nested numbered list, with the blank inside its item", async () => {
    const { container } = renderCloze(
      "Rappel :\n\n- la tension U ;\n- la loi d'{{Ohm}} :\n  1. U = R × I,\n  2. en volts.",
    );
    const blank = await screen.findByRole("textbox", { name: /1/ });
    const body = container.querySelector(".md-body") as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.querySelectorAll("ul > li")).toHaveLength(2);
    expect(body.querySelectorAll("ul ol > li")).toHaveLength(2);
    expect(blank.closest("li")).not.toBeNull();
    // The sentinel itself never reaches the screen.
    expect(body.textContent).not.toMatch(/[⸢⸣-]/);
  });

  it("puts a blank inside a fenced block, where the highlighter would split the sentinel", async () => {
    const { container } = renderCloze("```c\nint x = {{42}};\n```");
    const blank = await screen.findByRole("textbox");
    expect(blank.closest("pre")).not.toBeNull();
    expect(container.querySelector("pre")?.textContent).not.toMatch(/[⸢⸣]/);
  });

  it("keeps a dropdown blank inside a table cell", async () => {
    renderCloze("| Grandeur | Unité |\n| --- | --- |\n| Tension | {{=volts|ohms}} |");
    const select = await screen.findByRole("combobox");
    expect(select.closest("td")).not.toBeNull();
  });
});

describe("renderMarkdown — holes", () => {
  it("turns each sentinel into an empty hole element carrying its index", () => {
    const html = renderMarkdown(studentOf("a {{x}} b {{y}}").template, "Code", { holes: true });
    expect(html).toContain('<span data-cloze-hole="0"></span>');
    expect(html).toContain('<span data-cloze-hole="1"></span>');
  });

  it("never lets the document write a hole of its own", () => {
    const forged = renderMarkdown('<span data-cloze-hole="0">x</span>', "Code", { holes: true });
    expect(forged).not.toContain("data-cloze-hole");
    // Without `holes`, a sentinel is text like any other.
    expect(renderMarkdown("a ⸢0⸣ b")).toContain("⸢0⸣");
  });
});
