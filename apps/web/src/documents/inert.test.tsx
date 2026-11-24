import { readFileSync } from "node:fs";

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { useIntegrityJournal } from "../attempt/integrity";
import { dropCopyAll, inertLink, inertPdfLinks, inPageLink, ownTextLayerCopies, pdfLinkAttributes } from "./inert";
import { loadPdfjs } from "./pdfjs";
import { PdfView } from "./PdfView";
import { initialViewState, type PdfViewState } from "./viewState";

/*
 * What keeps a document inside the page (ADR-144 §6), against pdf.js's REAL
 * components (legacy build, its worker in this thread) and the integrity
 * journal's REAL listeners (ADR-088): links that navigate nothing, a copy in
 * the text layer that the journal sees as any other copy of the page, and
 * no "copy all" of pdf.js left in the page.
 */
vi.mock("./pdfjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pdfjs")>()),
  loadPdfjs: vi.fn(),
}));

let lib: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let components: typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

/** A minimal PDF: one page of text, a link to a web address and one to its own page 2. */
function linkedPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [7 0 R 8 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 250 Td (Datasheet) Tj ET\nendstream",
    "<< /Type /Annot /Subtype /Link /Rect [20 200 200 220] /A << /S /URI /URI (https://example.com/away) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [20 170 200 190] /Dest [4 0 R /XYZ 0 300 null] >>",
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

beforeAll(async () => {
  lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = lib;
  // Its worker, in this thread: pdf.js uses `globalThis.pdfjsWorker` when it is there.
  // @ts-expect-error -- pdf.js ships no types for its worker module.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  components = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
});

beforeEach(() => {
  // The text layer measures its words on a canvas, which jsdom has not.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        canvas: document.createElement("canvas"),
        measureText: (text: string) => ({ width: text.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
        save() {},
        restore() {},
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  document.getSelection()?.removeAllRanges();
});

/** A `copy` event as a browser fires it: a clipboard to write, its text read back. */
function copyEvent() {
  const store = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { setData: (type: string, text: string) => store.set(type, text), getData: (type: string) => store.get(type) ?? "" },
  });
  return { event, clipboard: () => store.get("text/plain") ?? "" };
}

/** A `paste` event carrying `text`. */
function pasteEvent(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  return event;
}

/** pdf.js's text layer of `text`, rendered by its own TextLayerBuilder, inside a viewer element of ours. */
async function textLayer(text: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const abort = new AbortController();
  ownTextLayerCopies(container, abort.signal);
  const pdfPage = {
    streamTextContent: () => ({
      items: [{ str: text, dir: "ltr", width: text.length * 6, height: 12, transform: [12, 0, 0, 12, 20, 250], fontName: "f1", hasEOL: false }],
      styles: { f1: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } },
      lang: "fr",
    }),
  };
  const viewport = { scale: 1, rotation: 0, userUnit: 1, width: 300, height: 300, transform: [1, 0, 0, -1, 0, 300], rawDims: { pageWidth: 300, pageHeight: 300, pageX: 0, pageY: 0 } };
  const builder = new components.TextLayerBuilder({ pdfPage: pdfPage as never, abortSignal: abort.signal });
  container.append(builder.div);
  await builder.render({ viewport, images: null } as never);
  const span = builder.div.querySelector("span")!;
  return { container, span, abort };
}

describe("a copy in a PDF's text layer (ADR-088)", () => {
  // µ (micro sign), Ω (ohm sign) and the ﬁ ligature: what pdf.js's own handler would rewrite.
  const TEXT = "10 µF ﬁlter capacitor, 47 Ω résistance série";

  it("reaches a listener on window, and the clipboard holds the selection itself", async () => {
    const { span } = await textLayer(TEXT);
    expect(span.textContent).toBe(TEXT);
    document.getSelection()!.selectAllChildren(span);
    const seen = vi.fn();
    window.addEventListener("copy", seen);
    const { event, clipboard } = copyEvent();
    span.dispatchEvent(event);
    window.removeEventListener("copy", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(clipboard()).toBe(TEXT);
    expect(clipboard()).toBe(document.getSelection()!.toString());
  });

  it("is a copy of the page for the journal: pasted into an answer, it raises no paste incident", async () => {
    const report = vi.fn();
    renderHook(() => useIntegrityJournal("attempt-1", report, { journaled: true, notify: false }));
    const { span } = await textLayer(TEXT);
    document.getSelection()!.selectAllChildren(span);
    const { event, clipboard } = copyEvent();
    act(() => void span.dispatchEvent(event));
    const answer = document.createElement("textarea");
    document.body.append(answer);
    act(() => void answer.dispatchEvent(pasteEvent(clipboard())));
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "paste" }));
    // A text the page never showed still is one.
    act(() => void answer.dispatchEvent(pasteEvent("A paragraph brought from somewhere else entirely.")));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "paste" }));
  });

  it("leaves a copy elsewhere on the page alone", async () => {
    await textLayer(TEXT);
    const outside = document.createElement("p");
    outside.textContent = "A question's statement.";
    document.body.append(outside);
    document.getSelection()!.selectAllChildren(outside);
    const { event, clipboard } = copyEvent();
    outside.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboard()).toBe("");
  });
});

describe("pdf.js's viewer in the page", () => {
  /** A PdfView of the linked PDF, with pdf.js's real components and its document read in this thread. */
  async function mountPdf() {
    const element = document.createElement("div");
    element.style.position = "absolute";
    document.body.append(element);
    vi.mocked(loadPdfjs).mockResolvedValue({
      lib: { ...lib, getDocument: (params: object) => lib.getDocument({ ...params, url: undefined, data: linkedPdf() } as never) },
      viewer: components,
    } as never);
    const view = new PdfView(
      "/doc.pdf",
      { element, onChange: () => {}, isActive: () => true, pageLabel: (n) => `Page ${n}` },
      initialViewState("pdf") as PdfViewState,
    );
    await view.load();
    await vi.waitFor(() => expect(view.status).toBe("ready"), { timeout: 5000 });
    return { element, view };
  }

  it("keeps no hidden copy element, with two viewers mounted: Ctrl+A then a copy is the page's own", async () => {
    const one = await mountPdf();
    const two = await mountPdf();
    expect(document.querySelectorAll("#hiddenCopyElement")).toHaveLength(0);
    const question = document.createElement("p");
    question.textContent = "Explain the follower.";
    document.body.append(question);
    // pdf.js's document listener runs after the first page; give it its turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.getSelection()!.selectAllChildren(document.body);
    const seen = vi.fn();
    window.addEventListener("copy", seen);
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { event } = copyEvent();
    question.dispatchEvent(event);
    window.removeEventListener("copy", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    one.view.destroy();
    two.view.destroy();
  });

  it("draws links that navigate nothing: no href, no target, no English title; a link within moves the viewer", async () => {
    const task = lib.getDocument({ data: linkedPdf() });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const eventBus = new components.EventBus();
    const linkService = new components.PDFLinkService({ eventBus });
    linkService.externalLinkEnabled = false;
    linkService.addLinkAttributes = pdfLinkAttributes;
    linkService.setDocument(doc, null);
    const goTo = vi.spyOn(linkService, "goToDestination").mockResolvedValue(undefined);
    const div = document.createElement("div");
    div.className = "annotationLayer";
    document.body.append(div);
    const viewport = page.getViewport({ scale: 1 });
    const layer = new lib.AnnotationLayer({ div, page, viewport, accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, structTreeLayer: null, commentManager: null, linkService } as never);
    await layer.render({ annotations: await page.getAnnotations(), viewport, linkService, renderForms: false, div, page } as never);
    inertPdfLinks(document.body);
    const links = [...div.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.hasAttribute("href")).toBe(false);
      expect(link.hasAttribute("target")).toBe(false);
      expect(link.title).not.toMatch(/Disabled/);
    }
    const [external, internal] = links as [HTMLAnchorElement, HTMLAnchorElement];
    expect(external.title).toBe("https://example.com/away");
    expect(external.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }))).toBe(true);
    expect(internal.getAttribute("role")).toBe("link");
    expect(internal.tabIndex).toBe(0);
    internal.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(goTo).toHaveBeenCalledTimes(1);
    await task.destroy();
  });
});

describe("links of a document's HTML", () => {
  it("keeps the text of a link that leaves, its address as the tooltip, nothing to follow", () => {
    const link = document.createElement("a");
    link.href = "https://example.com/x";
    link.target = "_blank";
    link.rel = "noreferrer";
    inertLink(link, "https://example.com/x");
    expect(link.getAttributeNames().sort()).toEqual(["title"]);
  });

  it("makes a link within the document a keyboard link without an address", () => {
    const go = vi.fn();
    const link = document.createElement("a");
    link.href = "#limits";
    inPageLink(link, go);
    expect(link.hasAttribute("href")).toBe(false);
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    link.click();
    expect(go).toHaveBeenCalledTimes(2);
  });

  it("takes pdf.js's copy-all element out of the page", () => {
    const element = document.createElement("div");
    element.id = "hiddenCopyElement";
    document.body.append(element);
    dropCopyAll(document.body);
    expect(document.getElementById("hiddenCopyElement")).toBeNull();
  });
});
