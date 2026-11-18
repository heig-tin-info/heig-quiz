# ADR-134 — SVG in questions: a strict check that refuses, an MCP upload tool

## Status

Accepted (2026-11-18, the product owner's decisions of 2026-11-18).

Scope: the images a question embeds (the asset store of the pools), the MCP
tools that write a question, and the Typst PDF of a question's image.
Avatars and remote pictures are out of scope and stay raster.

Relations: amends [ADR-022 §B and §C](ADR-022-jetons-api-et-serveur-mcp.md#c-what-the-tools-are-and-what-they-are-not)
(a new writing tool, a multipart call), [F-QST-06](../spec/02-exigences-fonctionnelles.md),
[N-SEC-02 and N-SEC-05](../spec/03-exigences-non-fonctionnelles.md); reads
[ADR-125 §2](ADR-125-copies-papier-pdf-typst.md) and
[ADR-126](ADR-126-types-a-canevas-sur-papier.md); invariant 4 of `CLAUDE.md`.

## Context

An MCP client (an assistant writing a quiz for a teacher) could not put a
figure in a question. The only image a Markdown field draws is
`![alt](asset:<id>)` (`apps/web/src/markdown/render.ts`): an `https://`
picture, a `data:` URI or raw `<img>` is dropped to its alt text, and the
model believes it placed a figure. A model can draw a diagram as SVG text,
but the asset store refused SVG outright since F-QST-06: an SVG is a
document — script, external fetches, embedded HTML, text nobody sees drawn.

## Decision

1. **SVG is a question asset type, and only that.** `AssetMime` gains
   `image/svg+xml`. `AvatarMime` is `AssetMime` without `image/gif` and
   `image/svg+xml` (PNG, JPEG, WebP), and `sniffImage` stays raster-only: an
   avatar upload and a remote picture (`remoteImage.ts`) still refuse SVG
   (N-SEC-02). The SVG check is a separate function,
   `apps/api/src/modules/pool/svgCheck.ts`, called only by the
   question-asset upload (`POST /app/api/pools/:id/assets`) when the bytes
   are markup rather than a raster magic number.

2. **The check refuses, it never rewrites.** It parses with `saxes` (a
   strict, non-validating, pure-JS XML parser, pinned) and refuses at the
   first offending thing; what it accepts is stored byte for byte,
   content-addressed by its sha256 as before, with no width nor height (null:
   an SVG's size is its renderer's business). What it enforces, exactly:

   - **Text**: UTF-8 only (a declared `encoding` other than UTF-8 is
     refused), at most 512 KB (far below `ASSETS_MAX_BYTES`), well-formed XML.
   - **Root and namespace**: the root is `<svg>` in the SVG namespace, and
     every element is in that namespace.
   - **Elements allowed**: `svg`, `g`, `defs`, `symbol`, `use`, `path`,
     `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`,
     `tspan`, `textPath`, `marker`, `linearGradient`, `radialGradient`,
     `stop`, `clipPath`, `mask`, `pattern`, `style`. Anything else is
     refused, among them `script`, `foreignObject`, `image`, `filter` and
     the `fe*` primitives, `animate*` and `set`, `a`, `iframe` or any HTML,
     `title`, `desc`, `metadata`. No element inside a `<style>`.
   - **Refused constructs**: XML comments, processing instructions other
     than the leading `<?xml …?>`, a DOCTYPE and therefore any entity beyond
     XML's five, CDATA outside `<style>`, non-blank text outside `text`,
     `tspan` and `textPath`.
   - **Attributes allowed**: the presentation and geometry attributes listed
     in `ATTRIBUTES` of `svgCheck.ts` (coordinates, `d`, `points`,
     `transform`, fill and stroke properties, font properties, text
     positioning, marker, gradient, clip, mask and pattern attributes, `id`,
     `class`, `style`, `display`, `visibility`, `version`), `xmlns` (the SVG
     namespace only), `xmlns:xlink` (the XLink namespace only), `href` and
     `xlink:href`; `type="text/css"` on `<style>`. Any `on*` handler and any
     other namespaced attribute (`inkscape:`, `sodipodi:`, `xml:`…) is
     refused. No attribute value holds a backslash, checked after the
     parser decoded the entities (`&#x5C;` is one).
   - **References**: `href` and `xlink:href` only as a same-document `#id`;
     any `url(…)`, in an attribute or a stylesheet, only as `url(#id)`.
   - **Functions**: every `name(` in an attribute value or a stylesheet is
     on an allow-list — `rgb`, `rgba`, `hsl`, `hsla`, `calc`, `url` (as
     above) and the transforms `matrix`, `translate(X|Y)`, `scale(X|Y)`,
     `rotate`, `skew(X|Y)`; any other (`image(`, `image-set(`,
     `cross-fade(`, `src(`, `expression(`, `var(`…) is refused. A known
     limit, accepted rather than parsing CSS: the scan also trips on
     selectors and conditions written like calls — `:not(`, `:nth-child(`,
     `@media … and (` — which are refused, the refusal naming them.
   - **Stylesheets**: the text and CDATA of one `<style>` are joined and
     checked once, at its close tag, so a construct cut across CDATA
     sections is seen whole; a stylesheet or a `style=` holds no `@import`,
     no comment (`/*`), no backslash, no `javascript:`, and only allowed
     functions.
   - **A drawn-element budget**: every reference is an `href` or an
     `xlink:href` (both counted when both are there) or a `url(#id)` in an
     attribute or a `style=`. Once the whole SVG is read, an element costs
     1, plus its children, plus the element it references, once per
     reference: a `<use>`, a mask, a clip path, a pattern, a gradient or a
     marker is drawn again where it is used — a marker counted once per
     element that names it, not once per vertex. A `url(#id)` of a
     `<style>` may apply to every element: it costs its target once per
     element of the SVG. A reference cycle is refused; the root's cost,
     the stylesheet's share included, is at most 20,000
     (`SVG_MAX_DRAWN`). One rule bounds every amplification: flat copies,
     chains of `<use>`, masks or patterns referencing each other.
   - **Depth**: at most 64 levels of nesting, because renderers (usvg in
     Typst, the browsers) recurse on it.

   The refusal is `415 { error: "svg_refused", code, name?, message }`
   (`SvgRefusal` of `@quiz/contracts`): `code` is one of a CLOSED set —
   `too_large`, `malformed` (not UTF-8, another declared encoding, not
   well-formed: only the parser's own error), `not_svg`, `construct`
   (DOCTYPE, comment, processing instruction, CDATA outside `<style>`),
   `text`, `element`, `attribute`, `namespace`, `reference` (an `href` or a
   `url()` that is not `#id`), `function`, `css`, `escape`, `cycle`,
   `too_deep`, `too_complex` —, `name` the element, attribute, namespace,
   function or construct at fault, or the limit passed (`512 KB`, `64`,
   `20000`, so no limit is written in the web's dictionaries), and
   `message` an English wording for an MCP client. The web words each code
   in the reader's language. Bytes that are neither raster nor markup stay
   `415 unsupported_media_type`.

3. **Why a check, and why it is the second barrier.** An asset is shown
   through `<img>` only — the renderer's one image rule — where a browser
   runs no script and fetches nothing, and it is served with
   `INERT_IMAGE_HEADERS` (`nosniff`, `Content-Security-Policy: default-src
   'none'; sandbox`), so even a direct navigation to its URL is inert. The
   check keeps what reaches the store small and plain, and keeps out what a
   student could READ in the source without it being drawn — comments (XML
   and CSS), `title`, `desc`, `metadata`, stray text: a student in an
   attempt may fetch the asset (invariant 4). An authoring rule says the
   rest: the SVG never carries the answer, a hint or the correct choice.

4. **Typst and the PDF.** The sandbox of ADR-125 §2 is unchanged: the asset
   is copied to `assets/<id>`, with no extension, and the template's
   `image("assets/" + id)` lets Typst detect the format from the bytes,
   which it does for SVG as for PNG (verified on Typst 0.15.1 by the
   `compile.test.ts` case, which compiles an accepted fixture; the
   diagram's text stays text in the PDF). This is not ADR-126's rejected
   "SVG as an asset file in the compile root": that alternative was about
   the canvas types' own drawings, which are generated and inlined as a
   string literal; here the SVG is a teacher's uploaded asset, and it
   travels the path every asset already takes, with nothing added to the
   sandbox. If a later Typst stops detecting the format, the fix is a
   `format:` hint carried with the drawable id.

5. **MCP: `upload_asset`, SVG only.** Input `{ poolId, svg, alt? }`,
   output `{ assetId, markdown: "![alt](asset:<id>)" }`. ADR-022 §B holds:
   the tool calls the SAME upload route through the in-process client,
   which gains a multipart call (`Api.upload`), so the contributor right,
   the audit `pool.asset_upload` and the deduplication are the route's.
   It is a write (scope `quiz`). The request to `/app/api/mcp` stays under
   Fastify's 1 MiB body limit; the 512 KB cap fits, and the tool's
   description says so. The help assistant does not get it (its lists are
   closed, ADR-080).

6. **MCP: the question tools refuse a foreign image.** `create_question`
   (its `config` and `explanation`) and `update_question` (only the
   `config` and `explanation` the call sends, never the inherited draft)
   refuse, BEFORE any write — `update_question`'s metadata PATCH included —
   a Markdown string holding an image whose `src` is not `ASSET_REF`, or
   raw HTML holding `<img`. The images are read by `markdownImages` of
   `@quiz/docexport/images`, on `marked`'s lexer — the renderers' grammar —
   so a picture inside a code span or a fence, or an escaped `\![x](y)`, is
   text, and a reference-style image is resolved as the renderers resolve
   it. `ASSET_REF` and its id fragment live once in that same subpath, read
   by the web renderer, the PDF and the tools. The refusal is the shape of
   the config issues, `{ path, message }`, and tells the model to call
   `upload_asset`. The web editor is unchanged: it writes asset references
   by construction.

7. **The web editor.** Its picker and paste already take `image/*`, so an
   SVG goes up the same way; a refused SVG shows its code's wording in a
   toast (`md.image.svg.<code>`, English and French), another refused type
   the accepted list (`md.image.typeRefused`). The rotate buttons are
   hidden for an SVG (a quarter turn redraws a bitmap through a canvas),
   decided from the type the asset is served with.

## Consequences

- An assistant can illustrate a question with a diagram, and a teacher can
  drop an SVG exported from a drawing tool, provided it is plain: an
  Inkscape or draw.io export (namespaced attributes, `metadata`, filters,
  embedded images, CSS comments) is refused with its reason and must be
  simplified.
- **Residual risk: readable text the check lets through.** A student who
  opens the source reads everything in it. The check keeps out comments,
  `title`, `desc`, `metadata` and stray text, but it cannot judge meaning
  or visibility: a `<text>` drawn off-canvas, at zero opacity, in the
  background colour or inside a `<defs>` nothing references; and words in
  attribute values — an `id`, a `class`, a `font-family`. The authoring
  rule (MCP tool description, `MARKDOWN_RULES`, server instructions) and
  the teacher's review are the defence.
- **No re-check of stored SVGs.** Tightening the allow-list later does not
  re-check the SVGs already stored: they stay served, inert as every asset
  is. Accepted.
- A new dependency, `saxes`, in `apps/api`.

## Alternatives considered

- **Sanitising (rewriting) the SVG**, DOMPurify-style: the stored bytes
  would differ from what the author drew, silently, and a sanitiser's job
  is to let as much through as it can; a refusal with a reason is easier to
  trust and to test.
- **Rasterising the SVG to PNG on upload**: a renderer in the API, blurred
  diagrams, unreadable text in the PDF.
- **Accepting `https://` images in Markdown**: a third-party request from a
  student's browser during an exam (N-SEC-02), and content that changes
  after publication.
- **A separate SVG upload route for MCP**: a second path to the store, its
  own right and audit to keep equal; one route keeps one rule.
- **SVG for avatars too**: no need, and the remote-picture policy stays one
  raster list.
