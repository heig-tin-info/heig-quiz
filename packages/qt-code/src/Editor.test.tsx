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
import { codeConfig, outcome } from "./test/fixtures.js";

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
      onTry: async () =>
        outcome([{ stdout: "6\n" }, { stdout: "0\n" }, { stdout: "5 (hidden-expected-marker)" }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("3 of 3 cases pass.")).toBeInTheDocument();
  });

  it("degrades to one clear line when the runner is off", async () => {
    setup({ onTry: async () => "unavailable" });
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
