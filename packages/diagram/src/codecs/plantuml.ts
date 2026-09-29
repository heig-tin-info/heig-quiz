/**
 * PlantUML, for the class and the use case diagrams: the subset the
 * serialiser writes, plus the usual shorthands a teacher types —
 * `(use case)`, `:actor:`, reversed arrows (`<|--`, `o--`), direction hints
 * (`-up->`), longer arrows (`--->`), `package` for a boundary.
 */
import { holds, isSeparator, rectOf, type Measure } from "../geometry.js";
import type { LinkType, Scene } from "../scene.js";
import { emptyParsed, isIdentifier, unquote, type Parsed, type ParsedNode } from "./parsed.js";

const quote = (s: string): string => (isIdentifier(s) ? s : `"${s.replace(/"/g, "'")}"`);

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
  const byId = new Map(scene.nodes.map((n) => [n.id, n] as const));
  let o = "@startuml\n";
  for (const n of scene.nodes) {
    const name = n.name ?? "";
    const kw =
      n.stereo === "interface" ? "interface" : n.stereo === "enumeration" ? "enum" : n.abstract ? "abstract class" : "class";
    const st = n.stereo && n.stereo !== "interface" && n.stereo !== "enumeration" ? ` <<${n.stereo}>>` : "";
    o += `${kw} ${quote(name)}${st} {\n`;
    for (const line of n.body ?? []) o += `  ${isSeparator(line) ? "--" : line}\n`;
    o += "}\n";
  }
  if (scene.links.length > 0) o += "\n";
  for (const l of scene.links) {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (!a || !b) continue;
    o += `${quote(a.name ?? "")}${l.ma ? ` "${l.ma}"` : ""} ${ARROW_OUT[l.type] ?? "--"}${l.mb ? ` "${l.mb}"` : ""} ${quote(b.name ?? "")}${l.name ? ` : ${l.name}` : ""}\n`;
  }
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
  for (const l of scene.links) {
    const a = alias.get(l.a);
    const b = alias.get(l.b);
    if (!a || !b) continue;
    const label = l.type === "incl" ? " : <<include>>" : l.type === "ext" ? " : <<extend>>" : l.name ? ` : ${l.name}` : "";
    o += `${a} ${ARROW_OUT[l.type] ?? "--"} ${b}${label}\n`;
  }
  return `${o}@enduml\n`;
}

const NAME = String.raw`"[^"]+"|\([^)]+\)|:[^:]+:|[\p{L}\w$]+`;
/* a leading `o` only before a dash or a dot, a trailing one only before a space or a quote */
const ARROW = String.raw`(?:<\|?|\*|o(?=[-.]))?[-.]+(?:(?:up|down|left|right|u|d|l|r)[-.]+)?(?:\|?>|\*|o(?=[\s"]))?`;
const LINK_RE = new RegExp(`^(${NAME})\\s*(?:"([^"]*)"\\s*)?(${ARROW})\\s*(?:"([^"]*)"\\s*)?(${NAME})\\s*(?::\\s*(.*))?$`, "u");
const CLASS_RE =
  /^(abstract\s+class|abstract|class|interface|enum)\s+("[^"]+"|[\p{L}\w$]+)(?:\s+as\s+[\p{L}\w$]+)?\s*(?:<<\s*(.+?)\s*>>)?\s*(\{)?\s*(\})?$/u;
const ACTOR_RE = new RegExp(`^actor\\s+(${NAME})(?:\\s+as\\s+([\\p{L}\\w$]+))?(?:\\s*<<[^>]*>>)?$`, "u");
const USECASE_RE = new RegExp(`^usecase\\s+(${NAME})(?:\\s+as\\s+([\\p{L}\\w$]+))?$`, "u");
const SYSTEM_RE = new RegExp(`^(?:rectangle|package)\\s+(${NAME})(?:\\s+as\\s+[\\p{L}\\w$]+)?\\s*\\{$`, "u");
const IGNORED = /^(@startuml|@enduml|skinparam\b|hide\b|show\b|title\b|left to right direction|top to bottom direction)/i;

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

export function parsePlantUml(text: string, kind: "class" | "usecase"): Parsed {
  const p = emptyParsed();
  const keys = new Map<string, ParsedNode>();
  const systems: ParsedNode[] = [];
  let cur: ParsedNode | null = null;
  const lines = text.split("\n");

  const declare = (t: ParsedNode["t"], name: string, alias?: string): ParsedNode => {
    let n = keys.get(name) ?? (alias ? keys.get(alias) : undefined);
    if (!n || n.t !== t) {
      n = { t, name, ...(t === "class" ? { stereo: "", abstract: false, body: ["---"] } : {}) };
      p.nodes.push(n);
    }
    keys.set(name, n);
    if (alias) keys.set(alias, n);
    const sys = systems[systems.length - 1];
    if (sys && t !== "system" && !n.sys) n.sys = sys;
    return n;
  };
  const ref = (tok: string): ParsedNode | null => {
    if (tok.startsWith("(")) return declare("usecase", tok.slice(1, -1).trim());
    if (tok.startsWith(":") && tok.length > 1) return declare("actor", tok.slice(1, -1).trim());
    return keys.get(unquote(tok)) ?? (kind === "class" ? declare("class", unquote(tok)) : null);
  };

  lines.forEach((raw, i) => {
    const s = raw.trim();
    const line = i + 1;
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
      n.stereo = kw === "interface" ? "interface" : kw === "enum" ? "enumeration" : (m[3] ?? "");
      if (m[4]) {
        n.body = [];
        if (!m[5]) cur = n;
      }
      return;
    }
    if (kind === "usecase") {
      if ((m = ACTOR_RE.exec(s))) {
        declare("actor", unquote(m[1] ?? "").replace(/^:(.*):$/, "$1"), m[2]);
        return;
      }
      if ((m = /^:([^:]+):(?:\s+as\s+([\p{L}\w$]+))?$/u.exec(s))) {
        declare("actor", (m[1] ?? "").trim(), m[2]);
        return;
      }
      if ((m = USECASE_RE.exec(s))) {
        declare("usecase", unquote(m[1] ?? "").replace(/^\((.*)\)$/, "$1"), m[2]);
        return;
      }
      if ((m = /^\(([^)]+)\)(?:\s+as\s+([\p{L}\w$]+))?$/u.exec(s))) {
        declare("usecase", (m[1] ?? "").trim(), m[2]);
        return;
      }
      if ((m = SYSTEM_RE.exec(s))) {
        const sys: ParsedNode = { t: "system", name: unquote(m[1] ?? "") };
        p.nodes.push(sys);
        systems.push(sys);
        return;
      }
    }
    if ((m = LINK_RE.exec(s))) {
      const arrow = m[3] ?? "";
      const norm = arrow.replace(/(up|down|left|right|u|d|l|r)/, "").replace(/-+/g, "--").replace(/\.+/g, "..");
      const meaning = ARROW_IN[norm];
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
      let [type, reversed] = meaning;
      if (reversed) {
        [a, b] = [b, a];
        [ma, mb] = [mb, ma];
      }
      if (kind === "usecase") {
        if (type === "dep") {
          if (/include/i.test(label)) type = "incl";
          else if (/extend/i.test(label)) type = "ext";
          else {
            p.errors.push({ line, code: "dottedLabel", text: arrow });
            return;
          }
          label = "";
        } else if (type === "nav") type = "assoc";
        else if (type !== "assoc" && type !== "inh") {
          p.errors.push({ line, code: "arrowKind", text: arrow });
          return;
        }
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
