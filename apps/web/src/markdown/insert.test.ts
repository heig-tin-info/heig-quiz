import { describe, expect, it } from "vitest";

import { indent, INDENT, insertBlock, replace, wrap, type Selection } from "./insert";

/*
 * Where the caret lands is the whole value of a markdown toolbar. The syntax
 * it types would be faster to write by hand; what it saves is the two seconds
 * of looking for the place to type next.
 *
 * `sel("a[bc]d")` reads the selection out of the string: brackets mark it,
 * an empty pair marks a caret. `show` writes it back the same way.
 */
function sel(marked: string): Selection {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace(/[[\]]/g, ""), start, end };
}

function show(s: Selection): string {
  return `${s.value.slice(0, s.start)}[${s.value.slice(s.start, s.end)}]${s.value.slice(s.end)}`;
}

describe("wrap", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(show(wrap(sel("Soit [p] un pointeur"), "**"))).toBe("Soit **[p]** un pointeur");
  });

  it("inserts a placeholder and selects it when nothing is selected", () => {
    expect(show(wrap(sel("Soit []"), "*", "*", "italic text"))).toBe("Soit *[italic text]*");
  });

  it("unwraps a second time, delimiters outside the selection", () => {
    expect(show(wrap(sel("Soit **[p]** un pointeur"), "**"))).toBe("Soit [p] un pointeur");
  });

  it("unwraps when the delimiters are inside the selection", () => {
    expect(show(wrap(sel("Soit [**p**] un pointeur"), "**"))).toBe("Soit [p] un pointeur");
  });

  it("takes different opening and closing delimiters", () => {
    expect(show(wrap(sel("[x]"), "$", "$"))).toBe("$[x]$");
  });

  it("italic inside a bold run nests instead of unwrapping the bold", () => {
    expect(show(wrap(sel("**[abc]**"), "*"))).toBe("***[abc]***");
    expect(show(wrap(sel("[**abc**]"), "*"))).toBe("*[**abc**]*");
  });
});

describe("replace", () => {
  it("swaps the selection and leaves the caret after it", () => {
    expect(show(replace(sel("a[bc]d"), "XYZ"))).toBe("aXYZ[]d");
  });
});

describe("insertBlock", () => {
  it("surrounds the block with the blank lines markdown needs", () => {
    expect(insertBlock(sel("Text[]"), "```c\ncode\n```").value).toBe("Text\n\n```c\ncode\n```");
  });

  it("does not stack blank lines that are already there", () => {
    expect(insertBlock(sel("Text\n\n[]"), "![](asset:a1)").value).toBe("Text\n\n![](asset:a1)");
  });

  it("inserts at the very start without a leading gap", () => {
    expect(insertBlock(sel("[]rest"), "X").value).toBe("X\n\nrest");
  });

  it("selects the fragment it was asked to select", () => {
    expect(show(insertBlock(sel("[]"), "```c\ncode\n```", "code"))).toBe("```c\n[code]\n```");
  });
});

describe("indent", () => {
  it("is two spaces at a caret, never a tab character", () => {
    expect(show(indent(sel("ab[]cd")))).toBe(`ab${INDENT}[]cd`);
    expect(indent(sel("[]")).value).not.toContain("\t");
  });

  it("indents every line a selection touches", () => {
    const out = indent(sel("- a\n- [b\n- c]\n- d"));
    expect(out.value).toBe("- a\n  - b\n  - c\n- d");
  });

  it("outdents by at most two spaces per line", () => {
    const out = indent(sel("- a\n    - [b\n - c]"), true);
    expect(out.value).toBe("- a\n  - b\n- c");
  });

  it("outdenting a line with no indent leaves it alone", () => {
    expect(indent(sel("[- a]"), true).value).toBe("- a");
  });
});
