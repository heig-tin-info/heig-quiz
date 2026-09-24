/**
 * Editor smoke tests, on the `<textarea>` fallback.
 *
 * Monaco never loads here: `monacoAvailable()` is false under jsdom, and the
 * tests pass `monaco={false}` as well so the surface under test is explicit.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CodeEditor } from "./Editor.js";
import { monacoAvailable } from "./MonacoHost.js";
import { CodeConfig } from "./schema.js";
import { codeConfig, configFor, outcome } from "./test/fixtures.js";

/**
 * The fixture template has TWO editable regions, so its reference solution
 * only fits once it is cut in two by a `@@next` line (`./reference.ts`). The
 * helper writes that split, because a try must not be tested on a reference
 * the editor is right to refuse.
 */
const withSplitReference = (): CodeConfig => ({
  ...codeConfig(),
  referenceSolution: ["#include <stdio.h>", "/* @@next */", "    return 6;"].join("\n"),
});

function setup(overrides: Partial<React.ComponentProps<typeof CodeEditor>> = {}) {
  const onChange = vi.fn<(next: CodeConfig) => void>();
  const config = codeConfig();
  render(
    <CodeEditor
      config={config}
      onChange={onChange}
      uploadAsset={async () => "asset:none"}
      monaco={false}
      {...overrides}
    />,
  );
  return { config, onChange };
}

describe("CodeEditor", () => {
  it("falls back to the textarea, because jsdom cannot run Monaco", () => {
    expect(monacoAvailable()).toBe(false);
  });

  it("shows the statement, the language and every case", () => {
    const { config } = setup();
    expect(screen.getByLabelText("Statement")).toHaveValue(config.prompt);
    expect(screen.getByLabelText("Language")).toHaveValue("c");
    expect(screen.getByLabelText("Name 1")).toHaveValue("three items");
    expect(screen.getByLabelText("Name 3")).toHaveValue("negative-values");
    expect(screen.getByLabelText("Starting code")).toHaveValue(config.template);
  });

  it("shows the issues the host reported, under the field they name", () => {
    setup({
      issues: [
        { path: [], message: "code.root_issue" },
        { path: ["prompt"], message: "code.prompt_empty" },
        { path: ["tests", "cases", 1, "name"], message: "code.case_name" },
        { path: ["limits", "timeMs"], message: "code.time_limit" },
      ],
    });
    for (const message of ["code.root_issue", "code.prompt_empty", "code.case_name", "code.time_limit"]) {
      expect(screen.getByText(message)).toBeInTheDocument();
    }
    // The case's issue sits inside that case's panel, not under the list.
    expect(screen.getByText("code.case_name").closest("ol > li")).toContainElement(
      screen.getByLabelText("Name 2"),
    );
  });

  it("counts the locked regions of the template", () => {
    setup();
    expect(screen.getByText("2 locked regions")).toBeInTheDocument();
  });

  it("patches the config instead of replacing it", () => {
    const { config, onChange } = setup();
    fireEvent.change(screen.getByLabelText("Statement"), { target: { value: "New statement" } });
    expect(onChange).toHaveBeenCalledWith({ ...config, prompt: "New statement" });
  });

  it("stores the opposite of the hidden switch", () => {
    const { onChange } = setup();
    // Case 1 is visible: ticking "Hidden" must turn `visible` off.
    fireEvent.click(screen.getByLabelText("Hidden 1"));
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.visible).toBe(false);
  });

  it("adds and removes a case", () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add a case" }));
    expect(onChange.mock.calls[0]?.[0]?.tests.cases).toHaveLength(4);

    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Remove the case empty array" }));
    expect(onChange.mock.calls[0]?.[0]?.tests.cases.map((c) => c.name)).toEqual([
      "three items",
      "negative-values",
    ]);
  });

  it("reads an empty per-case time budget as 'use the question limit'", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("Time (ms) 1"), { target: { value: "500" } });
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.timeMs).toBe(500);
  });

  it("clears a per-case budget back to the question limit", () => {
    const timed = CodeConfig.parse({
      ...codeConfig(),
      tests: {
        mode: "io",
        cases: [{ name: "tight", expected: "", timeMs: 500, visible: true, points: 1 }],
      },
    });
    const { onChange } = setup({ config: timed });
    fireEvent.change(screen.getByLabelText("Time (ms) 1"), { target: { value: "" } });
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.timeMs).toBeNull();
  });

  it("writes a case's command line one argv entry per row", () => {
    const { onChange } = setup();
    // The first case has no argument: one button adds the first row.
    fireEvent.click(screen.getAllByRole("button", { name: "Add an argument" })[0]!);
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.args).toEqual([""]);
  });

  it("keeps a space inside one argument", () => {
    const withArgs = CodeConfig.parse({
      ...codeConfig(),
      tests: { mode: "io", cases: [{ name: "argv", args: ["-v"], expected: "", visible: true, points: 1 }] },
    });
    const { onChange } = setup({ config: withArgs });
    fireEvent.change(screen.getByLabelText("Argument 1"), { target: { value: "hello world" } });
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.args).toEqual(["hello world"]);
    expect(screen.getByLabelText("Command line")).toHaveTextContent("./prog -v");
  });

  it("hides the expected output when the case does not compare it", () => {
    const { onChange } = setup();
    expect(screen.getByLabelText("Expected output 1")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Compare the output 1"));
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.compareStdout).toBe(false);
  });

  it("reads an empty exit code as 'any exit code'", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("Exit code 1"), { target: { value: "" } });
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.expectedExitCode).toBeNull();

    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("Exit code 1"), { target: { value: "2" } });
    expect(onChange.mock.calls[0]?.[0]?.tests.cases[0]?.expectedExitCode).toBe(2);
  });

  it("offers the browser only for a language the browser can run", () => {
    const { onChange } = setup();
    const group = screen.getByRole("radiogroup", { name: "Student's runs" });
    expect(group).toBeInTheDocument();
    expect(screen.getByText("On the server, exactly like the grading.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Instant" }));
    expect(onChange.mock.calls[0]?.[0]?.runtime).toBe("runno");
  });

  it("does not offer a runtime choice a language cannot honour", () => {
    setup({ config: { ...codeConfig(), language: "rust" } });
    expect(screen.queryByRole("radiogroup", { name: "Student's runs" })).toBeNull();
  });

  it("sets the cooldown of the student's runs, and says what it does", () => {
    const { onChange } = setup();
    expect(screen.getByRole("radiogroup", { name: "Between runs" })).toBeInTheDocument();
    // The fixture chose progressive.
    expect(screen.getByText("3 s, then 30 % longer each time, up to 30 s.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Fixed" }));
    expect(onChange.mock.calls[0]?.[0]?.cooldown).toBe("fixed");
  });

  it("keeps the advanced options out of the primary path but reachable", () => {
    setup();
    expect(screen.getByText("Advanced options")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("All or nothing"));
    expect(screen.getByLabelText("Compiler arguments")).toHaveValue(
      "-Wall -Wextra -std=c17 -DSECRET_FLAG",
    );
  });

  it("offers the reference solution only as a way to try the cases", () => {
    setup({ onTry: undefined });
    expect(screen.getByLabelText("Reference solution")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try the reference solution" })).toBeNull();
  });

  it("says how many cases the reference solution passes", async () => {
    setup({
      config: withSplitReference(),
      onTry: async () =>
        outcome([{ stdout: "6\n" }, { stdout: "0\n" }, { stdout: "5 (hidden-expected-marker)" }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
  });

  it("shows the server's own verdict when the server graded instead of running", async () => {
    // `POST /questions/:id/try` answers a GRADING: there is no per-case runner
    // outcome to judge, so the editor reports what came back rather than
    // deciding the cases a second time from an output it does not have.
    setup({
      config: withSplitReference(),
      onTry: async () => ({ graded: { compileOk: true, passed: 2, total: 3 } }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("2 of 3 cases pass.")).toBeInTheDocument();
  });

  it("runs a single-region reference as it stands, with nothing to separate", async () => {
    const onTry = vi.fn(async () => outcome([{ stdout: "" }]));
    // `configFor` locks a header and a footer around one editable body: one
    // region, so the whole reference solution IS that region.
    setup({ config: { ...configFor("c"), referenceSolution: "return 0;" }, onTry });
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("1 of 1 cases pass.")).toBeInTheDocument();
    expect(onTry).toHaveBeenCalledTimes(1);
  });

  it("refuses a reference that does not fit the template, before running anything", async () => {
    const onTry = vi.fn(async () => outcome([{ stdout: "" }]));
    // Two editable regions in the fixture template, one undivided reference.
    setup({ config: codeConfig(), onTry });
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(
      await screen.findByText(
        "The reference solution does not fit the editable regions of the starting code. Edit it once in the editor above to realign it.",
      ),
    ).toBeInTheDocument();
    expect(onTry).not.toHaveBeenCalled();
  });

  it("degrades to one clear line when the runner is off", async () => {
    setup({ config: withSplitReference(), onTry: async () => "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(
      await screen.findByText(
        "The runner is unavailable, so the reference solution cannot be tried right now.",
      ),
    ).toBeInTheDocument();
  });

  it("takes its strings from the host, which owns the translations", () => {
    setup({ strings: { prompt: "Énoncé" } });
    expect(screen.getByLabelText("Énoncé")).toBeInTheDocument();
  });

  it("writes the statement in the host's rich editor when it lends one", () => {
    const { config } = setup({
      RichText: ({ value, "aria-label": label }) => (
        <div data-testid="rich" aria-label={label}>
          {value}
        </div>
      ),
    });
    expect(screen.getByTestId("rich")).toHaveTextContent(config.prompt);
    expect(screen.getByTestId("rich")).toHaveAccessibleName("Statement");
  });

  it("falls back to its own textarea when the host lends none", () => {
    const { config } = setup();
    expect(screen.queryByTestId("rich")).toBeNull();
    expect(screen.getByLabelText("Statement")).toHaveValue(config.prompt);
  });

  it("draws no preview under the statement: the field is the preview", () => {
    setup({ renderMarkdown: (source) => <em data-testid="md">{source}</em> });
    expect(screen.queryByTestId("md")).toBeNull();
  });
});
