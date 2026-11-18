/**
 * The strict SVG check of a question's image (ADR-134): what it accepts as
 * is, and the first offending thing it names when it refuses.
 */
import { describe, expect, it } from "vitest";

import { SVG_FIXTURES } from "../../test/svg.js";
import { checkSvg, looksLikeMarkup, SVG_MAX_BYTES, SVG_MAX_DEPTH, SVG_MAX_ELEMENTS } from "./svgCheck.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string, attrs = 'viewBox="0 0 100 50"') => Buffer.from(`<svg ${NS} ${attrs}>${body}</svg>`);
const reason = (bytes: Buffer) => {
  const verdict = checkSvg(bytes);
  return verdict.ok ? null : verdict.reason;
};

describe("checkSvg accepts a drawing", () => {
  it.each(SVG_FIXTURES)("accepts $name with its size", ({ bytes }) => {
    const verdict = checkSvg(bytes);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.width).toBeGreaterThan(0);
  });

  it("accepts the declaration, styles, markers, gradients and local references", () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="200" height="100" viewBox="0 0 400 200">
  <style type="text/css"><![CDATA[ .edge { stroke: #222; marker-end: url(#arrow); } ]]></style>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7"/></marker>
    <linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#ccc"/></linearGradient>
    <symbol id="box"><rect width="40" height="20" rx="3" fill="url(#g)"/></symbol>
    <path id="curve" d="M10 80 Q 95 10 180 80"/>
  </defs>
  <use href="#box" x="10" y="10"/><use xlink:href="#box" x="100" y="10"/>
  <line class="edge" x1="50" y1="20" x2="100" y2="20" style="stroke-width: 2"/>
  <text font-size="12"><textPath href="#curve" startOffset="10">a <tspan dy="2">b</tspan></textPath></text>
</svg>`;
    expect(checkSvg(Buffer.from(source))).toEqual({ ok: true, width: 200, height: 100 });
  });

  it("takes its size from the viewBox when the root gives none in pixels", () => {
    expect(checkSvg(svg(""))).toEqual({ ok: true, width: 100, height: 50 });
    expect(checkSvg(svg("", 'width="10cm" viewBox="0 0 300 150"'))).toEqual({ ok: true, width: 300, height: 150 });
    expect(checkSvg(svg("", ""))).toEqual({ ok: true, width: null, height: null });
  });
});

describe("checkSvg refuses, naming the first offending thing", () => {
  it.each([
    ["a script", svg("<script>alert(1)</script>"), "element <script>"],
    ["an event handler", svg("", 'onload="alert(1)"'), "event handler attribute onload on <svg>"],
    ["foreignObject", svg("<foreignObject><div/></foreignObject>"), "element <foreignObject>"],
    ["an HTML element", svg('<div xmlns="http://www.w3.org/1999/xhtml"/>'), "outside the SVG namespace"],
    ["an external href", svg('<use href="https://evil.example/x.svg#a"/>'), "href on <use> is not a same-document #id reference"],
    ["a javascript: href", svg('<use href="javascript:alert(1)"/>'), "href on <use>"],
    ["another file's fragment", svg('<use href="other.svg#x"/>'), "href on <use>"],
    [
      "an xlink:href to a data: image",
      svg('<image xlink:href="data:image/png;base64,AAAA"/>', `xmlns:xlink="http://www.w3.org/1999/xlink"`),
      "element <image>",
    ],
    ["a data: href on use", svg('<use href="data:image/svg+xml,&lt;svg/&gt;"/>'), "href on <use>"],
    ["an a element", svg('<a href="#x"><rect/></a>'), "element <a>"],
    ["a filter", svg("<filter id='f'><feGaussianBlur/></filter>"), "element <filter>"],
    ["an animation", svg("<rect><set attributeName='x' to='1'/></rect>"), "element <set>"],
    ["a DOCTYPE", Buffer.from(`<!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}/>`), "a DOCTYPE"],
    ["an undeclared entity", svg("<text>&xxe;</text>"), "not well-formed XML"],
    ["a comment", svg("<!-- answer: 42 --><rect/>"), "an XML comment"],
    ["a title", svg("<title>The answer is B</title>"), "element <title>"],
    ["a desc", svg("<desc>hint</desc>"), "element <desc>"],
    ["metadata", svg("<metadata>x</metadata>"), "element <metadata>"],
    ["a processing instruction", svg("<?php echo 1 ?><rect/>"), "a processing instruction <?php?>"],
    ["CDATA outside a stylesheet", svg("<text><![CDATA[x]]></text>"), "a CDATA section outside <style>"],
    ["text outside a text element", svg("<g>the answer</g>"), "text outside a text element (in <g>)"],
    [
      "an inkscape attribute",
      svg('<g inkscape:label="layer"/>', 'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"'),
      "attribute xmlns:inkscape on <svg>",
    ],
    ["an unknown attribute", svg('<rect requiredExtensions="x"/>'), "attribute requiredExtensions on <rect>"],
    ["a remote url() in a stylesheet", svg("<style>rect { fill: url(http://evil.example/p.svg#a) }</style>"), "a url() that is not #id in <style>"],
    ["an @import", svg("<style>@import 'http://evil.example/x.css';</style>"), "@import in <style>"],
    ["a remote url() in style=", svg('<rect style="fill: url(https://evil.example/a)"/>'), "style on <rect> has a url() that is not #id"],
    ["a remote url() in fill", svg('<rect fill="url(https://evil.example/a#b)"/>'), "fill on <rect> has a url() that is not #id"],
    ["a CSS escape", svg("<style>rect { fill: \\75 rl(x) }</style>"), "a backslash escape in <style>"],
    ["expression()", svg('<rect style="width: expression(alert(1))"/>'), "expression( in style on <rect>"],
    ["a root that is not svg", Buffer.from(`<html ${NS}/>`), "the root is <html>, not <svg>"],
    ["no namespace", Buffer.from("<svg/>"), "the root is not an <svg> in the SVG namespace"],
    ["a huge viewBox", svg("", 'viewBox="0 0 100000 10"'), "viewBox on <svg> out of range"],
    ["a negative width", svg("", 'width="-5"'), "width on <svg> out of range"],
    ["malformed XML", Buffer.from(`<svg ${NS}><rect></svg>`), "not well-formed XML"],
    ["a stylesheet of another type", svg('<style type="text/javascript">x</style>'), "stylesheet type text/javascript"],
  ])("refuses %s", (_label, bytes, expected) => {
    expect(reason(bytes)).toContain(expected);
  });

  it("refuses an SVG over the size cap", () => {
    const big = svg(`<rect width="1" height="1"/>`.repeat(Math.ceil(SVG_MAX_BYTES / 25)));
    expect(big.length).toBeGreaterThan(SVG_MAX_BYTES);
    expect(reason(big)).toContain("larger than 512 KB");
  });

  it("refuses too many elements and too deep a nesting", () => {
    expect(reason(svg("<rect/>".repeat(SVG_MAX_ELEMENTS)))).toContain(`more than ${SVG_MAX_ELEMENTS} elements`);
    expect(reason(svg("<g>".repeat(SVG_MAX_DEPTH) + "</g>".repeat(SVG_MAX_DEPTH)))).toContain(
      `nested deeper than ${SVG_MAX_DEPTH} levels`,
    );
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(reason(Buffer.concat([Buffer.from(`<svg ${NS}><text>`), Buffer.from([0xff, 0xfe]), Buffer.from("</text></svg>")]))).toBe(
      "not UTF-8 text",
    );
  });
});

describe("looksLikeMarkup", () => {
  it("tells markup from anything else", () => {
    expect(looksLikeMarkup(Buffer.from("﻿  \n<svg/>"))).toBe(true);
    expect(looksLikeMarkup(Buffer.from("not an image"))).toBe(false);
  });
});
