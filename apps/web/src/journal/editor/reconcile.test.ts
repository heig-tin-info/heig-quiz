import { describe, expect, it } from "vitest";

import { reconciler, splitBlocks } from "./reconcile";

/*
 * The reconciliation alone, with a stand-in for the editor's spelling: this
 * one writes `_x_` as `*x*` and re-pads nothing else, which is enough to
 * tell a block that was only RESPELLED from one that was edited. The real
 * spelling is exercised by roundtrip.test.ts.
 */
const spell = (block: string) => block.replace(/_([^_]+)_/g, "*$1*").trim();

describe("splitBlocks", () => {
  it("cuts a page into its blocks, and the blank lines between them add back up", () => {
    const source = "\n# Title\n\nA _para_.\n\n\n- a\n- b\n";
    const blocks = splitBlocks(source)!;
    expect(blocks.blocks).toEqual(["# Title", "A _para_.", "- a\n- b"]);
    expect(blocks.kinds).toEqual(["heading", "paragraph", "list"]);
    expect(blocks.lead).toBe("\n");
    expect(blocks.seps).toEqual(["\n\n", "\n\n\n"]);
    expect(blocks.trail).toBe("\n");
  });

  it("knows an empty page", () => {
    expect(splitBlocks("")).toEqual({ lead: "", blocks: [], kinds: [], seps: [], trail: "" });
  });
});

describe("reconciler", () => {
  const source = "# Title\n\nA _para_.\n\n\nAnother _one_.\n";

  it("gives the source back when the editor only respelled it", () => {
    expect(reconciler(source)("# Title\n\nA *para*.\n\nAnother *one*.", spell)).toBe(source);
  });

  it("writes the edited block as the editor does, and the others as read", () => {
    expect(reconciler(source)("# Title\n\nA *para*, edited.\n\nAnother *one*.", spell)).toBe(
      "# Title\n\nA *para*, edited.\n\nAnother _one_.\n",
    );
  });

  it("drops a deleted block and keeps the blank lines of neighbours that still touch", () => {
    expect(reconciler(source)("# Title\n\nAnother *one*.", spell)).toBe("# Title\n\nAnother _one_.\n");
  });

  it("puts an added block between two read ones with one blank line", () => {
    expect(reconciler(source)("# Title\n\nNew.\n\nA *para*.\n\nAnother *one*.", spell)).toBe(
      "# Title\n\nNew.\n\nA _para_.\n\n\nAnother _one_.\n",
    );
  });

  it("keeps a block that has no spelling (a link definition) after the block it followed", () => {
    const withDef = "See [x][r].\n\n[r]: https://x.ch\n\nEnd.\n";
    const defs = (block: string) => (/^\[r\]:/.test(block) ? "" : block.split("\n\n")[0]!.trim());
    expect(reconciler(withDef)("See [x][r].\n\nEnd, edited.", defs)).toBe(
      "See [x][r].\n\n[r]: https://x.ch\n\nEnd, edited.\n",
    );
  });

  it("writes a block the editor failed to spell as edited, without losing it", () => {
    const boom = (block: string) => {
      if (block.startsWith("A")) throw new Error("no");
      return block;
    };
    expect(reconciler("A.\n\nB.\n")("A.\n\nB.", boom)).toBe("A.\n\nB.\n");
  });
});
