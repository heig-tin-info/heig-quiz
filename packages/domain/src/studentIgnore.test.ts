import { describe, expect, it } from "vitest";

import { isProtected, withForcedProtected } from "./protectedFiles.js";
import { handoutTree, parseStudentIgnore } from "./studentIgnore.js";

describe("parseStudentIgnore", () => {
  it("keeps plain relative paths and drops comments and blanks", () => {
    expect(parseStudentIgnore("# teacher only\n\nscripts/\n/.github/workflows/studentize.yml\r\n")).toEqual([
      "scripts",
      ".github/workflows/studentize.yml",
    ]);
  });

  it("refuses anything that leaves the tree or touches git", () => {
    expect(parseStudentIgnore("../outside\na/../../b\n.git\n.git/config\n./x\n/\n")).toEqual([]);
  });
});

describe("handoutTree", () => {
  const blob = (path: string) => ({ path, type: "blob" as const });
  const tree = (path: string) => ({ path, type: "tree" as const });

  it("overlays student/, then drops the ignored paths, their content and the ignore file", () => {
    const source = [
      tree("src"),
      blob("src/main.c"),
      blob("criteria.yml"),
      blob(".studentignore"),
      tree("solution"),
      blob("solution/answer.c"),
      tree("student"),
      tree("student/src"),
      blob("student/src/main.c"),
      blob("student/NOTES.md"),
    ];
    expect(handoutTree(source, ["solution", "missing"])).toEqual([
      { path: "NOTES.md", type: "blob", from: "student/NOTES.md" },
      { path: "criteria.yml", type: "blob", from: "criteria.yml" },
      { path: "src", type: "tree", from: "student/src" },
      { path: "src/main.c", type: "blob", from: "student/src/main.c" },
    ]);
  });

  it("leaves a tree without overlay nor ignore list as it is", () => {
    expect(handoutTree([blob("student"), blob("a.txt")], [])).toEqual([
      { path: "a.txt", type: "blob", from: "a.txt" },
      { path: "student", type: "blob", from: "student" },
    ]);
  });
});

describe("protected files", () => {
  it("protects a listed file and the content of a listed directory", () => {
    expect(isProtected(".github/workflows/grading.yml", [".github/workflows"])).toBe(true);
    expect(isProtected(".github/workflows", [".github/workflows"])).toBe(true);
    expect(isProtected(".github/workflows-old/x.yml", [".github/workflows"])).toBe(false);
  });

  it("forces the workflows and the criteria in criteria mode only", () => {
    expect(withForcedProtected(["README.md", "criteria.yml"], "criteria")).toEqual(["README.md", "criteria.yml", ".github/workflows"]);
    expect(withForcedProtected(["README.md"], "auto")).toEqual(["README.md"]);
  });
});
