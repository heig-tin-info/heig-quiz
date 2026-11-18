/**
 * The strict SVG check of a question's image (ADR-134): what it accepts as
 * is, and the first offending thing it names, by its closed code, when it
 * refuses.
 */
import { describe, expect, it } from "vitest";

import { SVG_FIXTURES } from "../../test/svg.js";
import { checkSvg, looksLikeMarkup, SVG_MAX_BYTES, SVG_MAX_DEPTH } from "./svgCheck.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (body: string, attrs = 'viewBox="0 0 100 50"') => Buffer.from(`<svg ${NS} ${attrs}>${body}</svg>`);
/** The refusal's code, name and message, or null when accepted. */
const refusal = (bytes: Buffer) => {
  const verdict = checkSvg(bytes);
  return verdict.ok ? null : verdict;
};

describe("checkSvg accepts a drawing", () => {
  it.each(SVG_FIXTURES)("accepts $name", ({ bytes }) => {
    expect(checkSvg(bytes)).toEqual({ ok: true });
  });

  it("accepts the declaration, styles, markers, gradients, colour and transform functions, and local references", () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<svg ${NS} ${XLINK} version="1.1" width="200" height="100" viewBox="0 0 400 200">
  <style type="text/css"><![CDATA[ .edge { stroke: rgb(34, 34, 34); marker-end: url(#arrow); } ]]></style>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7"/></marker>
    <linearGradient id="g" gradientTransform="rotate(90)"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="hsl(0, 0%, 80%)"/></linearGradient>
    <symbol id="box"><rect width="40" height="20" rx="3" fill="url(#g)"/></symbol>
    <path id="curve" d="M10 80 Q 95 10 180 80"/>
  </defs>
  <use href="#box" x="10" y="10"/><use xlink:href="#box" x="100" y="10" transform="translate(5, 5) scale(1.2)"/>
  <line class="edge" x1="50" y1="20" x2="50" y2="20" style="stroke-width: calc(2px + 1px)"/>
  <text font-size="12"><textPath href="#curve" startOffset="10">a <tspan dy="2">b</tspan></textPath></text>
</svg>`;
    expect(checkSvg(Buffer.from(source))).toEqual({ ok: true });
  });
});

describe("checkSvg refuses, naming the first offending thing", () => {
  it.each([
    ["a script", svg("<script>alert(1)</script>"), "element", "script"],
    ["an event handler", svg("", 'onload="alert(1)"'), "attribute", "onload"],
    ["foreignObject", svg("<foreignObject><div/></foreignObject>"), "element", "foreignObject"],
    ["an HTML element", svg('<div xmlns="http://www.w3.org/1999/xhtml"/>'), "namespace", "http://www.w3.org/1999/xhtml"],
    ["an external href", svg('<use href="https://evil.example/x.svg#a"/>'), "href", "href"],
    ["a javascript: href", svg('<use href="javascript:alert(1)"/>'), "href", "href"],
    ["another file's fragment", svg('<use href="other.svg#x"/>'), "href", "href"],
    ["an image with a data: href", svg('<image xlink:href="data:image/png;base64,AAAA"/>', XLINK), "element", "image"],
    ["a data: href on use", svg('<use href="data:image/svg+xml,&lt;svg/&gt;"/>'), "href", "href"],
    ["an a element", svg('<a href="#x"><rect/></a>'), "element", "a"],
    ["a filter", svg("<filter id='f'><feGaussianBlur/></filter>"), "element", "filter"],
    ["an animation", svg("<rect><set attributeName='x' to='1'/></rect>"), "element", "set"],
    ["a DOCTYPE", Buffer.from(`<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}/>`), "doctype", undefined],
    ["an undeclared entity", svg("<text>&xxe;</text>"), "malformed", undefined],
    ["a comment", svg("<!-- answer: 42 --><rect/>"), "comment", undefined],
    ["a title", svg("<title>The answer is B</title>"), "element", "title"],
    ["a desc", svg("<desc>hint</desc>"), "element", "desc"],
    ["metadata", svg("<metadata>x</metadata>"), "element", "metadata"],
    ["a processing instruction", svg("<?php echo 1 ?><rect/>"), "instruction", "php"],
    ["CDATA outside a stylesheet", svg("<text><![CDATA[x]]></text>"), "cdata", undefined],
    ["text outside a text element", svg("<g>the answer</g>"), "text", "g"],
    ["an element inside a stylesheet", svg("<style><rect/></style>"), "element", "rect"],
    ["an inkscape namespace", svg('<g inkscape:label="layer"/>', 'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"'), "attribute", "xmlns:inkscape"],
    ["an unknown attribute", svg('<rect requiredExtensions="x"/>'), "attribute", "requiredExtensions"],
    ["a remote url() in a stylesheet", svg("<style>rect { fill: url(http://evil.example/p.svg#a) }</style>"), "url", undefined],
    ["an @import", svg("<style>@import 'http://evil.example/x.css';</style>"), "css", "@import"],
    ["a CSS comment", svg("<style>rect { fill: red } /* answer: B */</style>"), "css", "/*"],
    ["a CSS comment in style=", svg('<rect style="fill: red /* B */"/>'), "css", "/*"],
    ["a remote url() in style=", svg('<rect style="fill: url(https://evil.example/a)"/>'), "url", undefined],
    ["a remote url() in fill", svg('<rect fill="url(https://evil.example/a#b)"/>'), "url", undefined],
    ["a CSS escape", svg("<style>rect { fill: \\75 rl(x) }</style>"), "escape", "<style>"],
    ["a function off the list in style=", svg('<rect style="width: expression(alert(1))"/>'), "function", "expression"],
    ["image() in a stylesheet", svg("<style>rect { fill: image('x.png') }</style>"), "function", "image"],
    ["cross-fade() in fill", svg('<rect fill="cross-fade(#a, #b)"/>'), "function", "cross-fade"],
    ["image-set() in a stylesheet", svg('<style>rect { fill: image-set("x.png" 1x) }</style>'), "function", "image-set"],
    ["a root that is not svg", Buffer.from(`<html ${NS}/>`), "not_svg", "html"],
    ["no namespace", Buffer.from("<svg/>"), "not_svg", "svg"],
    ["malformed XML", Buffer.from(`<svg ${NS}><rect></svg>`), "malformed", undefined],
    ["a stylesheet of another type", svg('<style type="text/javascript">x</style>'), "attribute", 'type="text/javascript"'],
  ])("refuses %s", (_label, bytes, code, name) => {
    const verdict = refusal(bytes);
    expect(verdict).toMatchObject({ code });
    expect(verdict?.name).toBe(name);
    expect(verdict?.message).toBeTruthy();
  });

  it("checks a stylesheet whole, however its text is cut by CDATA sections", () => {
    expect(refusal(svg('<style>@im<![CDATA[port "https://evil.example/x.css";]]></style>'))).toMatchObject({
      code: "css",
      name: "@import",
    });
    expect(refusal(svg("<style>rect{fill:ur<![CDATA[l(https://evil.example/p.svg#a)}]]></style>"))).toMatchObject({
      code: "url",
    });
    expect(refusal(svg("<style><![CDATA[rect{fill:ur]]><![CDATA[l(https://evil.example/p.svg#a)}]]></style>"))).toMatchObject({
      code: "url",
    });
    expect(checkSvg(svg("<style><![CDATA[rect{fill:]]><![CDATA[url(#g)}]]></style>"))).toEqual({ ok: true });
  });

  it("refuses a backslash in any attribute value, entity-encoded or not", () => {
    expect(refusal(svg('<rect fill="\\75 rl(https://evil.example/p.svg#a)"/>'))).toMatchObject({ code: "escape", name: "fill" });
    expect(refusal(svg('<rect fill="&#x5C;75rl(https://e/x#a)"/>'))).toMatchObject({ code: "escape", name: "fill" });
  });

  it("lets a <use> repeat a plain drawing, never one that holds or is a <use>", () => {
    expect(checkSvg(svg('<rect id="r" width="1" height="1"/><use href="#r"/><use href="#r" x="2"/>'))).toEqual({ ok: true });
    const chain = svg(
      '<defs><rect id="a" width="1" height="1"/>' +
        '<g id="b"><use href="#a"/><use href="#a" x="1"/></g>' +
        '<g id="c"><use href="#b"/><use href="#b" y="1"/></g></defs><use href="#c"/>',
    );
    expect(refusal(chain)).toMatchObject({ code: "use_chain", name: "b" });
    expect(refusal(svg('<rect id="r"/><use id="u" href="#r"/><use href="#u"/>'))).toMatchObject({ code: "use_chain", name: "u" });
    // Before its target is defined, too: the check runs once the whole SVG is read.
    expect(refusal(svg('<use href="#late"/><g id="late"><use href="#x"/></g><rect id="x"/>'))).toMatchObject({
      code: "use_chain",
    });
  });

  it("refuses an SVG over the size cap", () => {
    const big = svg(`<rect width="1" height="1"/>`.repeat(Math.ceil(SVG_MAX_BYTES / 25)));
    expect(big.length).toBeGreaterThan(SVG_MAX_BYTES);
    expect(refusal(big)).toMatchObject({ code: "too_large" });
  });

  it("refuses too deep a nesting", () => {
    expect(refusal(svg("<g>".repeat(SVG_MAX_DEPTH) + "</g>".repeat(SVG_MAX_DEPTH)))).toMatchObject({ code: "too_deep" });
  });

  it("refuses bytes that are not UTF-8, and a declared encoding other than UTF-8", () => {
    const latin = Buffer.concat([Buffer.from(`<svg ${NS}><text>`), Buffer.from([0xff, 0xfe]), Buffer.from("</text></svg>")]);
    expect(refusal(latin)).toMatchObject({ code: "encoding" });
    expect(refusal(Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><svg ${NS}/>`))).toMatchObject({
      code: "encoding",
      name: "ISO-8859-1",
    });
  });
});

describe("looksLikeMarkup", () => {
  it("tells markup from anything else", () => {
    expect(looksLikeMarkup(Buffer.from("﻿  \n<svg/>"))).toBe(true);
    expect(looksLikeMarkup(Buffer.from("not an image"))).toBe(false);
  });
});
