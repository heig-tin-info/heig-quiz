import { describe, expect, it } from "vitest";
import {
  assembleSource,
  emptyRegions,
  mainFileName,
  markerLine,
  markerOf,
  markerWordOf,
  regionCount,
  splitTemplate,
  templateMarkerIssues,
  TemplateRegionMismatch,
  type TemplateLanguage,
} from "./lockedTemplate.js";

const C_TEMPLATE = [
  "#include <stdio.h>",
  "// @@lock",
  "int main(void) {",
  "// @@endlock",
  "    int total = 0;",
  "// @@lock",
  "    return 0;",
  "}",
  "// @@endlock",
  "",
].join("\n");

describe("splitTemplate", () => {
  it("keeps the markers inside the locked text and reproduces the template", () => {
    const segments = splitTemplate(C_TEMPLATE, "c");
    expect(segments.map((s) => s.kind)).toEqual(["editable", "locked", "editable", "locked"]);
    expect(segments.map((s) => s.index)).toEqual([0, null, 1, null]);
    expect(segments.map((s) => s.text).join("")).toBe(C_TEMPLATE);
    expect(segments[1]?.text).toContain("@@lock");
    expect(segments[1]?.text).toContain("@@endlock");
  });

  it("treats a template without a marker as one editable region", () => {
    const segments = splitTemplate("print('hi')\n", "python");
    expect(segments).toEqual([{ kind: "editable", index: 0, text: "print('hi')\n" }]);
    expect(regionCount("print('hi')\n", "python")).toBe(1);
  });

  it("recognises the marker behind each language's comment prefix and any indentation", () => {
    expect(splitTemplate("    # @@lock\nx = 1\n# @@endlock\n", "python").map((s) => s.kind)).toEqual([
      "locked",
    ]);
    expect(splitTemplate("/* @@lock */\nlet x;\n// @@endlock\n", "js").map((s) => s.kind)).toEqual([
      "locked",
    ]);
    expect(splitTemplate("// @@lock\nfn main() {}\n// @@endlock\n", "rust").map((s) => s.kind)).toEqual([
      "locked",
    ]);
    expect(splitTemplate("// @@lock\nint x;\n// @@endlock\n", "cpp").map((s) => s.kind)).toEqual(["locked"]);
  });

  it("does not take a mention of the marker inside code for a marker", () => {
    expect(splitTemplate('printf("@@lock");\n', "c").map((s) => s.kind)).toEqual(["editable"]);
  });

  it("produces no editable segment between two adjacent locked blocks", () => {
    const template = "// @@lock\na\n// @@endlock\n// @@lock\nb\n// @@endlock\n";
    expect(splitTemplate(template, "c").map((s) => s.kind)).toEqual(["locked"]);
    expect(regionCount(template, "c")).toBe(0);
  });

  it("exposes the editable parts as the initial regions of a fresh answer", () => {
    expect(emptyRegions(C_TEMPLATE, "c")).toEqual(["#include <stdio.h>\n", "    int total = 0;\n"]);
  });
});

describe("@@unlock", () => {
  it("closes a lock exactly like @@endlock", () => {
    const withUnlock = C_TEMPLATE.replaceAll("@@endlock", "@@unlock");
    const segments = splitTemplate(withUnlock, "c");
    expect(segments.map((s) => s.kind)).toEqual(["editable", "locked", "editable", "locked"]);
    expect(segments.map((s) => s.text).join("")).toBe(withUnlock);
    expect(emptyRegions(withUnlock, "c")).toEqual(emptyRegions(C_TEMPLATE, "c"));
  });

  it("closes it in python too, and may be mixed with @@endlock", () => {
    const template = "# @@lock\nimport sys\n# @@unlock\nx = 1\n# @@lock\nprint(x)\n# @@endlock\n";
    expect(splitTemplate(template, "python").map((s) => s.kind)).toEqual(["locked", "editable", "locked"]);
  });
});

describe("markerOf", () => {
  it("folds the synonyms and knows the reference separator", () => {
    expect(markerOf("// @@lock", "c")).toBe("lock");
    expect(markerOf("  // @@endlock", "c")).toBe("endlock");
    expect(markerOf("// @@unlock", "c")).toBe("endlock");
    expect(markerOf("/* @@unlock */", "js")).toBe("endlock");
    expect(markerOf("# @@next", "python")).toBe("next");
    expect(markerOf("// @@unlok", "c")).toBeNull();
    expect(markerOf("int x; // @@lock", "c")).toBeNull();
  });

  it("narrows the comment prefix to the language, and accepts any without one", () => {
    expect(markerOf("# @@lock", "c")).toBeNull();
    expect(markerOf("// @@lock", "python")).toBeNull();
    expect(markerOf("/* @@lock */", "rust")).toBeNull();
    expect(markerOf("# @@lock")).toBe("lock");
    expect(markerOf("/* @@endlock */")).toBe("endlock");
  });

  it("captures the word of an unknown marker", () => {
    expect(markerWordOf("  // @@unlok", "c")).toBe("unlok");
    expect(markerWordOf("# @@end", "python")).toBe("end");
    expect(markerWordOf('printf("@@lock");', "c")).toBeNull();
  });
});

describe("markerLine", () => {
  it("writes the marker in the language's line-comment syntax", () => {
    expect(markerLine("lock", "c")).toBe("// @@lock");
    expect(markerLine("endlock", "rust")).toBe("// @@endlock");
    expect(markerLine("lock", "python")).toBe("# @@lock");
    const languages: TemplateLanguage[] = ["c", "cpp", "python", "js", "rust"];
    for (const language of languages) {
      expect(markerOf(markerLine("lock", language), language)).toBe("lock");
      expect(markerOf(markerLine("endlock", language), language)).toBe("endlock");
    }
  });
});

describe("templateMarkerIssues", () => {
  it("finds nothing in a well-formed template, nor in a lock left open to the end", () => {
    expect(templateMarkerIssues(C_TEMPLATE, "c")).toEqual([]);
    expect(templateMarkerIssues("a\n// @@lock\nb\n", "c")).toEqual([]);
    expect(templateMarkerIssues("no markers at all", "c")).toEqual([]);
  });

  it("reports unknown words with their 1-based line", () => {
    expect(templateMarkerIssues("// @@lock\nint x;\n// @@unlok\n// @@end\n", "c")).toEqual([
      { line: 3, kind: "unknown", marker: "@@unlok" },
      { line: 4, kind: "unknown", marker: "@@end" },
    ]);
  });

  it("reports @@next as unknown in a template", () => {
    expect(templateMarkerIssues("# @@next\n", "python")).toEqual([
      { line: 1, kind: "unknown", marker: "@@next" },
    ]);
  });

  it("reports a close with no open lock, and a lock inside an open one", () => {
    expect(templateMarkerIssues("x\n// @@endlock\n// @@lock\n// @@lock\ny\n// @@unlock\n// @@unlock\n", "c")).toEqual([
      { line: 2, kind: "unopened", marker: "@@endlock" },
      { line: 4, kind: "nested", marker: "@@lock" },
      { line: 7, kind: "unopened", marker: "@@unlock" },
    ]);
  });

  it("ignores the comment syntax of another language", () => {
    expect(templateMarkerIssues("# @@unlok\n", "c")).toEqual([]);
  });
});

describe("assembleSource", () => {
  it("rebuilds the source from the template, never from client text", () => {
    const source = assembleSource(C_TEMPLATE, "c", ["#include <stdio.h>\n", "    total = 42;\n"]);
    expect(source).toContain("int main(void) {");
    expect(source).toContain("    total = 42;");
    expect(source.endsWith("// @@endlock\n")).toBe(true);
  });

  it("adds the missing line break of a region that is not the last segment", () => {
    expect(assembleSource(C_TEMPLATE, "c", ["a", "b"])).toBe(
      ["a", "// @@lock", "int main(void) {", "// @@endlock", "b", "// @@lock", "    return 0;", "}", "// @@endlock", ""].join(
        "\n",
      ),
    );
  });

  it("accepts an empty region without breaking the locked lines", () => {
    expect(assembleSource("a\n// @@lock\nb\n// @@endlock\n", "c", [""])).toBe("// @@lock\nb\n// @@endlock\n");
  });

  it("leaves the last segment alone when it is editable", () => {
    expect(assembleSource("// @@lock\na\n// @@endlock\nb", "c", ["x"])).toBe("// @@lock\na\n// @@endlock\nx");
  });

  it("refuses an answer that does not fit the template", () => {
    expect(() => assembleSource(C_TEMPLATE, "c", ["only one"])).toThrow(TemplateRegionMismatch);
    expect(() => assembleSource(C_TEMPLATE, "c", ["a", "b", "c"])).toThrow(
      /2 editable region\(s\), got 3/,
    );
  });
});

describe("mainFileName", () => {
  it("names the main file of each language", () => {
    const languages: TemplateLanguage[] = ["c", "cpp", "python", "js", "rust"];
    expect(languages.map(mainFileName)).toEqual(["main.c", "main.cpp", "main.py", "main.js", "main.rs"]);
  });
});
