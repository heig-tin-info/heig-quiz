import { screen, waitFor, within } from "@testing-library/react";
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

  it("still offers a blank the markdown gave no text to sit in, after the text", async () => {
    const { container } = renderCloze(
      "Voir [le site]({{https://heig-vd.ch}}), ![{{alt}}](asset:abc) <!-- {{c}} --> et {{d}}.",
    );
    // All four blanks can be answered: the grader marks all four.
    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(4));
    const orphans = container.querySelector("[data-cloze-orphans]") as HTMLElement;
    expect(orphans).not.toBeNull();
    expect(within(orphans).getAllByRole("textbox")).toHaveLength(3);
    expect(within(orphans).queryByRole("textbox", { name: /4/ })).toBeNull();
  });

  it("takes a blank out of the link it was written in, keeping the link's text", async () => {
    const { container } = renderCloze("Lisez [la page {{a}} du cours](https://heig-vd.ch).");
    const blank = await screen.findByRole("textbox");
    // A field inside `<a target=_blank>` opens a tab when clicked, and a tab
    // switch is an integrity event logged against the student.
    expect(blank.closest("a")).toBeNull();
    expect(container.querySelector(".md-body a")).toBeNull();
    expect(container.querySelector(".md-body")?.textContent).toContain("la page");
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
    // Private-use characters spelled as entities do not forge one either: a
    // run carries a per-render nonce, and only the parser's indices count.
    const template = studentOf("a {{x}} b").template;
    const entities = renderMarkdown(`${template} &#xE000;&#xE010;&#xE001;`, "Code", { holes: true });
    expect(entities.match(/data-cloze-hole/g)).toHaveLength(1);
    expect(entities).not.toMatch(/[\uE000-\uE1FF]/);
    const alone = renderMarkdown("&#xE000;&#xE010;&#xE001; x", "Code", { holes: true });
    expect(alone).not.toContain("data-cloze-hole");
    // Without `holes`, a sentinel is text like any other.
    expect(renderMarkdown("a ⸢0⸣ b")).toContain("⸢0⸣");
  });
});
