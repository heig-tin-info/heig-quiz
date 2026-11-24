/**
 * What keeps a document inside the page that shows it (ADR-144 §6): its
 * links never navigate the browser, and a copy made in it is one of the
 * page's own copies for the integrity journal (ADR-088).
 *
 * Links. A link that may leave the document (a web address, an asset) keeps
 * its text and shows its address as a tooltip, with no `href` and no
 * `target`: a click, a middle click, the context menu or a drag opens
 * nothing. A link inside the document (a heading of the Markdown, a page of
 * the PDF, an outline entry) has no `href` either — a middle click on
 * `href="#…"` would open the exam's own page in a second tab — but stays a
 * link for the keyboard: focusable, named a link, Enter or a click moves the
 * viewer.
 *
 * Copies. pdf.js's text layer answers a `copy` with its own, Unicode-
 * normalised text (`ﬁ` → `fi`, `µ` → `μ`, `Ω` the ohm sign → `Ω`) and stops
 * the event, so the journal's listener on `window` would never see the end
 * of the copy and the clipboard would differ from the selection it
 * recorded. Its viewer also listens to every `copy` of the document, and
 * after Ctrl+A writes the whole PDF's text to the clipboard on its own,
 * through a hidden element it puts in the page.
 */

/** A link that leaves the document: its text stays, its address is its tooltip, nothing navigates. */
export function inertLink(link: HTMLAnchorElement, address: string | null): void {
  link.removeAttribute("href");
  link.removeAttribute("target");
  link.removeAttribute("rel");
  link.removeAttribute("download");
  if (address) link.title = address;
  else link.removeAttribute("title");
}

/** A link within the document: no `href`, but a link for the keyboard; `go` moves the viewer. */
export function inPageLink(link: HTMLAnchorElement, go: (() => void) | null): void {
  link.removeAttribute("href");
  link.removeAttribute("target");
  link.removeAttribute("rel");
  link.tabIndex = 0;
  link.setAttribute("role", "link");
  if (go) link.onclick = () => (go(), false);
  link.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    link.click();
  });
}

/**
 * pdf.js's links, once a page's annotations are drawn: a web address is
 * inert (its tooltip, set by {@link pdfLinkAttributes}, is the address); a
 * link within the document keeps the `onclick` pdf.js gave it, which moves
 * the viewer, and loses its `href`.
 */
export function inertPdfLinks(root: ParentNode): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>(".annotationLayer a")) {
    if (link.dataset["docInert"] !== undefined) continue;
    link.dataset["docInert"] = "";
    if (link.onclick) inPageLink(link, null);
    else inertLink(link, link.title || null);
  }
}

/**
 * In place of `PDFLinkService.addLinkAttributes` (a web address of the PDF):
 * no `href`, no `target`, the address as the tooltip — never pdf.js's
 * English "Disabled: …".
 */
export function pdfLinkAttributes(link: HTMLAnchorElement, url: string): void {
  inertLink(link, url);
}

/**
 * Makes a copy in one of `container`'s PDF text layers an ordinary copy of
 * the page: the clipboard gets the selection exactly as the journal reads it
 * (`document.getSelection().toString()`), and the event goes on to `window`.
 * It runs in the capture phase, before the text layer's own handler, and
 * leaves that handler nothing to do for this one event: its write to the
 * clipboard and its `stopPropagation` are made no-ops. A copy elsewhere is
 * not touched.
 */
export function ownTextLayerCopies(container: HTMLElement, signal: AbortSignal): void {
  container.addEventListener(
    "copy",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".textLayer")) return;
      const data = (event as ClipboardEvent).clipboardData;
      if (!data) return;
      data.setData("text/plain", document.getSelection()?.toString() ?? "");
      event.preventDefault();
      Object.defineProperty(data, "setData", { configurable: true, value: () => undefined });
      Object.defineProperty(event, "stopPropagation", { configurable: true, value: () => undefined });
    },
    { capture: true, signal },
  );
}

/**
 * pdf.js's "copy all": an element it puts before the pages, which a
 * Ctrl+A selection contains, and a `copy` listener on the document that then
 * stops the copy and writes the whole PDF's text instead. The element taken
 * out of the page, the listener finds no such selection and leaves every
 * copy alone (with several viewers mounted, each one's).
 */
export function dropCopyAll(container: ParentNode): void {
  for (const element of container.querySelectorAll("#hiddenCopyElement")) element.remove();
}
