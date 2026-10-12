import { describe, expect, it } from "vitest";

import {
  automaticPoints,
  commitIdentityPoints,
  commitIdentityRationale,
  coversCase,
  descriptiveMessage,
  parseJunit,
  plainSources,
  proratedByTests,
  sourcePaths,
  stripTarballRoot,
} from "./evidence.js";

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

  it("decodes numeric entities and single quotes, keeps an unknown entity, and reads a case with no attributes", () => {
    const xml = `<testcase classname='t.x' name="&#x41;&#66;&nope;" /><testcase /><testcase name="n"><failure>no message</failure></testcase>`;
    expect(parseJunit(xml).cases).toEqual([
      { name: "AB&nope;", classname: "t.x", passed: true },
      { name: "", classname: "", passed: true },
      { name: "n", classname: "", passed: false },
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
    // A case with no classname: its name is its id.
    expect(coversCase("tests.py::test_x", { name: "tests.test_x", classname: "" })).toBe(true);
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

describe("commitIdentityPoints", () => {
  type Commit = Parameters<typeof commitIdentityPoints>[0][number];
  const GOOD = "Rendu du laboratoire 00";
  const c = (over: Partial<Commit> = {}): Commit => ({ name: "Ada Lovelace", email: "ada.lovelace@heig-vd.ch", subject: GOOD, ...over });

  it.each<[string, Commit[], number]>([
    ["no student commit", [], 0],
    ["a real identity and descriptive messages", [c(), c({ subject: "Ajoute le fichier inventaire" })], 1],
    ["the example identity", [c({ name: "Emmett Lathrop Brown", email: "emmett.brown@heig-vd.ch" })], 0],
    ["the example's short name", [c({ name: " emmett  brown " })], 0],
    ["the example address alone", [c({ email: "doc@example.com" })], 0],
    ["one commit of the example among good ones", [c(), c({ name: "Emmett Brown" })], 0],
    ["a student named Emmett", [c({ name: "Emmett Dupuis", email: "emmett.dupuis@heig-vd.ch" })], 1],
    ["no name", [c({ name: "" })], 0],
    ["no e-mail", [c({ email: " " })], 0],
    ["a meaningless message", [c(), c({ subject: "update" })], 0.5],
    ["GitHub's web default message", [c({ subject: "Update README.md" })], 0.5],
    ["a one-word name", [c({ name: "ada" })], 0.5],
    ["an address of a local machine", [c({ email: "ada@ada-laptop.local" })], 0.5],
    ["an address without a domain", [c({ email: "ada@localhost" })], 0.5],
    ["a weak identity and a meaningless message", [c({ name: "ada", subject: "fix" })], 0],
    ["GitHub's private address", [c({ email: "123+ada-l@users.noreply.github.com" })], 1],
    ["accented names", [c({ name: "Zoë D'Aubigné-Müller" })], 1],
  ])("%s", (_, commits, points) => {
    expect(commitIdentityPoints(commits, 1)).toBe(points);
  });

  it("scales to the criterion's points, rounded to the half point", () => {
    expect(commitIdentityPoints([c({ subject: "wip" })], 3)).toBe(1.5);
    expect(commitIdentityPoints([c({ subject: "wip" })], 5)).toBe(2.5);
    expect(commitIdentityPoints([c()], 4)).toBe(4);
  });

  it("calls a message descriptive from 3 words or 15 characters, never a meaningless one", () => {
    expect(["Rendu du labo", "Ajoute inventaire.txt", "Correct the parser's edge case"].every(descriptiveMessage)).toBe(true);
    expect(["a", "fix", "Update", "WIP.", "initial commit", "work in progress", "Add files via upload", "rendu"].some(descriptiveMessage)).toBe(false);
  });

  it("states the facts, the e-mail's local part masked", () => {
    const rationale = commitIdentityRationale([c(), c({ subject: "fix" }), c({ email: "ada@gmail.com" })]);
    expect(rationale).toBe("3 commits · Ada Lovelace <***@heig-vd.ch>, Ada Lovelace <***@gmail.com> · messages: 2 descriptive, 1 short");
    expect(rationale).not.toContain("ada.lovelace");
    expect(commitIdentityRationale([])).toBe("0 commits");
    expect(commitIdentityRationale([c({ name: "", email: "" })])).toBe("1 commit · — <—> · messages: 1 descriptive, 0 short");
  });
});
