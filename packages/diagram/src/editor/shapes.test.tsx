/**
 * The screen and the paper share one geometry (ADR-126 §1): what the editor
 * draws of an element or a link is, element for element, what `paint.ts`
 * paints, the printed figure's source.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EXAMPLES } from "../examples.js";
import { estimateText } from "../geometry.js";
import { DIAGRAM_KINDS } from "../kinds.js";
import { layout } from "../layout.js";
import { paintLink, paintNode, type Prim } from "../paint.js";
import { LinkShape, NodeShape } from "./shapes.js";

/** Character data back from its markup. */
const unescape = (text: string): string =>
  text.replace(/&#x([0-9a-f]+);|&(amp|lt|gt|quot);/gi, (_, hex: string | undefined, name: string | undefined) =>
    hex !== undefined ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: "&", lt: "<", gt: ">", quot: '"' } as Record<string, string>)[name!]!,
  );

/** The drawn elements of a markup, as `<tag>` or `<text>content`, the group left out. */
const drawn = (markup: string): string[] =>
  [...markup.matchAll(/<(path|rect|ellipse|circle|text)\b[^>]*>(?:([^<]*)<\/text>)?/g)].map(([, tag, text]) =>
    tag === "text" ? `text:${unescape(text ?? "")}` : tag!,
  );

const painted = (prims: readonly Prim[]): string[] => prims.map((p) => (p.el === "text" ? `text:${p.text}` : p.el));

describe("the editor draws what paint.ts paints", () => {
  it.each(DIAGRAM_KINDS)("for every element and link of the %s example", (kind) => {
    const scene = EXAMPLES[kind];
    for (const n of scene.nodes) {
      const markup = renderToStaticMarkup(<NodeShape node={n} measure={estimateText} />);
      expect(drawn(markup)).toEqual(painted(paintNode(n, estimateText)));
    }
    const lay = layout(scene, kind, estimateText);
    for (const l of scene.links) {
      const route = lay.routes.get(l.id)!;
      expect(drawn(renderToStaticMarkup(<LinkShape link={l} route={route} />))).toEqual(painted(paintLink(l, route)));
    }
  });
});
