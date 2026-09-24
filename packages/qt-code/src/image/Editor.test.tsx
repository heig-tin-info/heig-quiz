/** `CodeImageEditor`: the picture settings, and "Use as target". */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { outcome } from "../test/fixtures.js";
import { CodeImageEditor, type CodeImageTryOutcome } from "./Editor.js";
import type { CodeImageConfig, CodeImageDetails } from "./schema.js";
import { CHECKER_STDOUT, imageConfig } from "./test/fixtures.js";

function setup(
  config: CodeImageConfig,
  onTry?: (config: CodeImageConfig) => Promise<CodeImageTryOutcome>,
) {
  const onChange = vi.fn<(next: CodeImageConfig) => void>();
  const view = render(
    <CodeImageEditor config={config} onChange={onChange} monaco={false} onTry={onTry} />,
  );
  return { onChange, view };
}

const draft = (): CodeImageConfig => ({ ...imageConfig(), target: null });

describe("CodeImageEditor", () => {
  it("shows the program half and the picture settings", () => {
    setup(imageConfig());
    expect(screen.getByLabelText("Starting code")).toBeInTheDocument();
    expect(screen.getByLabelText("Reference solution")).toBeInTheDocument();
    expect(screen.getByLabelText("Width")).toHaveValue(4);
    expect(screen.getByLabelText("Height")).toHaveValue(3);
    expect(screen.getByRole("radio", { name: "Black and white (0–1)" })).toBeChecked();
    expect(screen.getByRole("img", { name: "Target" })).toBeInTheDocument();
  });

  it("offers no action choice: a picture question always runs", () => {
    setup(imageConfig());
    expect(screen.queryByLabelText("Action")).toBeNull();
    expect(screen.getByLabelText("Output (KB)")).toHaveValue(128);
  });

  it("patches the size and the palette", () => {
    const { onChange } = setup(imageConfig());
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "16" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ image: { width: 16, height: 3, palette: "bw" } }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Grey levels (0–255)" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ image: { width: 4, height: 3, palette: "gray256" } }),
    );
  });

  it("says a draft has no target yet", () => {
    setup(draft());
    expect(screen.getAllByText(/No target yet/).length).toBeGreaterThan(0);
  });

  it("uses the browser's run of the reference as the target", async () => {
    const onTry = vi.fn(async () => outcome([{ stdout: CHECKER_STDOUT }]));
    const { onChange } = setup(draft(), onTry);
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("The reference solution drew its image.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use as target" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { width: 4, height: 3, palette: "bw", pixels: "101001011010" },
      }),
    );
  });

  it("reads the image the server's grading returned", async () => {
    const details: CodeImageDetails = {
      runner: "ok",
      compile: { ok: true, stderr: "", ms: 3 },
      run: { exitCode: 0, timedOut: false, oom: false, truncated: false, ms: 2 },
      image: "111100001111",
      matching: 0,
      pixelCount: 12,
      warnings: [],
      sourceSha256: null,
    };
    const { onChange } = setup(draft(), async () => ({ details }));
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use as target" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { width: 4, height: 3, palette: "bw", pixels: "111100001111" },
      }),
    );
  });

  it("compares a new run with the current target, and says when it already is the target", async () => {
    setup(imageConfig(), async () => outcome([{ stdout: CHECKER_STDOUT }]));
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("This image is the target.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use as target" })).toBeDisabled();
  });

  it("refuses an incomplete image as the target", async () => {
    setup(draft(), async () => outcome([{ stdout: "1 0 1" }]));
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText(/invalid or missing pixels/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use as target" })).toBeDisabled();
  });

  it("marks a tried image stale once the size changes", async () => {
    const { view } = setup(draft(), async () => outcome([{ stdout: CHECKER_STDOUT }]));
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    await screen.findByText("The reference solution drew its image.");
    view.rerender(
      <CodeImageEditor
        config={{ ...draft(), image: { width: 5, height: 3, palette: "bw" } }}
        onChange={() => {}}
        monaco={false}
        onTry={async () => "unavailable"}
      />,
    );
    expect(screen.getByText(/changed since this run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use as target" })).toBeDisabled();
  });

  it("says the reference does not compile, and that no runner is available", async () => {
    setup(draft(), async () => outcome([], { ok: false }));
    fireEvent.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("The reference solution does not compile.")).toBeInTheDocument();
  });

  it("refuses a side out of range without drawing it", () => {
    setup({ ...imageConfig(), image: { width: 1, height: 3, palette: "bw" } }, async () => "unavailable");
    expect(screen.queryByRole("img", { name: "Target" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try the reference solution" })).toBeDisabled();
  });
});
