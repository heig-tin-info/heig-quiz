/**
 * Mermaid, for three kinds: the flowchart (`flowchart`), the state machine
 * (`stateDiagram-v2`) and the entity-relationship diagram (`erDiagram`,
 * crow's foot). The flowchart is a graph, and Mermaid says graphs; PlantUML's
 * activity syntax is structured (if / endif) and could not say a loop drawn
 * by hand.
 */
import { isSeparator } from "../geometry.js";
import { FLOW_NODES } from "../kinds.js";
import { CARDINALITIES, type Cardinality, type DiagramNode, type NodeType, type Scene } from "../scene.js";
import { NodeTable, emptyParsed, isIdentifier, linkEnds, tooLong, unquote, type Parsed, type ParsedNode } from "./parsed.js";

// ---------------------------------------------------------------------------
// Flowchart
// ---------------------------------------------------------------------------

const SHAPE_OUT: Readonly<Partial<Record<NodeType, readonly [string, string]>>> = {
  terminal: ["([", "])"],
  action: ["[", "]"],
  decision: ["{", "}"],
};

export function flowToText(scene: Scene): string {
  const id = new Map(scene.nodes.filter((n) => FLOW_NODES.has(n.t)).map((n, i) => [n.id, `n${i + 1}`] as const));
  let o = "flowchart TD\n";
  for (const n of scene.nodes) {
    const shape = SHAPE_OUT[n.t];
    if (!shape || !id.has(n.id)) continue;
    o += `  ${id.get(n.id) ?? ""}${shape[0]}"${(n.name ?? "").replace(/"/g, "#quot;")}"${shape[1]}\n`;
  }
  for (const [l, a, b] of linkEnds(scene)) {
    if (!id.has(a.id) || !id.has(b.id)) continue;
    o += `  ${id.get(a.id) ?? ""} -->${l.name ? `|${l.name.replace(/\|/g, "/")}|` : ""} ${id.get(b.id) ?? ""}\n`;
  }
  return o;
}

const SHAPE_IN: ReadonlyArray<readonly [RegExp, NodeType]> = [
  [/^\(\[(.*)\]\)$/s, "terminal"],
  [/^\(\((.*)\)\)$/s, "terminal"],
  [/^\{(.*)\}$/s, "decision"],
  [/^\[(.*)\]$/s, "action"],
  [/^\((.*)\)$/s, "action"],
];
const label = (s: string): string => unquote(s.trim()).replace(/#quot;/g, '"').trim();

export function parseFlow(text: string): Parsed {
  const p = emptyParsed();
  const table = new NodeTable(p);
  const node = (id: string, shape: string | undefined): ParsedNode => {
    const n = table.obtain(id, () => ({ t: "action", name: id }));
    if (shape)
      for (const [re, t] of SHAPE_IN) {
        const m = re.exec(shape);
        if (m) {
          n.t = t;
          n.name = label(m[1] ?? "");
          break;
        }
      }
    return n;
  };
  const NODE = /\s*([\p{L}_][\p{L}\w]*)\s*(\(\[.*?\]\)|\(\(.*?\)\)|\{.*?\}|\[.*?\]|\(.*?\))?/uy;
  const EDGE = /\s*(?:--\s*([^\s>|-][^>|]*?)\s*-->|-->|---|-\.->|==>)\s*(?:\|([^|]*)\|)?/y;
  text.split("\n").forEach((raw, i) => {
    const s = raw.trim().replace(/;$/, "");
    const line = i + 1;
    if (tooLong(p, raw, line)) return;
    if (!s || s.startsWith("%%") || /^(flowchart|graph)\b/i.test(s)) return;
    NODE.lastIndex = 0;
    const first = NODE.exec(s);
    if (!first) {
      p.errors.push({ line, code: "unknown", text: s });
      return;
    }
    let prev = node(first[1] ?? "", first[2]);
    let pos = NODE.lastIndex;
    while (s.slice(pos).trim()) {
      EDGE.lastIndex = pos;
      const e = EDGE.exec(s);
      if (!e) {
        p.errors.push({ line, code: "unknown", text: s.slice(pos).trim() });
        return;
      }
      NODE.lastIndex = EDGE.lastIndex;
      const next = NODE.exec(s);
      if (!next) {
        p.errors.push({ line, code: "afterArrow", text: "" });
        return;
      }
      const target = node(next[1] ?? "", next[2]);
      const name = label(e[1] ?? e[2] ?? "");
      p.links.push({ a: prev, b: target, type: "flow", ...(name ? { name } : {}) });
      prev = target;
      pos = NODE.lastIndex;
    }
  });
  return p;
}

// ---------------------------------------------------------------------------
// State machine: [*] is the initial state on the left of an arrow, the final one on its right
// ---------------------------------------------------------------------------

export function stateToText(scene: Scene): string {
  const states = scene.nodes.filter((n) => n.t === "state");
  const id = new Map<string, string>();
  let k = 0;
  for (const n of states) id.set(n.id, isIdentifier(n.name ?? "") ? (n.name ?? "") : `s${++k}`);
  const linked = new Set(scene.links.flatMap((l) => [l.a, l.b]));
  let o = "stateDiagram-v2\n";
  for (const n of states) {
    const sid = id.get(n.id) ?? "";
    if (sid !== n.name) o += `  state "${(n.name ?? "").replace(/"/g, "'")}" as ${sid}\n`;
    else if ((n.body ?? []).length === 0 && !linked.has(n.id)) o += `  ${sid}\n`;
    for (const line of n.body ?? []) o += `  ${sid} : ${line}\n`;
  }
  const end = (n: DiagramNode, left: boolean): string | null =>
    n.t === "initial" ? (left ? "[*]" : null) : n.t === "final" ? (left ? null : "[*]") : (id.get(n.id) ?? null);
  for (const [l, a, b] of linkEnds(scene)) {
    const from = end(a, true);
    const to = end(b, false);
    if (from && to) o += `  ${from} --> ${to}${l.name ? ` : ${l.name}` : ""}\n`;
  }
  return o;
}

const SID = String.raw`[\p{L}_][\p{L}\w]*`;
const STATE_AS = new RegExp(`^state\\s+"([^"]+)"\\s+as\\s+(${SID})$`, "u");
const STATE_BARE = new RegExp(`^state\\s+(${SID})$`, "u");
const TRANSITION = new RegExp(`^(\\[\\*\\]|${SID})\\s*-->\\s*(\\[\\*\\]|${SID})\\s*(?::\\s*(.*))?$`, "u");
const DESCRIPTION = new RegExp(`^(${SID})\\s*:\\s*(.*)$`, "u");
const LONE = new RegExp(`^(${SID})$`, "u");

export function parseState(text: string): Parsed {
  const p = emptyParsed();
  const table = new NodeTable(p);
  const declare = (name: string, alias?: string): ParsedNode => {
    const n = table.get(alias ?? name) ?? table.get(name) ?? { t: "state", name, body: [] };
    return table.add(n, name, ...(alias ? [alias] : []));
  };
  /* [*] is the initial state on the left of an arrow, the final one on its right */
  const ref = (tok: string, left: boolean): ParsedNode => {
    if (tok !== "[*]") return table.get(tok) ?? declare(tok);
    return left ? table.obtain("[*]<", () => ({ t: "initial", name: "" })) : table.obtain("[*]>", () => ({ t: "final", name: "" }));
  };
  text.split("\n").forEach((raw, i) => {
    const s = raw.trim();
    const line = i + 1;
    let m: RegExpExecArray | null;
    if (tooLong(p, raw, line)) return;
    if (!s || s.startsWith("%%") || /^stateDiagram/.test(s) || /^direction\b/.test(s)) return;
    if ((m = STATE_AS.exec(s))) declare(m[1] ?? "", m[2]);
    else if (/^state\b.*\{$/.test(s)) p.errors.push({ line, code: "composite", text: s });
    else if ((m = STATE_BARE.exec(s))) declare(m[1] ?? "");
    else if ((m = TRANSITION.exec(s))) {
      const name = (m[3] ?? "").trim();
      p.links.push({ a: ref(m[1] ?? "", true), b: ref(m[2] ?? "", false), type: "strans", ...(name ? { name } : {}) });
    } else if ((m = DESCRIPTION.exec(s))) ref(m[1] ?? "", true).body?.push((m[2] ?? "").trim());
    else if ((m = LONE.exec(s))) declare(m[1] ?? "");
    else p.errors.push({ line, code: "unknown", text: s });
  });
  return p;
}

// ---------------------------------------------------------------------------
// Entity-relationship: an attribute is `name : type PK` in the editor, `type name PK` in Mermaid
// ---------------------------------------------------------------------------

const LEFT: Readonly<Record<Cardinality, string>> = { "1": "||", "0..1": "|o", "1..*": "}|", "0..*": "}o" };
const RIGHT: Readonly<Record<Cardinality, string>> = { "1": "||", "0..1": "o|", "1..*": "|{", "0..*": "o{" };
const invert = (m: Readonly<Record<Cardinality, string>>): Record<string, Cardinality> =>
  Object.fromEntries(Object.entries(m).map(([c, sym]) => [sym, c as Cardinality]));
/* Mermaid reads a zero-or-one written either way round */
const FROM_LEFT: Readonly<Record<string, Cardinality>> = { ...invert(LEFT), "o|": "0..1" };
const FROM_RIGHT: Readonly<Record<string, Cardinality>> = { ...invert(RIGHT), "|o": "0..1" };
const erName = (s: string): string => s.trim().replace(/\s+/g, "_");
const isCardinality = (s: string | undefined): s is Cardinality => (CARDINALITIES as readonly string[]).includes(s ?? "");

export function erToText(scene: Scene): string {
  let o = "erDiagram\n";
  for (const n of scene.nodes) {
    o += `  ${erName(n.name ?? "")} {\n`;
    for (const line of n.body ?? []) {
      if (isSeparator(line)) continue;
      const m = /^\s*([^:\s]+)\s*(?::\s*([^\s]+))?\s*(.*)$/.exec(line);
      if (!m) continue;
      const keys = ((m[3] ?? "").match(/\b(PK|FK|UK)\b/g) ?? []).join(", ");
      o += `    ${m[2] ?? "string"} ${m[1] ?? ""}${keys ? ` ${keys}` : ""}\n`;
    }
    o += "  }\n";
  }
  for (const [l, a, b] of linkEnds(scene)) {
    const left = isCardinality(l.ma) ? LEFT[l.ma] : "||";
    const right = isCardinality(l.mb) ? RIGHT[l.mb] : "o{";
    o += `  ${erName(a.name ?? "")} ${left}--${right} ${erName(b.name ?? "")} : "${(l.name ?? "").replace(/"/g, "'")}"\n`;
  }
  return o;
}

const ER_NAME = String.raw`[\p{L}\w-]+`;
const ER_LINK = new RegExp(
  `^(${ER_NAME})\\s+(\\|\\||\\|o|o\\||\\}o|\\}\\|)(--|\\.\\.)(\\|\\||o\\||\\|o|o\\{|\\|\\{)\\s+(${ER_NAME})\\s*(?::\\s*(.*))?$`,
  "u",
);
const ER_BLOCK = new RegExp(`^(${ER_NAME})\\s*\\{\\s*(\\})?$`, "u");
const ER_LONE = new RegExp(`^(${ER_NAME})$`, "u");

export function parseEr(text: string): Parsed {
  const p = emptyParsed();
  const table = new NodeTable(p);
  let cur: ParsedNode | null = null;
  const lines = text.split("\n");
  const declare = (raw: string): ParsedNode => {
    const name = raw.replace(/_/g, " ");
    return table.obtain(name, () => ({ t: "entity", name, body: [] }));
  };
  lines.forEach((raw, i) => {
    const s = raw.trim();
    const line = i + 1;
    let m: RegExpExecArray | null;
    if (tooLong(p, raw, line)) return;
    if (cur) {
      if (s === "}") cur = null;
      /* the keys after `type name`, each after either a comma or spaces: one way to split them */
      else if (s && (m = /^(\S+)\s+(\S+)((?:(?:\s*,\s*|\s+)(?:PK|FK|UK))*)\s*(?:"[^"]*")?$/.exec(s))) {
        const keys = (m[3] ?? "").replace(/,/g, " ").trim().split(/\s+/).filter(Boolean).join(" ");
        cur.body?.push(`${m[2] ?? ""} : ${m[1] ?? ""}${keys ? ` ${keys}` : ""}`);
      } else if (s) p.errors.push({ line, code: "attribute", text: s });
      return;
    }
    if (!s || s.startsWith("%%") || /^erDiagram\b/.test(s) || /^direction\b/.test(s)) return;
    if ((m = ER_BLOCK.exec(s))) {
      const n = declare(m[1] ?? "");
      n.body = [];
      if (!m[2]) cur = n;
    } else if ((m = ER_LINK.exec(s))) {
      const name = unquote(m[6] ?? "");
      const ma = FROM_LEFT[m[2] ?? ""];
      const mb = FROM_RIGHT[m[4] ?? ""];
      p.links.push({
        a: declare(m[1] ?? ""),
        b: declare(m[5] ?? ""),
        type: "erel",
        ...(ma ? { ma } : {}),
        ...(mb ? { mb } : {}),
        ...(name ? { name } : {}),
      });
    } else if ((m = ER_LONE.exec(s))) declare(m[1] ?? "");
    else p.errors.push({ line, code: "unknown", text: s });
  });
  if (cur) p.errors.push({ line: lines.length, code: "unclosed", text: (cur as ParsedNode).name });
  return p;
}
