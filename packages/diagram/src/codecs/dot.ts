/**
 * Graphviz DOT, for the automaton and the graph: the classic text of both.
 * An automaton's initial state is the target of an edge from a
 * point-shaped node (`__start [shape=point]`), the usual convention; an
 * accepting state is a `doublecircle`. A graph that mixes edges and arcs is
 * a `digraph` whose edges carry `dir=none`.
 */
import type { Scene } from "../scene.js";
import { emptyParsed, isIdentifier, unquote, type Parsed, type ParsedNode } from "./parsed.js";

const quote = (s: string): string => (isIdentifier(s) ? s : `"${s.replace(/"/g, "'")}"`);

export function dotToText(scene: Scene, kind: "automaton" | "graph"): string {
  const automaton = kind === "automaton";
  const byId = new Map(scene.nodes.map((n) => [n.id, n] as const));
  const directed = automaton || scene.links.some((l) => l.type === "arc");
  const op = directed ? "->" : "--";
  let o = `${directed ? "digraph" : "graph"} {\n`;
  if (automaton) o += "  rankdir=LR\n  node [shape=circle]\n";
  for (const n of scene.nodes) o += `  ${quote(n.name ?? "")}${automaton && n.accept ? " [shape=doublecircle]" : ""}\n`;
  const starts = automaton ? scene.nodes.filter((n) => n.initial) : [];
  if (starts.length > 0) o += `  __start [shape=point]\n${starts.map((n) => `  __start -> ${quote(n.name ?? "")}\n`).join("")}`;
  for (const l of scene.links) {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (!a || !b) continue;
    const attrs: string[] = [];
    if (l.name) attrs.push(`label="${l.name.replace(/"/g, "'")}"`);
    if (directed && l.type === "edge") attrs.push("dir=none");
    o += `  ${quote(a.name ?? "")} ${op} ${quote(b.name ?? "")}${attrs.length > 0 ? ` [${attrs.join(", ")}]` : ""}\n`;
  }
  return `${o}}\n`;
}

const ID = String.raw`"[^"]*"|[\p{L}\w.]+`;
const EDGE_RE = new RegExp(`^(${ID})((?:\\s*(?:->|--)\\s*(?:${ID}))+)\\s*(?:\\[(.*)\\])?$`, "u");
const HOP_RE = new RegExp(`\\s*(->|--)\\s*(${ID})`, "gu");
const NODE_RE = new RegExp(`^(${ID})\\s*(?:\\[(.*)\\])?$`, "u");

function attributes(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (s ?? "").matchAll(/(\w+)\s*=\s*("[^"]*"|[^,;\s\]]+)/g)) out[(m[1] ?? "").toLowerCase()] = unquote(m[2] ?? "");
  return out;
}

export function parseDot(text: string, kind: "automaton" | "graph"): Parsed {
  const p = emptyParsed();
  const automaton = kind === "automaton";
  const keys = new Map<string, ParsedNode>();
  const pseudo = new Set<string>();
  const declare = (name: string): ParsedNode => {
    let n = keys.get(name);
    if (!n) {
      n = { t: automaton ? "astate" : "vertex", name, ...(automaton ? { accept: false, initial: false } : {}) };
      keys.set(name, n);
      p.nodes.push(n);
    }
    return n;
  };

  /* statements: split on newlines and on semicolons outside quotes */
  const statements: Array<{ s: string; line: number }> = [];
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    /* the header and the braces are statement breaks, so a graph may sit on one line */
    .replace(/^\s*(strict\s+)?(di)?graph\b[^{]*\{/im, ";")
    .replace(/[{}]/g, ";")
    .split("\n")
    .forEach((raw, i) => {
      for (const part of raw.replace(/(^|\s)(\/\/|#).*$/, "").split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
        const s = part.trim();
        if (s && !/^\w+\s*=/.test(s)) statements.push({ s, line: i + 1 });
      }
    });

  /* the nodes first, so that a point-shaped start is known before its edge */
  let defaultShape = "";
  const edges: Array<{ s: string; line: number }> = [];
  for (const { s, line } of statements) {
    let m: RegExpExecArray | null;
    if ((m = /^(node|edge|graph)\s*\[(.*)\]$/i.exec(s))) {
      if ((m[1] ?? "").toLowerCase() === "node") defaultShape = attributes(m[2]).shape ?? defaultShape;
    } else if (EDGE_RE.test(s)) edges.push({ s, line });
    else if ((m = NODE_RE.exec(s))) {
      const name = unquote(m[1] ?? "");
      const shape = attributes(m[2]).shape ?? defaultShape;
      if (automaton && /^(point|none|plaintext)$/.test(shape)) pseudo.add(name);
      else {
        const n = declare(name);
        if (automaton) n.accept = shape === "doublecircle";
      }
    } else p.errors.push({ line, code: "unknown", text: s });
  }

  for (const { s, line } of edges) {
    const m = EDGE_RE.exec(s);
    if (!m) continue;
    const attrs = attributes(m[3]);
    let prev = unquote(m[1] ?? "");
    for (const hop of (m[2] ?? "").matchAll(HOP_RE)) {
      const op = hop[1] ?? "";
      const next = unquote(hop[2] ?? "");
      if (pseudo.has(prev)) declare(next).initial = true;
      else if (automaton && op === "--") {
        p.errors.push({ line, code: "directed", text: op });
        return p;
      } else {
        const name = attrs.label ?? attrs.weight ?? "";
        const type = automaton ? "trans" : op === "--" || attrs.dir === "none" ? "edge" : "arc";
        p.links.push({ a: declare(prev), b: declare(next), type, ...(name ? { name } : {}) });
      }
      prev = next;
    }
  }
  return p;
}
