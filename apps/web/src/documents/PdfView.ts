/**
 * The PDF viewer: pdf.js's own components (`PDFViewer`, `PDFLinkService`,
 * `PDFFindController`) in our scroll element, driven by our toolbar.
 *
 * A PDF is active content, and what it may do here is decided once, below:
 * no document script (no scripting manager is given, so `enableScripting` is
 * false), no XFA, no form field and no annotation editing (annotations are
 * drawn, never filled nor added), and no link navigates the browser
 * (`inert.ts`): a web address shows itself and opens nothing, so a link in
 * a datasheet cannot take the exam's tab away; internal links and outline
 * entries move the viewer. A copy in the text layer is the page's own, as
 * the integrity journal sees it, and pdf.js's "copy all" is taken out
 * (`inert.ts`). pdf.js 6 compiles no font with `new Function` any more (it
 * has no `isEvalSupported` to turn off), and the CSP refuses any eval
 * anyway.
 *
 * The position is kept as a destination (a page and a point of it, in PDF
 * units), so a remount at another width shows the same spot.
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

import { dropCopyAll, inertPdfLinks, ownTextLayerCopies, pdfLinkAttributes } from "./inert";
import { currentEntry, type OutlineItem } from "./outline";
import { documentParams, loadPdfjs, type Pdfjs } from "./pdfjs";
import { type DocView, type SearchCount, type ViewOptions, type ViewStatus, watchSize } from "./view";
import { canZoom, PDF_ZOOMS, type PdfLocation, type PdfScale, type PdfViewState, zoomStep } from "./viewState";

/** How long a refit's own scrolls go on (pdf.js's deferred re-layout); then the kept spot is put back. */
const RELAYOUT_SETTLE_MS = 200;

interface Parts {
  eventBus: EventBus;
  linkService: PDFLinkService;
  findController: PDFFindController;
  viewer: PDFViewer;
}

/** pdf.js's raw outline node: what this view reads of it. */
interface RawOutline {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutline[];
}

export class PdfView implements DocView {
  readonly kind = "pdf";
  status: ViewStatus = "loading";
  pageCount = 0;
  page = 1;
  query: string;
  count: SearchCount = { current: 0, total: 0, pending: false };
  outline: OutlineItem[] | null = null;

  readonly #url: string;
  readonly #element: HTMLDivElement;
  readonly #onChange: () => void;
  readonly #isActive: () => boolean;
  #location: PdfLocation | null;
  #scale: PdfScale;
  /** Until the kept position is back, the viewer's own first layout must not overwrite it. */
  #restored = false;
  /** A query restored on load highlights without moving the view; the student's own search moves it. */
  #quietFind: boolean;
  #outlineDests: (string | unknown[] | null)[] = [];
  #outlinePages: (number | null)[] = [];
  #parts: Parts | null = null;
  #task: PDFDocumentLoadingTask | null = null;
  #doc: PDFDocumentProxy | null = null;
  readonly #abort = new AbortController();
  #unwatch: (() => void) | null = null;
  /** The timer that ends a refit (`#relayout`). */
  #settle: ReturnType<typeof setTimeout> | undefined = undefined;
  #destroyed = false;

  readonly #pageLabel: (page: number) => string;
  readonly #onFailed: ((error: unknown) => void) | undefined;

  constructor(url: string, { element, onChange, isActive, pageLabel, onFailed }: ViewOptions, saved: PdfViewState) {
    this.#url = url;
    this.#onFailed = onFailed;
    this.#pageLabel = pageLabel;
    this.#element = element;
    this.#onChange = onChange;
    this.#isActive = isActive;
    this.#location = saved.location;
    this.#scale = saved.scale;
    this.query = saved.query;
    this.#quietFind = Boolean(saved.query);
  }

  async load(): Promise<void> {
    this.status = "loading";
    this.#onChange();
    try {
      const { lib, viewer: components } = await loadPdfjs();
      if (this.#destroyed) return;
      this.#build(lib, components);
      this.#task = lib.getDocument(documentParams(this.#url, lib.version));
      this.#doc = await this.#task.promise;
    } catch (error) {
      if (this.#destroyed) return;
      this.status = "failed";
      this.#onChange();
      this.#onFailed?.(error);
      console.warn("document viewer: the PDF could not be loaded", error);
      return;
    }
    if (this.#destroyed) return;
    const { viewer, linkService } = this.#parts!;
    this.pageCount = this.#doc.numPages;
    viewer.setDocument(this.#doc);
    linkService.setDocument(this.#doc, null);
    await this.#readOutline();
    this.#onChange();
  }

  #build(lib: Pdfjs["lib"], components: Pdfjs["viewer"]): void {
    if (this.#parts) return;
    const { EventBus, PDFViewer, PDFLinkService, PDFFindController, FindState } = components;
    const inner = document.createElement("div");
    inner.className = "pdfViewer";
    this.#element.append(inner);

    const eventBus = new EventBus();
    // A destination's zoom never changes the student's.
    const linkService = new PDFLinkService({ eventBus, ignoreDestinationZoom: true });
    linkService.externalLinkEnabled = false;
    linkService.addLinkAttributes = pdfLinkAttributes;
    const findController = new PDFFindController({ eventBus, linkService });
    quietScroll(findController, () => this.#quietFind);
    // `abortSignal` (read by pdf.js, missing from its types) takes the
    // viewer's document-wide listeners away with it on `destroy`.
    const settings: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
      container: this.#element,
      viewer: inner,
      eventBus,
      linkService,
      findController,
      // Annotations are drawn (links included); no form field, no editing.
      annotationMode: lib.AnnotationMode.ENABLE,
      annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      // A URL written in the text stays text.
      enableAutoLinking: false,
      removePageBorders: true,
      // pdf.js names each page for a screen reader in its own English;
      // these are our words (`viewerL10n`).
      l10n: viewerL10n(this.#pageLabel) as never,
      abortSignal: this.#abort.signal,
    };
    const viewer = new PDFViewer(settings);
    linkService.setViewer(viewer);
    this.#parts = { eventBus, linkService, findController, viewer };

    const opts = { signal: this.#abort.signal };
    ownTextLayerCopies(this.#element, this.#abort.signal);
    eventBus.on("pagesinit", () => this.#onPagesInit(), opts);
    eventBus.on("annotationlayerrendered", ({ source }: { source: { div?: HTMLElement } }) => {
      inertPdfLinks(source.div ?? this.#element);
    }, opts);
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      this.page = pageNumber;
      this.#onChange();
    }, opts);
    eventBus.on("scalechanging", () => this.#onChange(), opts);
    eventBus.on("updateviewarea", ({ location }: { location: PdfLocation }) => {
      if (!this.#restored || !this.#isActive()) return;
      this.#location = { pageNumber: location.pageNumber, top: location.top, left: location.left };
      this.#onChange();
    }, opts);
    eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
      this.count = { current: matchesCount.current, total: matchesCount.total, pending: false };
      this.#onChange();
    }, opts);
    eventBus.on(
      "updatefindcontrolstate",
      ({ state, matchesCount }: { state: number; matchesCount?: { current: number; total: number } }) => {
        this.count = {
          current: matchesCount?.current ?? 0,
          total: matchesCount?.total ?? 0,
          pending: state === FindState.PENDING,
        };
        // A restored query: pdf.js jumps to its first match right after
        // this event; put the reader back where they were.
        if (this.#quietFind && state !== FindState.PENDING) queueMicrotask(() => this.restore());
        this.#onChange();
      },
      opts,
    );
    this.#unwatch = watchSize(this.#element, () => this.#relayout());
  }

  #onPagesInit(): void {
    // pdf.js put its "copy all" element in the page just before this event.
    dropCopyAll(this.#element);
    const { viewer } = this.#parts!;
    viewer.currentScaleValue = String(this.#scale);
    this.restore();
    this.#restored = true;
    this.status = "ready";
    if (this.query) this.#dispatchFind("");
    this.#onChange();
  }

  /** The width changed (a panel, a full screen, a window): refit, then back to the kept spot. */
  #relayout(): void {
    const viewer = this.#parts?.viewer;
    if (!viewer?.pagesCount) return;
    // The refit scrolls, and pdf.js reports that intermediate spot as the
    // reader's: the kept one is put back before the view returns to it
    // (a full screen used to land a few lines off).
    const kept = this.#location;
    this.#restored = false;
    if (typeof this.#scale === "string") viewer.currentScaleValue = this.#scale;
    this.#location = kept;
    this.restore();
    // pdf.js lays the pages out again and scrolls on its own a few frames
    // later (to a page's top): back to the kept spot once it is done, and
    // only then is a scroll the reader's again.
    clearTimeout(this.#settle);
    this.#settle = setTimeout(() => {
      this.#settle = undefined;
      this.#location = kept;
      this.restore();
      this.#restored = true;
    }, RELAYOUT_SETTLE_MS);
  }

  /** The reader moves the view: a refit under way must not put it back where it was. */
  #readerMoves(): void {
    if (this.#settle === undefined) return;
    clearTimeout(this.#settle);
    this.#settle = undefined;
    this.#restored = true;
  }

  restore(): void {
    const viewer = this.#parts?.viewer;
    if (!viewer?.pagesCount) return;
    const location = this.#location ?? { pageNumber: 1, top: null, left: null };
    viewer.scrollPageIntoView({
      pageNumber: Math.min(location.pageNumber, viewer.pagesCount),
      destArray: [null, { name: "XYZ" }, location.left, location.top, null],
      allowNegativeOffset: true,
    });
  }

  state(): PdfViewState {
    return { kind: "pdf", location: this.#location, scale: this.#scale, query: this.query, outline: false };
  }

  // -- page

  goToPage(page: number): void {
    this.#readerMoves();
    const viewer = this.#parts?.viewer;
    if (!viewer?.pagesCount || !Number.isFinite(page)) return;
    viewer.currentPageNumber = Math.min(Math.max(1, Math.round(page)), this.pageCount);
  }

  previousPage(): void {
    this.#readerMoves();
    this.#parts?.viewer.previousPage();
  }

  nextPage(): void {
    this.#readerMoves();
    this.#parts?.viewer.nextPage();
  }

  // -- zoom

  get zoomValue(): number | null {
    const viewer = this.#parts?.viewer;
    return viewer?.pagesCount ? viewer.currentScale : null;
  }

  get fitted(): boolean {
    return this.#scale === "page-width";
  }

  canZoom(dir: 1 | -1): boolean {
    const scale = this.zoomValue;
    return scale !== null && canZoom(PDF_ZOOMS, scale, dir);
  }

  zoom(dir: 1 | -1): void {
    this.#readerMoves();
    const scale = this.zoomValue;
    if (scale !== null) this.#setScale(zoomStep(PDF_ZOOMS, scale, dir));
  }

  fitWidth(): void {
    this.#readerMoves();
    this.#setScale("page-width");
  }

  #setScale(scale: PdfScale): void {
    const viewer = this.#parts?.viewer;
    if (!viewer?.pagesCount) return;
    this.#scale = scale;
    viewer.currentScaleValue = String(scale);
    this.#onChange();
  }

  // -- search

  search(query: string): void {
    this.#readerMoves();
    this.#quietFind = false;
    this.query = query;
    if (!query.trim()) {
      this.#parts?.eventBus.dispatch("findbarclose", { source: this });
      this.count = { current: 0, total: 0, pending: false };
      this.#onChange();
      return;
    }
    this.#dispatchFind("");
  }

  findAgain(previous: boolean): void {
    this.#readerMoves();
    if (!this.query.trim()) return;
    this.#quietFind = false;
    this.#dispatchFind("again", previous);
  }

  #dispatchFind(type: "" | "again", previous = false): void {
    this.#parts?.eventBus.dispatch("find", {
      source: this,
      type,
      query: this.query.trim(),
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }

  // -- outline

  async #readOutline(): Promise<void> {
    const doc = this.#doc!;
    let raw: RawOutline[] = [];
    try {
      raw = ((await doc.getOutline()) ?? []) as RawOutline[];
    } catch {
      // A broken outline is no outline; the document still reads.
    }
    const items: OutlineItem[] = [];
    const dests: (string | unknown[] | null)[] = [];
    const pages: (number | null)[] = [];
    const walk = async (nodes: RawOutline[], level: 1 | 2) => {
      for (const node of nodes) {
        let page: number | null = null;
        try {
          const dest = typeof node.dest === "string" ? await doc.getDestination(node.dest) : node.dest;
          if (Array.isArray(dest) && dest[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1;
        } catch {
          // An entry whose destination is broken stays, without a page.
        }
        items.push({ title: node.title, level });
        dests.push(node.dest);
        pages.push(page);
        if (node.items.length && level === 1) await walk(node.items, 2);
      }
    };
    await walk(raw, 1);
    if (this.#destroyed) return;
    this.outline = items;
    this.#outlineDests = dests;
    this.#outlinePages = pages;
  }

  get currentOutlineIndex(): number {
    return currentEntry(this.#outlinePages, this.page);
  }

  goToOutline(index: number): void {
    this.#readerMoves();
    const dest = this.#outlineDests[index];
    if (dest) void this.#parts?.linkService.goToDestination(dest as never);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#unwatch?.();
    clearTimeout(this.#settle);
    this.#abort.abort();
    this.#parts?.viewer.setDocument(null as never);
    this.#parts?.linkService.setDocument(null, null);
    void this.#task?.destroy();
    this.#element.replaceChildren();
  }
}

/**
 * The one string pdf.js's viewer components show a reader, each page's
 * accessible name (`pdfjs-page-landmark`), in the interface language; every
 * other one belongs to parts of pdf.js's own application this viewer does
 * not use. In place of its `GenericL10n`, which speaks English only here.
 */
export function viewerL10n(pageLabel: (page: number) => string) {
  const translate = async (element: HTMLElement) => {
    for (const node of [element, ...element.querySelectorAll<HTMLElement>("[data-l10n-id]")]) {
      if (node.getAttribute("data-l10n-id") !== "pdfjs-page-landmark") continue;
      let page = Number.NaN;
      try {
        page = Number((JSON.parse(node.getAttribute("data-l10n-args") ?? "{}") as { page?: unknown }).page);
      } catch {
        // Not pdf.js's arguments: no name rather than a wrong one.
      }
      if (Number.isFinite(page)) node.setAttribute("aria-label", pageLabel(page));
    }
  };
  return {
    getLanguage: () => document.documentElement.lang || "en",
    getDirection: () => "ltr",
    get: async (_ids: unknown, _args: unknown, fallback?: string) => fallback ?? "",
    translate,
    translateOnce: translate,
    destroy: async () => {},
    pause: () => {},
    resume: () => {},
  };
}

/**
 * The find controller's private flag of a pending scroll to the selected
 * match, which `quietScroll` clears. pdf.js has no option for it; the test
 * of this file asserts the pinned release still has it, so an upgrade that
 * drops it fails there first.
 */
export const SCROLL_FLAG = "_scrollMatches";

/**
 * The find controller scrolls to its first match as soon as a query is set;
 * a query restored on load must leave the reader where they were, so while
 * `quiet()` holds the scroll is skipped and its pending flag cleared (else
 * pdf.js would scroll at the next page drawn). Without the flag (another
 * pdf.js) nothing is changed and a restored query moves the view: the
 * viewer puts it back once the search settles (`updatefindcontrolstate`),
 * but pdf.js may still scroll to the match when its page is first drawn,
 * later. A warning says so; the test of this file fails first. Returns
 * whether it took effect.
 */
export function quietScroll(findController: PDFFindController, quiet: () => boolean): boolean {
  const controller = findController as unknown as Record<string, unknown> & PDFFindController;
  if (typeof controller[SCROLL_FLAG] !== "boolean") {
    console.warn(`document viewer: PDFFindController has no ${SCROLL_FLAG}; a restored search may move the view`);
    return false;
  }
  const scrollMatch = findController.scrollMatchIntoView.bind(findController);
  findController.scrollMatchIntoView = (args) => {
    if (quiet()) {
      controller[SCROLL_FLAG] = false;
      return;
    }
    scrollMatch(args);
  };
  return true;
}
