import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReferenceSection } from "./ProgramEditor.js";
import { CodeConfig } from "./schema.js";
import { EDITOR_STRINGS } from "./strings.js";

/** Two editable regions around one locked function header. */
const TEMPLATE = "#include <stdio.h>\n// @@lock\nint main(void) {\n// @@endlock\n    return 0;\n}\n";

function setup(referenceSolution: string) {
  const config = CodeConfig.parse({
    configVersion: 1,
    prompt: "p",
    language: "c",
    template: TEMPLATE,
    referenceSolution,
    tests: { mode: "io", cases: [{ name: "one", stdin: "", expected: "", points: 1 }] },
  });
  const patch = vi.fn();
  render(
    <ReferenceSection
      config={config}
      patch={patch}
      s={EDITOR_STRINGS}
      disabled={false}
      issues={[]}
      monaco={false}
    />,
  );
  return patch;
}

describe("ReferenceSection", () => {
  it("shows a fresh reference as the template's own editable text", () => {
    setup("");
    expect(screen.getByLabelText("Reference solution, region 1")).toHaveValue("#include <stdio.h>\n");
    expect(screen.getByLabelText("Reference solution, region 2")).toHaveValue("    return 0;\n}\n");
    expect(screen.getByLabelText("Locked — part of the starting code")).toHaveTextContent(
      "int main(void) {",
    );
  });

  it("writes the regions back joined by the language's @@next line", () => {
    const patch = setup("");
    fireEvent.change(screen.getByLabelText("Reference solution, region 2"), {
      target: { value: "    return 42;\n}\n" },
    });
    expect(patch).toHaveBeenCalledWith({
      referenceSolution: "#include <stdio.h>\n// @@next\n    return 42;\n}",
    });
  });

  it("warns that the pieces beyond the template's regions will be dropped", () => {
    setup("a\n// @@next\nb\n// @@next\nc");
    expect(screen.getByRole("status")).toHaveTextContent(EDITOR_STRINGS.referenceExtraPieces);
    expect(screen.getByLabelText("Reference solution, region 2")).toHaveValue("b\n");
  });
});
