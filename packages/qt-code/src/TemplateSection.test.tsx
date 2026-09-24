/**
 * The starting-code section on the `<textarea>` fallback: the lock button
 * sits in the header and follows the textarea's selection, and the marker
 * issues are listed under the editor.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TemplateSection } from "./ProgramEditor.js";
import type { ProgramConfig } from "./schema.js";
import { EDITOR_STRINGS } from "./strings.js";
import { codeConfig } from "./test/fixtures.js";

const LOCK = "Lock these lines — the student cannot edit them";
const UNLOCK = "Unlock these lines";

function Harness({
  template,
  language = "c",
  disabled,
  onTemplate,
}: {
  template: string;
  language?: ProgramConfig["language"];
  disabled?: boolean;
  onTemplate?: (next: string) => void;
}) {
  const [config, setConfig] = useState<ProgramConfig>({ ...codeConfig(), template, language });
  return (
    <TemplateSection
      config={config}
      patch={(next) => {
        if (next.template !== undefined) onTemplate?.(next.template);
        setConfig((current) => ({ ...current, ...next }));
      }}
      s={EDITOR_STRINGS}
      disabled={disabled}
      issues={[]}
      monaco={false}
    />
  );
}

/** Selects `[start, end)` of the textarea, as a user dragging over it would. */
function select(start: number, end: number) {
  const area = screen.getByLabelText<HTMLTextAreaElement>("Starting code");
  area.setSelectionRange(start, end);
  fireEvent.select(area);
  return area;
}

describe("TemplateSection", () => {
  it("disables the lock button until something is selected", () => {
    render(<Harness template={"a\nb\nc\n"} />);
    expect(screen.getByRole("button", { name: LOCK })).toBeDisabled();
    select(2, 2);
    expect(screen.getByRole("button", { name: LOCK })).toBeDisabled();
    select(2, 3);
    expect(screen.getByRole("button", { name: LOCK })).toBeEnabled();
  });

  it("wraps the selected lines in markers, then unlocks them again", () => {
    const onTemplate = vi.fn<(next: string) => void>();
    render(<Harness template={"a\nb\nc\n"} onTemplate={onTemplate} />);

    // "b" only: offsets 2..3, the selection snaps to the whole line.
    select(2, 3);
    fireEvent.click(screen.getByRole("button", { name: LOCK }));
    expect(onTemplate).toHaveBeenLastCalledWith("a\n// @@lock\nb\n// @@endlock\nc\n");
    expect(screen.getByText("1 locked region")).toBeInTheDocument();
    // The button waits for a new selection.
    expect(screen.getByRole("button", { name: LOCK })).toBeDisabled();

    // Select "b" again, now on line 3: the button offers to unlock.
    const area = screen.getByLabelText<HTMLTextAreaElement>("Starting code");
    const at = area.value.indexOf("b");
    select(at, at + 1);
    fireEvent.click(screen.getByRole("button", { name: UNLOCK }));
    expect(onTemplate).toHaveBeenLastCalledWith("a\nb\nc\n");
    expect(screen.getByText("0 locked regions")).toBeInTheDocument();
  });

  it("writes python markers with #", () => {
    const onTemplate = vi.fn<(next: string) => void>();
    render(<Harness template={"import sys\nx = 1\n"} language="python" onTemplate={onTemplate} />);
    select(0, 4);
    fireEvent.click(screen.getByRole("button", { name: LOCK }));
    expect(onTemplate).toHaveBeenLastCalledWith("# @@lock\nimport sys\n# @@endlock\nx = 1\n");
  });

  it("lists the markers the split does not read as meant, with their line", () => {
    render(<Harness template={"// @@lock\nint x;\n// @@unlok\n// @@lock\n"} />);
    expect(
      screen.getByText("Line 3: unknown marker @@unlok — use @@lock and @@endlock."),
    ).toBeInTheDocument();
    expect(screen.getByText("Line 4: @@lock inside a region that is already locked.")).toBeInTheDocument();
  });

  it("accepts @@unlock as the close of a region", () => {
    render(<Harness template={"// @@lock\nint x;\n// @@unlock\nint y;\n"} />);
    expect(screen.getByText("1 locked region")).toBeInTheDocument();
    expect(screen.queryByText(/unknown marker/)).toBeNull();
  });

  it("offers no lock button when the editor is disabled", () => {
    render(<Harness template={"a\n"} disabled />);
    expect(screen.queryByRole("button", { name: LOCK })).toBeNull();
  });

  it("no longer lists what the student can edit", () => {
    render(<Harness template={"// @@lock\na\n// @@endlock\nb\n"} />);
    expect(screen.queryByText("What the student can edit")).toBeNull();
    expect(screen.queryByText(/@@endlock are read-only/)).toBeNull();
  });
});
