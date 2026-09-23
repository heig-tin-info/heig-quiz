import { describe, expect, it } from "vitest";
import {
  assembleSource,
  emptyRegions,
  mainFileName,
  regionCount,
  splitTemplate,
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
