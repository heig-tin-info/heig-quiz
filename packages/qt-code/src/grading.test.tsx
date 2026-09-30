/**
 * The `code` column of the grading table (ADR-044): the program as the
 * student wrote it in a clamped box as wide as the column, and a chip that
 * says how its run went, read from the grading's breakdown.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { codeGrading, programText, referenceText } from "./grading.js";
import type { CodeDetails } from "./schema.js";
import { codeServer } from "./server.js";
import { codeConfig } from "./test/fixtures.js";

const view = { seed: 3, itemId: "i", shuffle: false };
const config = codeConfig();
const student = codeServer.toStudent(config, view);
const solution = codeServer.toSolution(config, view);
const [column] = codeGrading.columns(student, solution);

const LONG = ["    int total = 0;", "    for (int i = 0; i < n; i++)", "        total += t[i];", "    return total;"];
const answer = { regions: [LONG.join("\n") + "\n", "    // done\n    return 0;\n"] };

function details(oks: boolean[], over: Partial<CodeDetails> = {}): CodeDetails {
  return {
    runner: "ok",
    compile: { ok: true, stderr: "", ms: 10 },
    cases: oks.map((ok, i) => ({
      name: `case ${i}`,
      visible: true,
      points: 1,
      ok,
      exitCode: 0,
      ms: 1,
      timedOut: false,
      oom: false,
    })),
    earned: oks.filter(Boolean).length,
    total: oks.length,
    sourceSha256: null,
    ...over,
  };
}

const chipOf = (d: CodeDetails | null) => {
  const { container } = render(<>{column!.cell({ answer, details: d })}</>);
  return container.querySelector("span[title]")!;
};

describe("code grading column", () => {
  it("is one column, the program", () => {
    expect(codeGrading.columns(student, solution).map((c) => c.key)).toEqual(["program"]);
    expect(column!.label).toBe("Program");
  });

  it("shows what the student wrote, region after region, dedented", () => {
    expect(programText(answer.regions)).toBe(
      "int total = 0;\nfor (int i = 0; i < n; i++)\n    total += t[i];\nreturn total;\n\n// done\nreturn 0;",
    );
    expect(programText(["  ", ""])).toBe("");
    expect(programText(["\n\n  int x;\n"])).toBe("int x;");
  });

  it("clamps the program to five lines and unfolds it on a click that stays in the cell", () => {
    let opened = 0;
    render(
      <table>
        <tbody>
          <tr onClick={() => (opened += 1)}>
            <td>{column!.cell({ answer, details: null })}</td>
          </tr>
        </tbody>
      </table>,
    );
    const box = screen.getByRole("button", { expanded: false });
    expect(box.querySelector("pre")!.className).toContain("w-full");
    expect(screen.getByText(/2 more lines/)).toBeInTheDocument();
    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(opened).toBe(0);
  });

  it("counts the tests passed, coloured by the verdict", () => {
    expect(chipOf(details([true, true])).textContent).toBe("2/2 tests");
    expect(chipOf(details([true, true])).className).toContain("bg-success-soft");
    expect(chipOf(details([true, false])).className).toContain("outline-dashed");
    expect(chipOf(details([false, false])).className).toContain("bg-danger-soft");
    expect(chipOf(details([true])).textContent).toBe("1/1 test");
  });

  it("says when the runner still owes the verdict, or when the program did not compile", () => {
    expect(chipOf(null).textContent).toBe("runner…");
    expect(chipOf(details([], { runner: "unavailable" })).textContent).toBe("runner…");
    expect(chipOf(details([], { compile: { ok: false, stderr: "", ms: 1 } })).textContent).toBe(
      "Does not compile",
    );
  });

  it("reads a marker the grading pass left instead of a breakdown", () => {
    const marker = (reason: string) => ({ reason }) as unknown as CodeDetails;
    expect(chipOf(marker("runner_unavailable")).textContent).toBe("runner…");
    expect(chipOf(marker("template_region_mismatch")).textContent).toBe("Not run");
  });

  it("says nothing of a run on a teacher's override", () => {
    const { container } = render(
      <>{column!.cell({ answer, details: { manual: true } as unknown as CodeDetails })}</>,
    );
    expect(container.querySelector("span[title]")).toBeNull();
    expect(container.textContent).not.toMatch(/Not run|runner…|tests/);
  });

  it("puts the reference solution on the expected row, in info", () => {
    render(<>{column!.expected()}</>);
    expect(screen.getByText(referenceText(config.referenceSolution)).className).toContain("text-info");
    render(<>{codeGrading.columns(student, null)[0]!.expected()}</>);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("sorts by the program, normalised", () => {
    expect(column!.sortKey({ regions: ["  Return  1;\n"] })).toBe("return 1;");
    expect(column!.sortKey(null)).toBe("");
  });
});
