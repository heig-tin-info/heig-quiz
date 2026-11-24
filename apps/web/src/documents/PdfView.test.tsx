import { afterEach, describe, expect, it, vi } from "vitest";

import { quietScroll, SCROLL_FLAG } from "./PdfView";

/*
 * Against the pinned pdf.js itself (legacy build, under jsdom: its viewer
 * components read the DOM when they load): the viewer
 * reaches into one private field of `PDFFindController`, and an upgrade that
 * renames it must fail here, not silently in a student's exam.
 */
async function realFindController() {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = lib;
  const { EventBus, PDFFindController, PDFLinkService } = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
  const eventBus = new EventBus();
  return new PDFFindController({ eventBus, linkService: new PDFLinkService({ eventBus }) });
}

afterEach(() => vi.restoreAllMocks());

describe("the find controller's private scroll flag", () => {
  it("is still there, a boolean, and read by scrollMatchIntoView", async () => {
    const controller = await realFindController();
    expect(typeof (controller as unknown as Record<string, unknown>)[SCROLL_FLAG]).toBe("boolean");
    const method = Object.getPrototypeOf(controller).scrollMatchIntoView as () => void;
    expect(method.toString()).toContain(SCROLL_FLAG);
  });

  it("is cleared, and the scroll skipped, while the search is quiet", async () => {
    const controller = await realFindController();
    const fields = controller as unknown as Record<string, unknown>;
    let quiet = true;
    expect(quietScroll(controller, () => quiet)).toBe(true);
    const element = { scrollIntoView: vi.fn() } as unknown as HTMLElement;
    fields[SCROLL_FLAG] = true;
    controller.scrollMatchIntoView({ element, pageIndex: 0, matchIndex: 0 });
    expect(fields[SCROLL_FLAG]).toBe(false);
    expect(element.scrollIntoView).not.toHaveBeenCalled();
    quiet = false;
    // The reader's own search: pdf.js's behaviour, untouched (it scrolls to the selected match).
    fields[SCROLL_FLAG] = true;
    fields["_selected"] = { pageIdx: 0, matchIdx: 0 };
    controller.scrollMatchIntoView({ element, pageIndex: 0, matchIndex: 0 });
    expect(element.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(fields[SCROLL_FLAG]).toBe(false);
  });

  it("leaves pdf.js's default alone, without throwing, when the field is gone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scrollMatchIntoView = vi.fn();
    const controller = { scrollMatchIntoView } as never;
    expect(quietScroll(controller, () => true)).toBe(false);
    expect((controller as { scrollMatchIntoView: unknown }).scrollMatchIntoView).toBe(scrollMatchIntoView);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
