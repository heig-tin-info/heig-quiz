/**
 * Player smoke tests, on the `<textarea>` fallback.
 *
 * Two properties matter here and are checked directly: a locked segment is not
 * in any editable control, and the Run button degrades to one readable line
 * when the runner is unavailable — which is the DEFAULT configuration of the
 * platform (decision D14), not an edge case.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodePlayer } from "./Player.js";
import { finalizeRunnerCode } from "./grade.js";
import { CodeConfig, type CodeAnswer } from "./schema.js";
import { codeServer } from "./server.js";
import { codeConfig, FINALIZE_CTX, outcome } from "./test/fixtures.js";

const student = codeServer.toStudent(codeConfig(), { seed: 7, itemId: "i", shuffle: false });

/** The primary button; while it cools down its name also says when it is back. */
const RUN_TESTS = /^Run the tests/;

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
    expect(screen.getByRole("button", { name: RUN_TESTS })).toBeDisabled();
  });

  it("honours `disabled` exactly as `readOnly`, like every other player", () => {
    setup({ disabled: true, onRun: async () => outcome([]) });
    expect(screen.getByLabelText("Your code, region 1")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: RUN_TESTS })).toBeDisabled();
  });

  it("hides the Run button entirely when the host wires no runner", () => {
    setup();
    expect(screen.queryByRole("button", { name: RUN_TESTS })).toBeNull();
    expect(screen.getByText("Visible cases")).toBeInTheDocument();
  });

  it("lists stdin, expected, got and a verdict for every visible case", async () => {
    setup({
      onRun: async () => outcome([{ stdout: "6\n" }, { stdout: "1" }]),
    });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));

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
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    expect(await screen.findByText("Timed out")).toBeInTheDocument();
    expect(screen.getByText("Out of memory")).toBeInTheDocument();
  });

  it("says the answer is safe when the runner is unavailable", async () => {
    setup({ onRun: async () => "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    expect(
      await screen.findByText(
        "Running is unavailable right now. Your answer is saved and will be graded by your teacher.",
      ),
    ).toBeInTheDocument();
  });

  it("survives a rejected run without losing the answer", async () => {
    setup({ onRun: async () => Promise.reject(new Error("network")) });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
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
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    expect(await screen.findByText("Crashed")).toBeInTheDocument();
    expect(screen.getByText("Not run")).toBeInTheDocument();
  });

  it("says 'Not run' for every case when the code did not compile", async () => {
    setup({
      onRun: async () => outcome([{ stdout: "6\n" }, { stdout: "0\n" }], { ok: false, stderr: "err" }),
    });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    expect(await screen.findAllByText("Not run")).toHaveLength(2);
    expect(screen.queryByText("Passed")).toBeNull();
  });

  it("names the check that failed rather than saying only 'Failed'", async () => {
    setup({ onRun: async () => outcome([{ exitCode: 1, stdout: "6\n" }, { stdout: "0\n" }]) });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
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
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    expect(await screen.findByText("Output truncated")).toBeInTheDocument();
  });

  it("does not say where the program runs: a student does nothing different about it", () => {
    setup({ student: { ...student, runtime: "runno" }, onRun: async () => outcome([]) });
    expect(screen.queryByText(/browser/i)).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
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
    const toggle = screen.getByRole("button", { name: "Free try" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Add an argument" }));
    fireEvent.change(screen.getByLabelText("Argument 1"), { target: { value: "hello world" } });
    fireEvent.keyDown(screen.getByLabelText("Argument 1"), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("Argument 2"), { target: { value: "7" } });
    expect(screen.getByLabelText("Command line")).toHaveTextContent("./prog 'hello world' 7");
    fireEvent.change(screen.getByLabelText("stdin"), { target: { value: "1 2\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    expect(await screen.findByLabelText("Output")).toHaveTextContent("42");
    // A space is part of an argument: one row, one argv entry.
    expect(seen).toEqual([{ args: ["hello world", "7"], stdin: "1 2\n" }]);

    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: /^Run once/ })).toBeNull();
  });

  it("hides the free input when the host cannot take one", () => {
    setup({ onRun: async () => outcome([]) });
    expect(screen.queryByRole("button", { name: "Free try" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Run once/ })).toBeNull();
  });

  it("takes its strings from the host", () => {
    setup({ strings: { runTests: "Lancer les tests" }, onRun: async () => outcome([]) });
    expect(screen.getByRole("button", { name: "Lancer les tests" })).toBeInTheDocument();
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

describe("the student's tools", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the whole cooldown of a server run go by (10 runs a minute: 6.5 s). */
  const waitOutCooldown = () => act(() => void vi.advanceTimersByTime(31_000));

  it("compiles without running, and shows the compiler's words", async () => {
    const seen: unknown[] = [];
    setup({
      onRun: async (_answer, options) => {
        seen.push(options?.compileOnly);
        return outcome([], { ok: false, stderr: "main.c:3: error: expected ';'" });
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    expect(await screen.findByText("main.c:3: error: expected ';'")).toBeInTheDocument();
    expect(screen.getByText("Compilation failed")).toBeInTheDocument();
    expect(seen).toEqual([true]);
  });

  it("refills after a run, and says when the buttons are back", async () => {
    setup({ onRun: async () => outcome([{ stdout: "6\n" }, { stdout: "0\n" }]) });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    await screen.findByText("Compiled");
    // The server budget of 10 runs a minute floors the wait at 6.5 s.
    const tests = screen.getByRole("button", { name: /^Run the tests/ });
    expect(tests).toBeDisabled();
    expect(tests).toHaveAccessibleName("Run the tests. Available in 7 s");
    expect(screen.getAllByTestId("cooldown-fill").length).toBeGreaterThan(0);
    // Compile is not held back: its budget is its own (#129).
    expect(screen.getByRole("button", { name: "Compile" })).toBeEnabled();
    await waitOutCooldown();
    expect(screen.queryByTestId("cooldown-fill")).toBeNull();
  });

  it("gives Compile no cooldown, and starts none for the other tools (#129)", async () => {
    const seen: unknown[] = [];
    setup({
      allowManualRun: true,
      onRun: async (_answer, options) => {
        seen.push(options?.compileOnly === true);
        return outcome([], { ok: true, stderr: "" });
      },
    });
    const compile = screen.getByRole("button", { name: "Compile" });
    fireEvent.click(compile);
    await screen.findByText("Compiled");
    // Ready at once, with the same code, and nothing refilling anywhere.
    expect(compile).toBeEnabled();
    expect(compile).toHaveAccessibleName("Compile");
    expect(screen.queryByTestId("cooldown-fill")).toBeNull();
    expect(screen.getByRole("button", { name: RUN_TESTS })).toBeEnabled();
    fireEvent.click(compile);
    await waitFor(() => expect(seen).toEqual([true, true]));
  });

  it("has no server floor in the browser: 3 s", async () => {
    setup({
      student: { ...student, runtime: "runno" },
      onRun: async () => outcome([{ stdout: "6\n" }, { stdout: "0\n" }]),
    });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    await screen.findByText("Compiled");
    expect(screen.getByRole("button", { name: RUN_TESTS })).toHaveAccessibleName(
      "Run the tests. Available in 3 s",
    );
    await act(() => void vi.advanceTimersByTime(3100));
    expect(screen.queryByTestId("cooldown-fill")).toBeNull();
  });

  it("runs the same code again once the cooldown ends, keeping its results (#129)", async () => {
    // A host that echoes each change back as the answer, like the real one.
    function Host() {
      const [answer, setAnswer] = useState<CodeAnswer | null>(null);
      return (
        <CodePlayer
          student={student}
          answer={answer}
          onChange={setAnswer}
          readOnly={false}
          monaco={false}
          onRun={async () => outcome([{ stdout: "6\n" }, { stdout: "0\n" }])}
        />
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    expect(await screen.findAllByText("Passed")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^Run the tests/ })).toBeDisabled();
    await waitOutCooldown();

    // The code did not change, and the button is back all the same.
    expect(screen.getByRole("button", { name: RUN_TESTS })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Compile" })).toBeEnabled();
    expect(screen.getAllByText("Passed")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Run the tests/ })).toBeDisabled(),
    );
    expect(await screen.findAllByText("Passed")).toHaveLength(2);
  });

  it("does not rest after a run that answered nothing", async () => {
    setup({ onRun: async () => "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    await screen.findByText(/Running is unavailable right now/);
    await waitOutCooldown();
    expect(screen.getByRole("button", { name: RUN_TESTS })).toBeEnabled();
  });

  it("says to wait when the budget refuses a run", async () => {
    setup({ onRun: async () => "rate_limited" });
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));
    expect(await screen.findByText(/Too many runs in a minute/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compile" })).toBeEnabled();
  });

  it("holds the free try for its cooldown, then lets the same input run again", async () => {
    setup({ allowManualRun: true, onRun: async () => outcome([{ stdout: "1\n" }]) });
    fireEvent.click(screen.getByRole("button", { name: "Free try" }));
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    await screen.findByLabelText("Output");
    expect(screen.getByRole("button", { name: /^Run once/ })).toBeDisabled();
    // It shares the tests' clock: both spend the same server budget.
    expect(screen.getByRole("button", { name: /^Run the tests/ })).toBeDisabled();
    await waitOutCooldown();
    expect(screen.getByRole("button", { name: "Run once" })).toBeEnabled();
    expect(screen.getByLabelText("Output")).toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
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
    fireEvent.click(screen.getByRole("button", { name: RUN_TESTS }));
    expect(await screen.findByText("Output differs")).toBeInTheDocument();
  });
});
