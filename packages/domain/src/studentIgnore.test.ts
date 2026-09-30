import { describe, expect, it } from "vitest";

import { parseStudentIgnore } from "./studentIgnore.js";

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
