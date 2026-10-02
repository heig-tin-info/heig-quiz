import { describe, expect, it } from "vitest";

import { applyParsed } from "../apply.js";
import { EXAMPLES } from "../examples.js";
import { estimateText } from "../geometry.js";
import { DIAGRAM_KINDS, type DiagramKind } from "../kinds.js";
import { CODECS, formOf, toText } from "./index.js";
import { MAX_LINE } from "./parsed.js";

const TEXT_KINDS = DIAGRAM_KINDS.filter((k) => CODECS[k] !== null);
const parseText = (text: string, kind: DiagramKind) => CODECS[kind]!.read(text);

describe("the text round trip", () => {
  it.each(TEXT_KINDS)("%s: text → scene → the same text, no error", (kind) => {
    const text = toText(EXAMPLES[kind], kind) ?? "";
    const parsed = parseText(text, kind);
    expect(parsed.errors).toEqual([]);
    const scene = applyParsed(EXAMPLES[kind], parsed, kind, estimateText);
    expect(toText(scene, kind)).toBe(text);
  });

  it.each(TEXT_KINDS)("%s: every element keeps its place and every link its elbows", (kind) => {
    const scene = applyParsed(EXAMPLES[kind], parseText(toText(EXAMPLES[kind], kind) ?? "", kind), kind, estimateText);
    const byId = <T extends { id: string }>(list: readonly T[]): T[] => [...list].sort((p, q) => (p.id < q.id ? -1 : 1));
    expect(byId(scene.nodes).map((n) => [n.id, n.x, n.y])).toEqual(byId(EXAMPLES[kind].nodes).map((n) => [n.id, n.x, n.y]));
    expect(byId(scene.links).map((l) => [l.id, l.via])).toEqual(byId(EXAMPLES[kind].links).map((l) => [l.id, l.via]));
  });

  it("free has no text form", () => {
    expect(toText(EXAMPLES.free, "free")).toBeNull();
  });
});

const parse = (kind: DiagramKind, text: string) => parseText(text, kind);

describe("formOf", () => {
  it("names the notation of every kind with a text form, and none for `free`", () => {
    for (const kind of DIAGRAM_KINDS) expect(formOf(kind) === null).toBe(CODECS[kind] === null);
    expect(formOf("class")).toBe("a UML class diagram in PlantUML");
  });
});

describe("PlantUML", () => {
  it("reads reversed arrows, multiplicities and a label", () => {
    const p = parse("class", 'class A\nclass B\nB "1" <|-- "0..*" A : parent\nC o-- D');
    expect(p.errors).toEqual([]);
    expect(p.links.map((l) => [l.a.name, l.type, l.b.name, l.ma ?? "", l.mb ?? "", l.name ?? ""])).toEqual([
      ["A", "inh", "B", "0..*", "1", "parent"],
      ["D", "agg", "C", "", "", ""],
    ]);
  });

  it("declares a class a link names, reads a body and its separators", () => {
    const p = parse("class", "abstract class Figure {\n  # x : int\n  ==\n  + aire() : double\n}\nFigure -up-> Point");
    expect(p.nodes.map((n) => [n.name, n.abstract ?? false, n.body])).toEqual([
      ["Figure", true, ["# x : int", "---", "+ aire() : double"]],
      ["Point", false, ["---"]],
    ]);
    expect(p.links[0]?.type).toBe("nav");
  });

  it("reads the use case shorthands and a boundary", () => {
    const p = parse("usecase", 'package Shop {\n  (Buy)\n}\n:Client: --> (Buy)\n(Buy) ..> (Log in) : <<include>>');
    expect(p.errors).toEqual([]);
    expect(p.nodes.map((n) => [n.t, n.name, n.sys?.name])).toEqual([
      ["system", "Shop", undefined],
      ["usecase", "Buy", "Shop"],
      ["actor", "Client", undefined],
      ["usecase", "Log in", undefined],
    ]);
    expect(p.links.map((l) => l.type)).toEqual(["assoc", "incl"]);
  });

  it("names what it cannot read", () => {
    expect(parse("usecase", "A -- B").errors).toEqual([{ line: 1, code: "undeclared", text: "A" }]);
    expect(parse("usecase", "(A) ..> (B)").errors).toEqual([{ line: 1, code: "dottedLabel", text: "..>" }]);
    expect(parse("usecase", "(A) --* (B)").errors).toEqual([{ line: 1, code: "arrowKind", text: "--*" }]);
    expect(parse("class", "}").errors).toEqual([{ line: 1, code: "brace", text: "}" }]);
    expect(parse("class", "class A {\n+ x").errors).toEqual([{ line: 2, code: "unclosed", text: "A" }]);
    expect(parse("class", "what is this").errors[0]?.code).toBe("unknown");
  });
});

describe("Mermaid", () => {
  it("flowchart: shapes, chains and both label forms", () => {
    const p = parse("flow", "flowchart TD\n  a([Start]) --> b[Read n] -- yes --> c{n > 0 ?}\n  c -->|no| a");
    expect(p.errors).toEqual([]);
    expect(p.nodes.map((n) => [n.t, n.name])).toEqual([
      ["terminal", "Start"],
      ["action", "Read n"],
      ["decision", "n > 0 ?"],
    ]);
    expect(p.links.map((l) => l.name ?? "")).toEqual(["", "yes", "no"]);
    expect(parse("flow", "a -->").errors).toEqual([{ line: 1, code: "afterArrow", text: "" }]);
  });

  it("state machine: [*] on either side, descriptions, a composite refused", () => {
    const p = parse("state", 'stateDiagram-v2\n  state "Long name" as s1\n  [*] --> s1\n  s1 : entry / go\n  s1 --> [*] : stop');
    expect(p.nodes.map((n) => [n.t, n.name, n.body ?? []])).toEqual([
      ["state", "Long name", ["entry / go"]],
      ["initial", "", []],
      ["final", "", []],
    ]);
    expect(p.links.map((l) => [l.a.t, l.b.t, l.name ?? ""])).toEqual([
      ["initial", "state", ""],
      ["state", "final", "stop"],
    ]);
    expect(parse("state", "state Big {").errors[0]?.code).toBe("composite");
  });

  it("entity-relationship: cardinalities both ways, attributes, an unclosed entity", () => {
    const p = parse("er", 'erDiagram\n  CLIENT {\n    int id PK\n  }\n  CLIENT ||--o{ ORDER_LINE : "places"');
    expect(p.nodes.map((n) => [n.name, n.body])).toEqual([
      ["CLIENT", ["id : int PK"]],
      ["ORDER LINE", []],
    ]);
    expect(p.links.map((l) => [l.ma, l.mb, l.name])).toEqual([["1", "0..*", "places"]]);
    expect(parse("er", "A {\n  broken\n").errors.map((e) => e.code)).toEqual(["attribute", "unclosed"]);
  });
});

describe("DOT", () => {
  it("automaton: a point-shaped start, an accepting state, a label", () => {
    const p = parse("automaton", 'digraph { s [shape=point]; q1 [shape=doublecircle]; s -> q0; q0 -> q1 [label="a"] }');
    expect(p.errors).toEqual([]);
    expect(p.nodes.map((n) => [n.name, n.initial, n.accept])).toEqual([
      ["q1", false, true],
      ["q0", true, false],
    ]);
    expect(p.links.map((l) => [l.a.name, l.b.name, l.name])).toEqual([["q0", "q1", "a"]]);
    expect(parse("automaton", "q0 -- q1").errors).toEqual([{ line: 1, code: "directed", text: "--" }]);
  });

  it("graph: edges and arcs, a weight, a chain", () => {
    const p = parse("graph", 'digraph {\n  A -> B [weight=3]\n  B -> C -> A [dir=none]\n}');
    expect(p.links.map((l) => [l.a.name, l.b.name, l.type, l.name ?? ""])).toEqual([
      ["A", "B", "arc", "3"],
      ["B", "C", "edge", ""],
      ["C", "A", "edge", ""],
    ]);
  });

  it("writes an undirected graph with --, a mixed one as a digraph with dir=none", () => {
    expect(toText(EXAMPLES.graph, "graph")).toMatch(/^graph \{\n[\s\S]*A -- B \[label="4"\]/);
    const mixed = { ...EXAMPLES.graph, links: [...EXAMPLES.graph.links, { id: "lz01", type: "arc" as const, a: "n001", b: "n006" }] };
    const text = toText(mixed, "graph") ?? "";
    expect(text).toMatch(/^digraph/);
    expect(text).toContain('A -> B [label="4", dir=none]');
    expect(text).toContain("A -> F\n");
  });
});

describe("a crafted text stays cheap to read", () => {
  /* each of these took seconds with the first patterns (ADR-046 review): every one must now read in milliseconds */
  const cases: Array<[DiagramKind, string]> = [
    ["er", `A {\n  a b${"  PK".repeat(300)}!\n}`],
    ["class", `class A <<${" ".repeat(MAX_LINE - 20)}>!`],
    ["graph", `${"a;".repeat(MAX_LINE / 2 - 1)}`],
    ["flow", `a -- ${"x ".repeat(MAX_LINE / 2 - 10)}`],
    ["class", `A ${"-".repeat(MAX_LINE - 10)} B`],
    ["class", `${`class A${" ".repeat(MAX_LINE - 10)}!\n`.repeat(10)}`],
    /* the whole-text passes of DOT, before any line is cut */
    ["graph", " \n".repeat(99_000)],
    ["automaton", `${"graph\n".repeat(33_000)}{`],
    ["graph", "/* ".repeat(66_000)],
  ];
  /* A backtracking pattern costs seconds; the bound leaves room for a loaded
   * machine and for V8 coverage instrumentation (220 ms seen under 200). */
  it.each(cases)("%s", (kind, text) => {
    const start = performance.now();
    parseText(text, kind);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("refuses a line longer than it reads", () => {
    expect(parseText(`class ${"A".repeat(MAX_LINE)}`, "class").errors[0]?.code).toBe("unknown");
  });
});
