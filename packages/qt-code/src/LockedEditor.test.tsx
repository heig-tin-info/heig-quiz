import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { splitTemplate } from "@quiz/domain/lockedTemplate";

import {
  checkLayout,
  insideEditable,
  layoutProgram,
  LockedEditor,
  markerLineNumbers,
  minimalEdit,
  realignLayout,
  regionsFromLayout,
  type Span,
} from "./LockedEditor.js";

/** Two regions around a locked function body, the file ending with a break. */
const TEMPLATE = [
  "#include <stdio.h>", // 1  editable 0
  "// @@lock", //          2  locked
  "int twice(int x) {", // 3
  "// @@endlock", //       4
  "    return 0;", //      5  editable 1
  "// @@lock", //          6  locked
  "}", //                  7
  "",
].join("\n");

const segments = splitTemplate(TEMPLATE, "c");

/** Applies `[start, end) -> text` to `text`, and moves the spans like tracked decorations would. */
function edit(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}

describe("layoutProgram", () => {
  it("lays the template out as the file, without its final line break", () => {
    const { text, spans } = layoutProgram(segments, ["#include <stdio.h>\n", "    return 0;\n"]);
    expect(text).toBe(TEMPLATE.replace(/\n$/, ""));
    expect(spans.map((s) => s.kind)).toEqual(["editable", "locked", "editable", "locked"]);
    expect(text.slice(spans[2]!.start, spans[2]!.end)).toBe("    return 0;");
    expect(checkLayout(text, spans, segments)).toBe(true);
  });

  it("keeps the line numbers of the assembled source, markers included", () => {
    const { text, spans } = layoutProgram(segments, ["#include <stdio.h>\n", "    return 2 * x;\n"]);
    expect(text.split("\n")[4]).toBe("    return 2 * x;");
    expect(markerLineNumbers(text, spans)).toEqual([2, 4, 6]);
  });

  it("shows an empty region as one empty line", () => {
    const { text, spans } = layoutProgram(segments, ["", "\n"]);
    expect(spans[0]).toMatchObject({ start: 0, end: 0 });
    expect(text.startsWith("\n// @@lock")).toBe(true);
    expect(regionsFromLayout(text, spans, segments)).toEqual(["\n", "\n"]);
  });

  it("reads back the regions it was given", () => {
    for (const regions of [
      ["#include <stdio.h>\n", "    return 0;\n"],
      ["a\nb\n", "\n\n"],
      ["\n", "  x;\n"],
    ]) {
      const { text, spans } = layoutProgram(segments, regions);
      expect(regionsFromLayout(text, spans, segments)).toEqual(regions);
    }
  });
});

describe("checkLayout", () => {
  const { text, spans } = layoutProgram(segments, ["#include <stdio.h>\n", "    return 0;\n"]);
  const moved = (at: number, delta: number, grow: number): Span[] =>
    spans.map((span, i) =>
      i < at ? span : i === at ? { ...span, end: span.end + grow } : { ...span, start: span.start + delta, end: span.end + delta },
    );

  it("accepts typing inside a region", () => {
    const next = edit(text, spans[2]!.end, spans[2]!.end, " // done");
    expect(checkLayout(next, moved(2, 8, 8), segments)).toBe(true);
  });

  it("refuses a locked line that changed", () => {
    const at = spans[1]!.start + 12;
    const next = edit(text, at, at, "X");
    expect(checkLayout(next, moved(1, 1, 1), segments)).toBe(false);
  });

  it("refuses a Backspace that joins a region to the locked line above it", () => {
    // The break before region 1 is deleted: the region no longer starts a line.
    const next = edit(text, spans[2]!.start - 1, spans[2]!.start, "");
    const shifted = spans.map((span, i) =>
      i < 2 ? span : { ...span, start: span.start - 1, end: span.end - 1 },
    );
    expect(checkLayout(next, shifted, segments)).toBe(false);
  });

  it("refuses text typed at the end of a locked line", () => {
    const at = spans[1]!.end;
    const next = edit(text, at, at, "x");
    // The locked span does not grow; the text lands between it and its break.
    const shifted = spans.map((span, i) => (i < 2 ? span : { ...span, start: span.start + 1, end: span.end + 1 }));
    expect(checkLayout(next, shifted, segments)).toBe(false);
  });
});

describe("realignLayout", () => {
  it("finds the locked lines again after an undo collapsed the decorations", () => {
    const regions = ["#include <stdio.h>\nint y;\n", "    return x;\n"];
    const { text, spans } = layoutProgram(segments, regions);
    const collapsed = spans.map((span) => ({ ...span, start: 0, end: 0 }));
    const found = realignLayout(text, segments, collapsed);
    expect(found).toEqual(spans);
  });

  it("prefers the copy nearest the hint when a region repeats a locked text", () => {
    // Region 1 ends with a copy of the first locked block, so it appears twice.
    const regions = ["a\n// @@lock\nint twice(int x) {\n// @@endlock\n", "    return 0;\n"];
    const { text, spans } = layoutProgram(segments, regions);
    expect(realignLayout(text, segments, spans)).toEqual(spans);
    const early = spans.map((span, i) => (i === 1 ? { ...span, start: 2 } : span));
    expect(realignLayout(text, segments, early)?.[1]!.start).toBe(2);
  });

  it("gives up when a locked text is gone", () => {
    const { text, spans } = layoutProgram(segments, ["a\n", "b\n"]);
    expect(realignLayout(text.replace("twice", "thrice"), segments, spans)).toBeNull();
  });
});

describe("minimalEdit", () => {
  it("replaces only the middle that differs", () => {
    expect(minimalEdit("abcXYdef", "abcdef")).toEqual({ start: 3, end: 5, text: "" });
    expect(minimalEdit("abcdef", "abc123def")).toEqual({ start: 3, end: 3, text: "123" });
    expect(minimalEdit("aaa", "aa")).toEqual({ start: 2, end: 3, text: "" });
    expect(minimalEdit("same", "same")).toBeNull();
  });

  it("turns any text back into the good one", () => {
    const good = "int main() {\n  return 0;\n}";
    for (const bad of ["int main() {\n  return 0;\n", "x", "", "int main() {\n  return 0;\n}}}"]) {
      const e = minimalEdit(bad, good)!;
      expect(bad.slice(0, e.start) + e.text + bad.slice(e.end)).toBe(good);
    }
  });
});

describe("insideEditable", () => {
  const { spans } = layoutProgram(segments, ["", "    return 0;\n"]);

  it("counts both edges of a region, and an empty region", () => {
    expect(insideEditable(spans, 0, 0)).toBe(true);
    expect(insideEditable(spans, spans[2]!.start, spans[2]!.end)).toBe(true);
  });

  it("refuses a selection that reaches a locked line", () => {
    expect(insideEditable(spans, spans[2]!.start, spans[2]!.end + 1)).toBe(false);
    expect(insideEditable(spans, spans[1]!.start, spans[1]!.start)).toBe(false);
  });
});

describe("LockedEditor (stacked fallback)", () => {
  it("renders the locked blocks without markers and one textarea per region", () => {
    render(
      <LockedEditor
        segments={segments}
        regions={["#include <stdio.h>\n", "    return 0;\n"]}
        onChange={() => {}}
        language="c"
        label="Program"
        regionLabel="Region {n}"
        lockedLabel="Locked"
        monaco={false}
      />,
    );
    const locked = screen.getAllByLabelText("Locked");
    expect(locked).toHaveLength(2);
    expect(locked[0]!.textContent).toBe("int twice(int x) {");
    expect(screen.getByLabelText("Region 2")).toHaveValue("    return 0;\n");
  });

  it("reports every region when one changes", () => {
    const onChange = vi.fn();
    render(
      <LockedEditor
        segments={segments}
        regions={["a\n", "b\n"]}
        onChange={onChange}
        language="c"
        label="Program"
        regionLabel="Region {n}"
        lockedLabel="Locked"
        monaco={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Region 2"), { target: { value: "c\n" } });
    expect(onChange).toHaveBeenCalledWith(["a\n", "c\n"]);
  });

  it("is read-only without onChange", () => {
    render(
      <LockedEditor
        segments={segments}
        regions={["a\n", "b\n"]}
        language="c"
        label="Program"
        regionLabel="Region {n}"
        lockedLabel="Locked"
        monaco={false}
      />,
    );
    expect(screen.getByLabelText("Region 1")).toHaveAttribute("readonly");
  });
});
