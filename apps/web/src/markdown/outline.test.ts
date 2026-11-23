import { describe, expect, it } from "vitest";

import { markdownLead, markdownTitle } from "./outline";

/*
 * The title and the lead of a text before a question (ADR-084): what names it
 * in the student's question list and sums it up in the builder's folded band.
 */

describe("markdownTitle", () => {
  it("is the first heading's text, when the text opens on one", () => {
    expect(markdownTitle("## Partie 2\n\nLes questions suivantes portent sur le code.")).toBe("Partie 2");
  });

  it("is the first heading anywhere, after a paragraph too, at any level", () => {
    expect(markdownTitle("Lisez ceci.\n\n### Consignes\n\nTexte.\n\n# Plus loin")).toBe("Consignes");
  });

  it("is null when the text has no heading", () => {
    expect(markdownTitle("Lisez les chapitres 8 et 9.\n\n- un\n- deux")).toBeNull();
    expect(markdownTitle("")).toBeNull();
  });

  it("strips emphasis, code spans, links and entities to their words", () => {
    expect(markdownTitle("## Partie **2** : _les_ `pointeurs` [en C](https://example.org) &amp; plus")).toBe(
      "Partie 2 : les pointeurs en C & plus",
    );
  });

  it("drops raw HTML in a heading: plain words, never a tag", () => {
    expect(markdownTitle("## A <img src=x onerror=alert(1)> B")).toBe("A B");
  });

  it("never takes a line inside a code fence for a heading", () => {
    expect(markdownTitle("```c\n# include <stdio.h>\n```\n\nSans titre.")).toBeNull();
    expect(markdownTitle("```sh\n# comment\n```\n\n## Le vrai titre")).toBe("Le vrai titre");
  });

  it("counts an underlined (setext) heading, which the student also reads as one", () => {
    expect(markdownTitle("Consignes\n=========\n\nTexte.")).toBe("Consignes");
  });

  it("skips an empty heading", () => {
    expect(markdownTitle("##\n\n## Suite")).toBe("Suite");
  });
});

describe("markdownLead", () => {
  it("is the first paragraph, as one line of words", () => {
    expect(
      markdownLead("## Partie 2\n\nFin de la **première** partie.\nLes questions suivantes\nportent sur le code.\n\nAutre."),
    ).toBe("Fin de la première partie. Les questions suivantes portent sur le code.");
  });

  it("skips code blocks before the prose", () => {
    expect(markdownLead("```c\nint main(void);\n```\n\nCompilez puis répondez.")).toBe("Compilez puis répondez.");
  });

  it("reads a quote or a list when they come first", () => {
    expect(markdownLead("> Retenez *bien* ceci.")).toBe("Retenez bien ceci.");
    expect(markdownLead("- un\n- deux `x`")).toBe("un deux x");
  });

  it("is empty when the text is only a heading and code", () => {
    expect(markdownLead("## Code\n\n```c\nint x;\n```")).toBe("");
  });
});
