/**
 * Graphviz DOT, for the automaton and the graph: the classic text of both.
 * An automaton's initial state is the target of an edge from a
 * point-shaped node (`__start [shape=point]`), the usual convention; an
 * accepting state is a `doublecircle`. A graph that mixes edges and arcs is
 * a `digraph` whose edges carry `dir=none`.
 */
import type { Scene } from "../scene.js";
import { NodeTable, emptyParsed, linkEnds, quote, tooLong, unquote, type Parsed } from "./parsed.js";

export function dotToText(scene: Scene, kind: "automaton" | "graph"): string {
  const automaton = kind === "automaton";
  const directed = automaton || scene.links.some((l) => l.type === "arc");
  const op = directed ? "->" : "--";
  let o = `${directed ? "digraph" : "graph"} {\n`;
  if (automaton) o += "  rankdir=LR\n  node [shape=circle]\n";
  for (const n of scene.nodes) o += `  ${quote(n.name ?? "")}${automaton && n.accept ? " [shape=doublecircle]" : ""}\n`;
  const starts = automaton ? scene.nodes.filter((n) => n.initial) : [];
  if (starts.length > 0) o += `  __start [shape=point]\n${starts.map((n) => `  __start -> ${quote(n.name ?? "")}\n`).join("")}`;
  for (const [l, a, b] of linkEnds(scene)) {
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

/** A line cut at its semicolons, those outside quotes: one pass. */
/* Both passes below read the whole text in one scan and keep its newlines, so a
   line number still names the line typed: a regular expression for either was
   quadratic on a pasted run of blank lines or of unclosed comments (ADR-046 review). */
function stripBlockComments(text: string): string {
  let out = "";
  for (let i = 0; ; ) {
    const open = text.indexOf("/*", i);
    if (open < 0) return out + text.slice(i);
    const close = text.indexOf("*/", open + 2);
    if (close < 0) return out + text.slice(open);
    out += text.slice(i, open) + text.slice(open, close + 2).replace(/[^\n]/g, "");
    i = close + 2;
  }
}

/** The `[strict] [di]graph name {` header, at the start of a line before the first brace, becomes a break. */
function cutHeader(text: string): string {
  const brace = text.indexOf("{");
  if (brace < 0) return text;
  const m = /(^|\n)[ \t\r]*(?:strict[ \t\r\n]+)?(?:di)?graph\b/i.exec(text.slice(0, brace));
  if (!m) return text;
  const start = m.index + (m[1] ?? "").length;
  return text.slice(0, start) + ";" + text.slice(start, brace + 1).replace(/[^\n]/g, "") + text.slice(brace + 1);
}

function statementsOf(line: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ";" && !quoted) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out;
}

function attributes(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (s ?? "").matchAll(/(\w+)\s*=\s*("[^"]*"|[^,;\s\]]+)/g)) out[(m[1] ?? "").toLowerCase()] = unquote(m[2] ?? "");
  return out;
}

export function parseDot(text: string, kind: "automaton" | "graph"): Parsed {
  const p = emptyParsed();
  const automaton = kind === "automaton";
  const table = new NodeTable(p);
  const pseudo = new Set<string>();
  const declare = (name: string) => table.obtain(name, () => ({ t: automaton ? "astate" : "vertex", name, ...(automaton ? { accept: false, initial: false } : {}) }));

  /* statements: split on newlines and on semicolons outside quotes */
  const statements: Array<{ s: string; line: number }> = [];
  /* the header and the braces are statement breaks, so a graph may sit on one line */
  cutHeader(stripBlockComments(text))
    .replace(/[{}]/g, ";")
    .split("\n")
    .forEach((raw, i) => {
      if (tooLong(p, raw, i + 1)) return;
      for (const part of statementsOf(raw.replace(/(^|\s)(\/\/|#).*$/, ""))) {
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
