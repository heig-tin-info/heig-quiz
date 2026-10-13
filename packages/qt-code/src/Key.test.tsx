/**
 * The program answer key of the debrief (ADR-033, ADR-109), for `code` and
 * `codeimage`: hidden, the code the class started from; revealed, the
 * reference whole, the host's test cases beside it and its answer groups
 * under it.
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { splitTemplate } from "@quiz/domain/lockedTemplate";
import { keyHostProps } from "@quiz/ui/testing";

import { ProgramKey } from "./Key.js";
import type { ProgramStudent } from "./schema.js";

const TEMPLATE = "#include <stdio.h>\n\nint main(int argc, char* argv[]) {\n\n}\n";
const REFERENCE = '#include <stdio.h>\n\nint main(int argc, char* argv[]) {\n    printf("%07d\\n", argc);\n}\n';
const LOCKED = "int f(void) {\n// @@lock\n    int x = 1;\n// @@endlock\n    return 0;\n}\n";

const program = (template: string | null) =>
  ({ prompt: "Print `argc`.", segments: template === null ? [] : splitTemplate(template, "c") }) as unknown as ProgramStudent;

const grouped = { distribution: [{ key: "100", label: "100 %", count: 2, correct: true, part: null }] };

const draw = ({
  revealed = true,
  student = program(TEMPLATE),
  reference = REFERENCE as string | null,
  cases = null as ReactNode,
  stats = {},
} = {}) =>
  render(
    <ProgramKey
      {...keyHostProps(stats)}
      student={student}
      solution={reference === null ? null : { referenceSolution: reference }}
      revealed={revealed}
      prompt={<p>the prompt</p>}
      rows={<p>the rows</p>}
      cases={cases}
    />,
  );

describe("ProgramKey", () => {
  it("shows the starting code while hidden, named as such, never the reference", () => {
    draw({ revealed: false });
    expect(screen.getByRole("region", { name: "Starting code" }).textContent).toBe(TEMPLATE);
    expect(screen.queryByText(/printf/)).toBeNull();
  });

  it("shows the reference, whole, once revealed, under the prompt", () => {
    draw();
    const code = screen.getByRole("region", { name: "Reference solution" });
    expect(code.textContent).toBe(REFERENCE);
    const prompt = screen.getByText("the prompt");
    expect(prompt.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws a reference cut on `@@next` lines inside its template's locked text", () => {
    draw({ student: program(LOCKED), reference: "int f(void) {\n// @@next\n    return x;" });
    expect(screen.getByRole("region", { name: "Reference solution" }).textContent).toBe(
      "int f(void) {\n    int x = 1;\n    return x;\n",
    );
  });

  it("draws the raw reference when the template cannot hold it", () => {
    draw({ student: { prompt: "p" } as unknown as ProgramStudent, reference: "return a + b;" });
    expect(screen.getByRole("region", { name: "Reference solution" }).textContent).toBe("return a + b;");
  });

  it("names the hatched block of a program with no template to start from", () => {
    draw({ revealed: false, student: program(null) });
    expect(screen.getByText("Reference solution, hidden until the answers are revealed")).toBeVisible();
    expect(screen.queryByRole("region")).toBeNull();
    // The hidden reference is not in the page at all, not even transparent.
    expect(document.body.textContent).not.toContain("printf");
  });

  it("sets the host's test cases beside the code, and draws them alone without a reference", () => {
    draw({ cases: <ul aria-label="the cases" /> });
    const code = screen.getByRole("region", { name: "Reference solution" });
    expect(code.closest("figure")!.parentElement).toBe(screen.getByRole("list", { name: "the cases" }).parentElement);

    draw({ reference: "  ", cases: <ul aria-label="lone cases" /> });
    expect(screen.getByRole("list", { name: "lone cases" })).toBeVisible();
  });

  it("draws nothing but the prompt with neither a reference nor a case", () => {
    const { container } = draw({ reference: null });
    expect(container.textContent).toBe("the prompt");
  });

  it("lists a code image's accuracy buckets under the program, never lone blanks", () => {
    draw({ stats: grouped });
    const code = screen.getByRole("region", { name: "Reference solution" });
    const rows = screen.getByText("the rows");
    expect(code.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    draw({ stats: { distribution: [] } });
    expect(screen.getAllByText("the rows")).toHaveLength(1);
  });

  it("takes the host's words", () => {
    render(
      <ProgramKey
        {...keyHostProps()}
        student={program(TEMPLATE)}
        solution={{ referenceSolution: REFERENCE }}
        revealed
        strings={{ reference: "Solution de référence" }}
      />,
    );
    expect(screen.getByRole("region", { name: "Solution de référence" })).toBeVisible();
  });
});
