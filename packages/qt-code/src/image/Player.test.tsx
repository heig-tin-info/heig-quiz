/**
 * `CodeImagePlayer` on the textarea fallback (jsdom has no canvas: the grids
 * render their frame and label, which is what these tests read).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { outcome } from "../test/fixtures.js";
import { CodeImagePlayer } from "./Player.js";
import type { CodeImageAnswer } from "./schema.js";
import { codeimageServer } from "./server.js";
import { CHECKER_STDOUT, imageConfig } from "./test/fixtures.js";

const student = codeimageServer.toStudent(imageConfig(), { seed: 0, itemId: "i", shuffle: false });

function setup(overrides: Partial<React.ComponentProps<typeof CodeImagePlayer>> = {}) {
  const onChange = vi.fn<(next: CodeImageAnswer) => void>();
  render(
    <CodeImagePlayer
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

describe("CodeImagePlayer", () => {
  it("shows the program half: the prompt, the size, one editor per region", () => {
    setup();
    expect(screen.getByText("Draw a checkerboard.")).toBeInTheDocument();
    expect(screen.getByText("4 × 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Your code, region 1")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Locked — provided by your teacher")).toHaveLength(2);
  });

  it("writes the regions back on a change", () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText("Your code, region 1"), { target: { value: "x" } });
    expect(onChange).toHaveBeenCalledWith({ regions: ["x"] });
  });

  it("shows the target beside an empty computed image before the first run", () => {
    setup();
    expect(screen.getByRole("img", { name: "Target image" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Your image" })).toBeInTheDocument();
    expect(screen.getByText("Run your program to see its image.")).toBeInTheDocument();
    expect(screen.queryByText(/pixels correct/)).toBeNull();
  });

  it("draws the run's stdout and counts the matching pixels", async () => {
    const onRun = vi.fn(async () => outcome([{ stdout: "1 0 1 0\n0 1 0 1\n1 0 1 1\n" }]));
    setup({ onRun });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("11 / 12 pixels correct (91.6 %)")).toBeInTheDocument();
    expect(onRun).toHaveBeenCalledWith({ regions: ["    // draw here\n"] }, expect.anything());
    expect(screen.queryByText("Run your program to see its image.")).toBeNull();
  });

  it("switches the right-hand grid to the difference", async () => {
    setup({ onRun: async () => outcome([{ stdout: CHECKER_STDOUT }]) });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("12 / 12 pixels correct (100 %)");
    fireEvent.click(screen.getByRole("radio", { name: "Difference" }));
    expect(screen.getByRole("img", { name: "Difference with the target" })).toBeInTheDocument();
    expect(screen.getByText("Correct")).toBeInTheDocument();
    expect(screen.getByText("Wrong")).toBeInTheDocument();
  });

  it("shows one grid in the single layout, driven by the view toggle", () => {
    setup();
    fireEvent.click(screen.getByRole("radio", { name: "Single" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "Computed" }));
    expect(screen.getByRole("img", { name: "Your image" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Target image" })).toBeNull();
  });

  it("warns about extra, missing and invalid values, and about how the run ended", async () => {
    setup({ onRun: async () => outcome([{ stdout: "1 0 z 0 1", timedOut: true }]) });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(/ran out of time/)).toBeInTheDocument();
    expect(screen.getByText(/1 value is not an integer/)).toBeInTheDocument();
    expect(screen.getByText("The output stopped 7 pixels short of the image.")).toBeInTheDocument();
  });

  it("says so when the program does not compile, and draws nothing", async () => {
    setup({ onRun: async () => outcome([], { ok: false, stderr: "main.c:3: error" }) });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Compilation failed")).toBeInTheDocument();
    expect(screen.getByText("main.c:3: error")).toBeInTheDocument();
    expect(screen.getByText("Run your program to see its image.")).toBeInTheDocument();
  });

  it("says the answer is safe when no runner is available, and names the budget", async () => {
    const onRun = vi
      .fn<() => Promise<"unavailable" | "rate_limited">>()
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValueOnce("rate_limited");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup({ onRun });
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(await screen.findByText(/Running is unavailable right now/)).toBeInTheDocument();
      // The button refills first (the server budget floors it at 6.5 s); an
      // unavailable runner answered nothing, so the same code may run again.
      expect(screen.getByRole("button", { name: /^Run/ })).toBeDisabled();
      await act(() => void vi.advanceTimersByTime(7000));
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(await screen.findByText(/Too many runs in a minute/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the same code again once the cooldown ends (#129)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onRun = vi.fn(async () => outcome([{ stdout: CHECKER_STDOUT }]));
      setup({ onRun });
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("button", { name: /^Run/ })).toBeDisabled();
      await act(() => void vi.advanceTimersByTime(7000));
      expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => expect(onRun).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no Run button without a runner, and a disabled one when read-only", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("disables Run once the attempt is read-only", () => {
    setup({ readOnly: true, onRun: async () => outcome([]) });
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("shows the sixteen colours for a color16 question", () => {
    const colorStudent = codeimageServer.toStudent(
      imageConfig({
        image: { width: 4, height: 3, palette: "color16" },
        target: { width: 4, height: 3, palette: "color16", pixels: "0123456789ab" },
      }),
      { seed: 0, itemId: "i", shuffle: false },
    );
    setup({ student: colorStudent });
    const legend = screen.getByText("Colours").parentElement!;
    expect(within(legend).getAllByRole("listitem")).toHaveLength(16);
  });

  it("takes its strings from the host", () => {
    setup({ strings: { imageSection: "Image (fr)" } });
    expect(screen.getByText("Image (fr)")).toBeInTheDocument();
  });
});
