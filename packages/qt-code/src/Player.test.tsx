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
import type { CodeAnswer } from "./schema.js";
import { codeServer } from "./server.js";
import { codeConfig, outcome } from "./test/fixtures.js";

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
    expect(screen.getByText("Failed")).toBeInTheDocument();
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

  it("takes its strings from the host", () => {
    setup({ strings: { run: "Exécuter" }, onRun: async () => outcome([]) });
    expect(screen.getByRole("button", { name: "Exécuter" })).toBeInTheDocument();
  });
});
