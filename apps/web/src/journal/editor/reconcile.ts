/*
 * Every block the teacher did not touch, written back as it was read
 * (D25, condition 1).
 *
 * The rich editor serializes the WHOLE document, in its own spelling: a
 * table re-padded, an entity decoded, an emphasis spelled its way. Edit one
 * word of a page and the commit would rewrite every paragraph whose spelling
 * differs — the noisy diff D25 was written against. So the markdown the
 * editor emits is reconciled with the markdown it was opened on, block by
 * block:
 *
 *  - the source is cut into its top-level blocks (marked's lexer, the
 *    renderer's own), and each block is put through the editor alone, which
 *    gives the spelling the editor WOULD write for it unedited;
 *  - the editor's output is cut the same way, and matched against those
 *    spellings in order (a longest common subsequence: a block moved or
 *    deleted does not unmatch the others);
 *  - a matched block is written as it was READ, an unmatched one (the block
 *    the teacher edited, or added) as the editor writes it; the blank lines
 *    between two blocks that were neighbours are theirs, anything else is one
 *    blank line; the text before the first block and after the last is the
 *    source's.
 *
 * A block the editor cannot represent at all (a link reference definition,
 * which it folds into the links that use it) has no spelling to match: it is
 * kept, after the block it followed. Nothing is ever dropped that the
 * teacher did not delete.
 *
 * Pure: the editor's spelling comes in as a function, which the hook builds
 * from the live editor's markdown manager and the test from a headless one.
 */
import { Lexer } from "marked";

import type { Reconcile } from "../../markdown/useRichTextEditor";

/** A document cut into its top-level blocks, with what lies between them. */
export interface Blocks {
  /** The text before the first block (blank lines). */
  lead: string;
  /** Each block's source, without its trailing newlines. */
  blocks: string[];
  /** Each block's token type (`paragraph`, `def`, …). */
  kinds: string[];
  /** `seps[i]` lies between `blocks[i]` and `blocks[i + 1]`. */
  seps: string[];
  /** The text after the last block (the file's final newline). */
  trail: string;
}

/**
 * The top-level blocks of `markdown`, or null when marked's tokens do not add
 * up to the source exactly (a shape this module would rather not guess at).
 */
export function splitBlocks(markdown: string): Blocks | null {
  let tokens;
  try {
    tokens = new Lexer({ gfm: true }).lex(markdown);
  } catch {
    return null;
  }
  const blocks: string[] = [];
  const kinds: string[] = [];
  const gaps: string[] = [""];
  for (const token of tokens) {
    if (token.type === "space") {
      gaps[gaps.length - 1] += token.raw;
      continue;
    }
    const raw = token.raw;
    const body = raw.replace(/\n+$/, "");
    blocks.push(body);
    kinds.push(token.type);
    gaps.push(raw.slice(body.length));
  }
  const rebuilt = gaps[0] + blocks.map((b, i) => b + gaps[i + 1]).join("");
  if (rebuilt !== markdown) return null;
  return { lead: gaps[0]!, blocks, kinds, seps: gaps.slice(1, -1), trail: gaps[gaps.length - 1]! };
}

/** Pairs `[i, j]` of a longest common subsequence of `a` and `b`, in order. */
function commonSubsequence(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * A reconciler for one opened page: `(edited, spell) => markdown`, where
 * `edited` is the editor's whole output and the result keeps every unedited
 * block of `source` verbatim. `spell(block)` is how the editor writes one
 * block of source when nothing is edited. Without blocks to work with (a
 * source or an output marked cannot cut exactly) the editor's output is
 * returned as it is.
 */
export function reconciler(source: string): Reconcile {
  const original = splitBlocks(source);
  let spellings: string[] | null = null;
  return (edited, spell) => {
    const out = splitBlocks(edited.trim());
    if (original === null || out === null) return edited;
    // Spelled on first use, once: a page opened and never edited costs nothing.
    // A block is spelled with the page's link definitions after it, which
    // spell to nothing, so that `[text][ref]` reads as the link it is.
    const isDefinition = (i: number) => original.kinds[i] === "def";
    const definitions = original.blocks.filter((_, i) => isDefinition(i)).join("\n");
    spellings ??= original.blocks.map((block, i) => {
      if (isDefinition(i)) return "";
      try {
        return spell(definitions ? `${block}\n\n${definitions}` : block).trim();
      } catch {
        // A block the editor cannot spell matches nothing: written as edited.
        return `\u0000${i}`;
      }
    });
    const spelled = spellings;
    const pairs = commonSubsequence(spelled, out.blocks);
    const sourceOf = new Map(pairs.map(([i, j]) => [j, i]));

    // A block with no spelling (a link definition) stays after the block that
    // preceded it in the source, wherever that block went: after its matched
    // block, or after the edited blocks that came out of the ones between.
    const invisible = (i: number) => spelled[i] === "";
    const outOf = new Map(pairs);
    /** Output index each kept definition goes after (-1: before everything). */
    const keptAfter = new Map<number, number[]>();
    for (let d = 0; d < original.blocks.length; d += 1) {
      if (!invisible(d)) continue;
      let anchor = d - 1;
      while (anchor >= 0 && !outOf.has(anchor)) anchor -= 1;
      let next = d + 1;
      while (next < original.blocks.length && !outOf.has(next)) next += 1;
      // The edited blocks between the anchor and the definition, in order.
      let edited = 0;
      for (let i = anchor + 1; i < d; i += 1) if (!invisible(i)) edited += 1;
      const from = anchor === -1 ? -1 : outOf.get(anchor)!;
      const limit = next < original.blocks.length ? outOf.get(next)! : out.blocks.length;
      const slot = Math.min(from + edited, limit - 1);
      keptAfter.set(slot, [...(keptAfter.get(slot) ?? []), d]);
    }

    /** Each piece: its text, and the source block it is, when it is one. */
    const pieces: Array<{ text: string; from: number | null }> = [];
    const keep = (slot: number) => {
      for (const d of keptAfter.get(slot) ?? []) pieces.push({ text: original.blocks[d]!, from: d });
    };
    keep(-1);
    out.blocks.forEach((block, j) => {
      const i = sourceOf.get(j);
      pieces.push({ text: i === undefined ? block : original.blocks[i]!, from: i ?? null });
      keep(j);
    });

    let result = original.lead;
    pieces.forEach((piece, k) => {
      if (k > 0) {
        const before = pieces[k - 1]!.from;
        result += before !== null && piece.from === before + 1 ? original.seps[before]! : "\n\n";
      }
      result += piece.text;
    });
    return result + (pieces.length === 0 ? "" : original.trail);
  };
}
