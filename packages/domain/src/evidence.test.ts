import { describe, expect, it } from "vitest";

import { automaticPoints, coversCase, parseJunit, plainSources, proratedByTests, sourcePaths, stripTarballRoot } from "./evidence.js";

const REPORT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="5">
<testcase classname="tests.test_parse" name="test_empty" time="0.001" />
<testcase classname="tests.test_parse" name="test_long" time="0.002"><failure message="assert 1 == 2 &amp; &lt;x&gt;">trace</failure></testcase>
<testcase classname="tests.test_parse.TestEdge" name="test_edge[a&gt;b]" time="0.001"></testcase>
<testcase classname="tests.test_run" name="test_crash"><error message="fixture failed">x</error></testcase>
<testcase classname="tests.test_run" name="test_later"><skipped type="pytest.skip" message="later" /></testcase>
</testsuite></testsuites>`;

describe("parseJunit", () => {
  it("reads every case: a failure, an error and a skipped case are not passed", () => {
    const report = parseJunit(REPORT);
    expect(report.total).toBe(5);
    expect(report.passed).toBe(2);
    expect(report.cases).toEqual([
      { name: "test_empty", classname: "tests.test_parse", passed: true },
      { name: "test_long", classname: "tests.test_parse", passed: false, message: "assert 1 == 2 & <x>" },
      { name: "test_edge[a>b]", classname: "tests.test_parse.TestEdge", passed: true },
      { name: "test_crash", classname: "tests.test_run", passed: false, message: "fixture failed" },
      { name: "test_later", classname: "tests.test_run", passed: false, message: "later" },
    ]);
  });

  it("yields no case from text that is not a report", () => {
    expect(parseJunit("not xml at all")).toEqual({ cases: [], passed: 0, total: 0 });
    expect(parseJunit("")).toEqual({ cases: [], passed: 0, total: 0 });
  });
});

describe("automaticPoints", () => {
  const cases = parseJunit(REPORT).cases;
  const testsCriterion = "rendu.all-tests-passed";

  it("grades the tests criterion by the share of every passed case, to the half point", () => {
    expect(automaticPoints({ id: testsCriterion, maxPoints: 10 }, cases, testsCriterion)).toBe(4); // 2/5 of 10
    expect(automaticPoints({ id: testsCriterion, maxPoints: 3 }, cases, testsCriterion)).toBe(1); // 1.2 → 1
    expect(automaticPoints({ id: testsCriterion, maxPoints: 4 }, cases, testsCriterion)).toBe(1.5); // 1.6 → 1.5
  });

  it("grades a test: leaf by the cases its name prefix or node id covers", () => {
    expect(automaticPoints({ id: "a.parse", maxPoints: 6, test: "tests/test_parse.py" }, cases, testsCriterion)).toBe(4); // 2/3
    expect(automaticPoints({ id: "a.edge", maxPoints: 2, test: "tests/test_parse.py::TestEdge" }, cases, testsCriterion)).toBe(2);
    expect(automaticPoints({ id: "a.long", maxPoints: 2, test: "test_long" }, cases, testsCriterion)).toBe(0);
    expect(automaticPoints({ id: "a.none", maxPoints: 2, test: "test_missing" }, cases, testsCriterion)).toBe(0);
  });

  it("leaves a bonus and a penalty to the teacher", () => {
    expect(proratedByTests({ maxPoints: 0, bonusPoints: 2 })).toBe(false);
    expect(proratedByTests({ maxPoints: -4 })).toBe(false);
    expect(proratedByTests({ maxPoints: 4 })).toBe(true);
  });

  it("is 0 without cases", () => {
    expect(automaticPoints({ id: testsCriterion, maxPoints: 10 }, [], testsCriterion)).toBe(0);
  });

  it("matches a node id against the dotted classname", () => {
    expect(coversCase("tests/test_parse.py::test_empty", { name: "test_empty", classname: "tests.test_parse" })).toBe(true);
    expect(coversCase("tests/test_run.py", { name: "test_empty", classname: "tests.test_parse" })).toBe(false);
  });
});

describe("stripTarballRoot", () => {
  it("drops GitHub's top-level directory and anything outside it", () => {
    const entries = [
      { path: "org-lab-alice-abc1234/" },
      { path: "org-lab-alice-abc1234/Makefile" },
      { path: "org-lab-alice-abc1234/src/main.c" },
      { path: "elsewhere/x" },
    ];
    expect(stripTarballRoot(entries).map((e) => e.path)).toEqual(["Makefile", "src/main.c"]);
    expect(stripTarballRoot([])).toEqual([]);
  });
});

describe("sourcePaths", () => {
  const paths = ["report.xml", "build/rapport.md", "build/deep/x.c", "src/main.c", "src/a/b.c", "README.md"];

  it("keeps the paths a source names or holds, in their order; a wildcard names nothing", () => {
    expect(sourcePaths(["build/", "./README.md"], paths)).toEqual(["build/rapport.md", "build/deep/x.c", "README.md"]);
    expect(sourcePaths(["src/main.c", "src/a"], paths)).toEqual(["src/main.c"]);
    expect(sourcePaths(["src/*.c"], paths)).toEqual([]);
    expect(plainSources(["src/", "*.md", "a/b?.c", "./x"])).toEqual({ plain: ["src/", "x"], wildcards: ["*.md", "a/b?.c"] });
  });

  it("keeps every path when no glob is given", () => {
    expect(sourcePaths([], paths)).toEqual(paths);
  });
});
