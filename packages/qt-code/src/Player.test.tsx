/**
 * Player smoke tests, on the `<textarea>` fallback.
 *
 * Two properties matter here and are checked directly: a locked segment is not
 * in any editable control, and the Run button degrades to one readable line
 * when the runner is unavailable — which is the DEFAULT configuration of the
 * platform (decision D14), not an edge case.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodePlayer } from "./Player.js";
import { finalizeRunnerCode } from "./grade.js";
import { CodeConfig, type CodeAnswer } from "./schema.js";
import { codeServer } from "./server.js";
import { codeConfig, FINALIZE_CTX, outcome } from "./test/fixtures.js";

const student = codeServer.toStudent(codeConfig(), { seed: 7, itemId: "i", shuffle: false });

function setup(overrides: Partial<React.ComponentProps<typeof CodePlayer>> = {}) {
  const onChange = vi.fn<(next: CodeAnswer) => void>();
  render(
    <CodePlayer
      student={student}
      answer={null}
      onChange={onChange}
      readOnly={false}
      monaco={false}
      {...overrides}
    />,
  );
  return { onChange };
}

describe("CodePlayer", () => {
  it("shows the prompt, the limits and the hidden-case count", () => {
    setup();
    expect(screen.getByText("Sum the integers read on stdin.")).toBeInTheDocument();
    expect(screen.getByText("2000 ms · 128 MB")).toBeInTheDocument();
    expect(screen.getByText("1 hidden case, worth 2 point(s).")).toBeInTheDocument();
  });

  it("gives one editor per editable region and no control for the locked ones", () => {
    setup();
    const editors = screen.getAllByRole("textbox");
    expect(editors).toHaveLength(2);
    expect(screen.getByLabelText("Your code, region 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Your code, region 2")).toBeInTheDocument();

    // The locked body is readable, marker lines removed, and inside no control.
    const locked = screen.getAllByLabelText("Locked — provided by your teacher");
    expect(locked).toHaveLength(2);
    expect(locked[0]?.textContent).toContain("int sum(const int *t, int n)");
    expect(locked[0]?.textContent).not.toContain("@@lock");
    for (const block of locked) expect(block.querySelector("textarea")).toBeNull();
  });

  it("seeds an untouched region from the template and reports the whole set on a change", () => {
    const { onChange } = setup();
    const second = screen.getByLabelText("Your code, region 2");
    expect(second).toHaveValue("    int total = 0;\n    return total;\n");

    fireEvent.change(second, { target: { value: "    return 42;\n" } });
    expect(onChange).toHaveBeenCalledWith({
      regions: ["#include <stdio.h>\n", "    return 42;\n"],
    });
  });

  it("is read-only once the attempt is submitted", () => {
    setup({ readOnly: true, onRun: async () => outcome([]) });
    expect(screen.getByLabelText("Your code, region 1")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("hides the Run button entirely when the host wires no runner", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.getByText("Visible cases")).toBeInTheDocument();
  });

  it("lists stdin, expected, got and a verdict for every visible case", async () => {
    setup({
      onRun: async () => outcome([{ stdout: "6\n" }, { stdout: "1" }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("Compiled")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    // Not "Failed": the verdict names the check that did not hold.
    expect(screen.getByText("Output differs")).toBeInTheDocument();
    // The hidden case is not in the table: it is not run interactively.
    expect(screen.queryByText("negative-values")).toBeNull();
  });

  it("marks a case that timed out or ran out of memory as such", async () => {
    setup({
      onRun: async () => outcome([{ timedOut: true }, { oom: true }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Timed out")).toBeInTheDocument();
    expect(screen.getByText("Out of memory")).toBeInTheDocument();
  });

  it("says the answer is safe when the runner is unavailable", async () => {
    setup({ onRun: async () => "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(
      await screen.findByText(
        "Running is unavailable right now. Your answer is saved and will be graded by your teacher.",
      ),
    ).toBeInTheDocument();
  });

  it("survives a rejected run without losing the answer", async () => {
    setup({ onRun: async () => Promise.reject(new Error("network")) });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(
      await screen.findByText(
        "The run could not be completed. Your answer is saved; try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Your code, region 1")).toBeInTheDocument();
  });

  it("says 'Crashed' for a process with no exit code, and 'Not run' for a missing result", async () => {
    // Case 1 was killed (no exit code of its own); the runner sent nothing back
    // for case 2 — both labels come from `caseVerdict`'s failure.
    setup({ onRun: async () => outcome([{ exitCode: null, stdout: "6\n" }]) });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Crashed")).toBeInTheDocument();
    expect(screen.getByText("Not run")).toBeInTheDocument();
  });

  it("says 'Not run' for every case when the code did not compile", async () => {
    setup({
      onRun: async () => outcome([{ stdout: "6\n" }, { stdout: "0\n" }], { ok: false, stderr: "err" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findAllByText("Not run")).toHaveLength(2);
    expect(screen.queryByText("Passed")).toBeNull();
  });

  it("names the check that failed rather than saying only 'Failed'", async () => {
    setup({ onRun: async () => outcome([{ exitCode: 1, stdout: "6\n" }, { stdout: "0\n" }]) });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    // Case 1 prints the right thing but leaves with 1, and the case wants 0.
    expect(await screen.findByText("exit 1 ≠ 0")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
  });

  it("shows a case's command line next to its stdin", () => {
    const withArgs = {
      ...student,
      visibleCases: student.visibleCases.map((c, i) =>
        i === 0 ? { ...c, args: ["3", "4"] } : c,
      ),
    };
    setup({ student: withArgs, onRun: async () => outcome([]) });
    expect(screen.getByText("$ program 3 4")).toBeInTheDocument();
  });

  it("flags a run whose output was cut at the limit", async () => {
    setup({ onRun: async () => outcome([{ stdout: "6\n", truncated: true }, { stdout: "0\n" }]) });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Output truncated")).toBeInTheDocument();
  });

  it("says where the program runs when the browser is the one running it", () => {
    setup({ student: { ...student, runtime: "runno" }, onRun: async () => outcome([]) });
    expect(screen.getByText("Runs in your browser — the server grades.")).toBeInTheDocument();
  });

  it("keeps quiet about the browser when the server is the one running it", () => {
    setup({ onRun: async () => outcome([]) });
    expect(screen.queryByText("Runs in your browser — the server grades.")).toBeNull();
  });

  it("announces the runtime download, which only happens once", async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setup({
      onRun: async (_answer, options) => {
        options?.onStage?.("loading");
        await held;
        return outcome([]);
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(
      await screen.findByText("Loading the language runtime… this happens once."),
    ).toBeInTheDocument();
    release?.();
  });

  it("offers the free input only where the host can honour it", async () => {
    const seen: unknown[] = [];
    setup({
      allowManualRun: true,
      onRun: async (_answer, options) => {
        seen.push(options?.manual);
        return outcome([{ stdout: "42\n", exitCode: 0 }]);
      },
    });
    fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: "-v\n7" } });
    fireEvent.change(screen.getByLabelText("stdin"), { target: { value: "1 2\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    expect(await screen.findByLabelText("Output")).toHaveTextContent("42");
    expect(seen).toEqual([{ args: ["-v", "7"], stdin: "1 2\n" }]);
  });

  it("hides the free input when the host cannot take one", () => {
    setup({ onRun: async () => outcome([]) });
    expect(screen.queryByRole("button", { name: "Run once" })).toBeNull();
  });

  it("takes its strings from the host", () => {
    setup({ strings: { run: "Exécuter" }, onRun: async () => outcome([]) });
    expect(screen.getByRole("button", { name: "Exécuter" })).toBeInTheDocument();
  });

  it("renders the prompt through the host's markdown renderer", () => {
    setup({ renderMarkdown: (source) => <em data-testid="md">{source}</em> });
    expect(screen.getByTestId("md")).toHaveTextContent("Sum the integers read on stdin.");
  });

  it("falls back to plain text when the host passes no renderer", () => {
    setup();
    expect(screen.queryByTestId("md")).toBeNull();
    expect(screen.getByText("Sum the integers read on stdin.")).toBeInTheDocument();
  });
});

/**
 * The fix of audit R-06: a question whose teacher chose non-default
 * comparison options used to read "Output differs" in the player while the
 * grade gave full marks (ADR-015 §2). The player and the grade now ask the
 * same `caseVerdict`, with the same options — asserted here side by side, for
 * one option of each kind and for the default as a control.
 */
describe("the player and the grade agree (audit R-06)", () => {
  function withCompare(compare: object, cases: Array<{ expected: string }>) {
    return CodeConfig.parse({
      ...codeConfig(),
      tests: {
        mode: "io",
        compare,
        cases: cases.map((c, i) => ({ name: `case ${i + 1}`, stdin: "", ...c, visible: true, points: 1 })),
      },
    });
  }

  const cases = [
    {
      name: "ignoreCase",
      config: withCompare({ ignoreCase: true }, [{ expected: "Hello World\n" }, { expected: "OK\n" }]),
      stdout: ["hello world\n", "ok\n"],
    },
    {
      name: "a numeric epsilon",
      config: withCompare({ numeric: { epsilon: 0.001, mode: "abs" } }, [
        { expected: "3.14159\n" },
        { expected: "2.71828 1.41421\n" },
      ]),
      stdout: ["3.1416\n", "2.7183 1.4142\n"],
    },
  ];

  for (const { name, config, stdout } of cases) {
    it(`passes both in the player and in the grade, with ${name}`, async () => {
      const run = outcome(stdout.map((s) => ({ stdout: s })));
      const grade = finalizeRunnerCode(config, { regions: ["a", "b"] }, FINALIZE_CTX, run);
      expect(grade.details.cases.map((c) => c.ok)).toEqual([true, true]);

      const view = codeServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false });
      render(
        <CodePlayer
          student={view}
          answer={null}
          onChange={() => {}}
          readOnly={false}
          monaco={false}
          onRun={async () => run}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(await screen.findAllByText("Passed")).toHaveLength(2);
      expect(screen.queryByText("Output differs")).toBeNull();
    });
  }

  it("fails both places under the default options (the control)", async () => {
    const config = withCompare({}, [{ expected: "Hello World\n" }]);
    const run = outcome([{ stdout: "hello world\n" }]);
    expect(finalizeRunnerCode(config, { regions: ["a", "b"] }, FINALIZE_CTX, run).details.cases[0]?.ok).toBe(
      false,
    );
    const view = codeServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false });
    render(
      <CodePlayer
        student={view}
        answer={null}
        onChange={() => {}}
        readOnly={false}
        monaco={false}
        onRun={async () => run}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Output differs")).toBeInTheDocument();
  });
});
