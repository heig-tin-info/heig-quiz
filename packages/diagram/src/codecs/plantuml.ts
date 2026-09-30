/**
 * PlantUML, for the class and the use case diagrams: the subset the
 * serialiser writes, plus the usual shorthands a teacher types —
 * `(use case)`, `:actor:`, reversed arrows (`<|--`, `o--`), direction hints
 * (`-up->`), longer arrows (`--->`), `package` for a boundary.
 */
import { holds, isSeparator, rectOf, type Measure } from "../geometry.js";
import type { LinkType, Scene } from "../scene.js";
import { NodeTable, emptyParsed, isIdentifier, linkEnds, quote, tooLong, unquote, type Parsed, type ParsedNode } from "./parsed.js";

const ARROW_OUT: Readonly<Partial<Record<LinkType, string>>> = {
  assoc: "--",
  nav: "-->",
  inh: "--|>",
  impl: "..|>",
  dep: "..>",
  agg: "--o",
  comp: "--*",
  incl: "..>",
  ext: "..>",
};

export function classToText(scene: Scene): string {
  let o = "@startuml\n";
  for (const n of scene.nodes) {
    const kw = n.stereo === "interface" ? "interface" : n.stereo === "enumeration" ? "enum" : n.abstract ? "abstract class" : "class";
    const st = n.stereo && n.stereo !== "interface" && n.stereo !== "enumeration" ? ` <<${n.stereo}>>` : "";
    o += `${kw} ${quote(n.name ?? "")}${st} {\n`;
    for (const line of n.body ?? []) o += `  ${isSeparator(line) ? "--" : line}\n`;
    o += "}\n";
  }
  if (scene.links.length > 0) o += "\n";
  for (const [l, a, b] of linkEnds(scene))
    o += `${quote(a.name ?? "")}${l.ma ? ` "${l.ma.replace(/"/g, "'")}"` : ""} ${ARROW_OUT[l.type] ?? "--"}${l.mb ? ` "${l.mb.replace(/"/g, "'")}"` : ""} ${quote(b.name ?? "")}${l.name ? ` : ${l.name}` : ""}\n`;
  return `${o}@enduml\n`;
}

export function usecaseToText(scene: Scene, measure: Measure): string {
  /* an alias for every element whose name is not an identifier */
  const alias = new Map<string, string>();
  let actors = 0;
  let cases = 0;
  for (const n of scene.nodes) {
    if (n.t === "system") continue;
    const name = n.name ?? "";
    alias.set(n.id, isIdentifier(name) ? name : n.t === "actor" ? `A${++actors}` : `UC${++cases}`);
  }
  const decl = (n: Scene["nodes"][number]): string =>
    `${n.t === "actor" ? "actor" : "usecase"} ${quote(n.name ?? "")}${alias.get(n.id) !== n.name ? ` as ${alias.get(n.id) ?? ""}` : ""}\n`;
  let o = "@startuml\nleft to right direction\n";
  const inside = new Set<string>();
  const systems = scene.nodes
    .filter((n) => n.t === "system")
    .map((s) => {
      const r = rectOf(s, measure);
      const members = scene.nodes.filter((n) => n.t !== "system" && !inside.has(n.id) && holds(r, rectOf(n, measure)));
      for (const n of members) inside.add(n.id);
      return { s, members };
    });
  for (const n of scene.nodes) if (n.t !== "system" && !inside.has(n.id)) o += decl(n);
  for (const { s, members } of systems) o += `rectangle ${quote(s.name ?? "")} {\n${members.map((n) => `  ${decl(n)}`).join("")}}\n`;
  if (scene.links.length > 0) o += "\n";
  for (const [l, a, b] of linkEnds(scene)) {
    const label = l.type === "incl" ? " : <<include>>" : l.type === "ext" ? " : <<extend>>" : l.name ? ` : ${l.name}` : "";
    o += `${alias.get(a.id) ?? ""} ${ARROW_OUT[l.type] ?? "--"} ${alias.get(b.id) ?? ""}${label}\n`;
  }
  return `${o}@enduml\n`;
}

const NAME = String.raw`"[^"]+"|\([^)]+\)|:[^:]+:|[\p{L}\w$]+`;
const ALIAS = String.raw`(?:\s+as\s+([\p{L}\w$]+))?`;
/* a leading `o` only before a dash or a dot, a trailing one only before a space or a quote */
const ARROW = String.raw`(?:<\|?|\*|o(?=[-.]))?[-.]+(?:(?:up|down|left|right|u|d|l|r)[-.]+)?(?:\|?>|\*|o(?=[\s"]))?`;
const LINK_RE = new RegExp(`^(${NAME})\\s*(?:"([^"]*)"\\s*)?(${ARROW})\\s*(?:"([^"]*)"\\s*)?(${NAME})\\s*(?::\\s*(.*))?$`, "u");
/*
 * One slot of spaces before each optional token, inside its group: a run of
 * spaces then has one way to be read, and a line that fails, fails in time
 * linear in its length. The stereotype is `<<…>>` with no `>` inside.
 */
const CLASS_RE =
  /^(abstract\s+class|abstract|class|interface|enum)\s+("[^"]+"|[\p{L}\w$]+)(?:\s+as\s+[\p{L}\w$]+)?(?:\s*<<([^>]*)>>)?(?:\s*(\{))?(?:\s*(\}))?$/u;
const SYSTEM_RE = new RegExp(`^(?:rectangle|package)\\s+(${NAME})(?:\\s+as\\s+[\\p{L}\\w$]+)?\\s*\\{$`, "u");
const IGNORED = /^(@startuml|@enduml|skinparam\b|hide\b|show\b|title\b|left to right direction|top to bottom direction)/i;

/** The four ways a use case diagram declares an actor or a use case: the pattern, the type, and how to read the name. */
const DECLARATIONS: ReadonlyArray<readonly [RegExp, "actor" | "usecase", (s: string) => string]> = [
  [new RegExp(`^actor\\s+(${NAME})${ALIAS}(?:\\s*<<[^>]*>>)?$`, "u"), "actor", (s) => unquote(s).replace(/^:(.*):$/, "$1")],
  [new RegExp(`^:([^:]+):${ALIAS}$`, "u"), "actor", (s) => s.trim()],
  [new RegExp(`^usecase\\s+(${NAME})${ALIAS}$`, "u"), "usecase", (s) => unquote(s).replace(/^\((.*)\)$/, "$1")],
  [new RegExp(`^\\(([^)]+)\\)${ALIAS}$`, "u"), "usecase", (s) => s.trim()],
];

/** A normalised arrow, the type it means, and whether it points from right to left. */
const ARROW_IN: Readonly<Record<string, readonly [LinkType, boolean]>> = {
  "--": ["assoc", false],
  "-->": ["nav", false],
  "<--": ["nav", true],
  "--|>": ["inh", false],
  "<|--": ["inh", true],
  "..|>": ["impl", false],
  "<|..": ["impl", true],
  "..>": ["dep", false],
  "<..": ["dep", true],
  "..": ["dep", false],
  "--o": ["agg", false],
  "o--": ["agg", true],
  "--*": ["comp", false],
  "*--": ["comp", true],
};

/**
 * What an arrow means in a use case diagram: a dotted one is «include» or
 * «extend» by its label, a navigable association is an association, and
 * the arrows of a class diagram are refused.
 */
function usecaseLinkType(type: LinkType, label: string): LinkType | "dottedLabel" | "arrowKind" {
  if (type === "dep") return /include/i.test(label) ? "incl" : /extend/i.test(label) ? "ext" : "dottedLabel";
  if (type === "nav") return "assoc";
  return type === "assoc" || type === "inh" ? type : "arrowKind";
}

export function parsePlantUml(text: string, kind: "class" | "usecase"): Parsed {
  const p = emptyParsed();
  const table = new NodeTable(p);
  const systems: ParsedNode[] = [];
  let cur: ParsedNode | null = null;
  const lines = text.split("\n");

  const declare = (t: ParsedNode["t"], name: string, alias?: string): ParsedNode => {
    const had = table.get(name) ?? (alias ? table.get(alias) : undefined);
    const n = had && had.t === t ? had : table.add({ t, name, ...(t === "class" ? { stereo: "", abstract: false, body: ["---"] } : {}) });
    table.add(n, name, ...(alias ? [alias] : []));
    const sys = systems[systems.length - 1];
    if (sys && t !== "system" && !n.sys) n.sys = sys;
    return n;
  };
  const ref = (tok: string): ParsedNode | null => {
    if (tok.startsWith("(")) return declare("usecase", tok.slice(1, -1).trim());
    if (tok.startsWith(":") && tok.length > 1) return declare("actor", tok.slice(1, -1).trim());
    return table.get(unquote(tok)) ?? (kind === "class" ? declare("class", unquote(tok)) : null);
  };

  lines.forEach((raw, i) => {
    const s = raw.trim();
    const line = i + 1;
    if (tooLong(p, raw, line)) return;
    if (cur) {
      if (s === "}") cur = null;
      else if (s) cur.body?.push(/^(-{2,}|={2,}|\.{2,}|_{2,})$/.test(s) ? "---" : s);
      return;
    }
    if (!s || s.startsWith("'") || IGNORED.test(s)) return;
    if (s === "}") {
      if (systems.length > 0) systems.pop();
      else p.errors.push({ line, code: "brace", text: "}" });
      return;
    }
    let m: RegExpExecArray | null;
    if (kind === "class" && (m = CLASS_RE.exec(s))) {
      const kw = (m[1] ?? "").replace(/\s+/g, " ");
      const n = declare("class", unquote(m[2] ?? ""));
      n.abstract = kw.startsWith("abstract");
      n.stereo = kw === "interface" ? "interface" : kw === "enum" ? "enumeration" : (m[3] ?? "").trim();
      if (m[4]) {
        n.body = [];
        if (!m[5]) cur = n;
      }
      return;
    }
    if (kind === "usecase") {
      for (const [re, t, read] of DECLARATIONS) {
        if ((m = re.exec(s))) {
          declare(t, read(m[1] ?? ""), m[2]);
          return;
        }
      }
      if ((m = SYSTEM_RE.exec(s))) {
        const sys = table.add({ t: "system", name: unquote(m[1] ?? "") });
        systems.push(sys);
        return;
      }
    }
    if ((m = LINK_RE.exec(s))) {
      const arrow = m[3] ?? "";
      const meaning = ARROW_IN[arrow.replace(/(up|down|left|right|u|d|l|r)/, "").replace(/-+/g, "--").replace(/\.+/g, "..")];
      if (!meaning) {
        p.errors.push({ line, code: "arrow", text: arrow });
        return;
      }
      let a = ref(m[1] ?? "");
      let b = ref(m[5] ?? "");
      if (!a || !b) {
        p.errors.push({ line, code: "undeclared", text: unquote(!a ? (m[1] ?? "") : (m[5] ?? "")) });
        return;
      }
      let ma = m[2] ?? "";
      let mb = m[4] ?? "";
      let label = (m[6] ?? "").trim();
      let type: LinkType | "dottedLabel" | "arrowKind" = meaning[0];
      if (meaning[1]) {
        [a, b] = [b, a];
        [ma, mb] = [mb, ma];
      }
      if (kind === "usecase") {
        type = usecaseLinkType(meaning[0], label);
        if (type === "incl" || type === "ext") label = "";
      }
      if (type === "dottedLabel" || type === "arrowKind") {
        p.errors.push({ line, code: type, text: arrow });
        return;
      }
      p.links.push({ a, b, type, ...(ma ? { ma } : {}), ...(mb ? { mb } : {}), ...(label ? { name: label } : {}) });
      return;
    }
    p.errors.push({ line, code: "unknown", text: s });
  });
  if (cur) p.errors.push({ line: lines.length, code: "unclosed", text: (cur as ParsedNode).name });
  const open = systems[systems.length - 1];
  if (open) p.errors.push({ line: lines.length, code: "unclosed", text: open.name });
  return p;
}
