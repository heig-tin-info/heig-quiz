/**
 * The Markdown viewer: a document rendered by the server
 * (`packages/docrender`, safe by construction: raw HTML was escaped there)
 * in the journal's long-form type (`.md-body.md-doc`), with a text size the
 * student picks, an outline from the server's table of contents, and a
 * search painted over the text (`highlight.ts`).
 *
 * The position is kept as an anchor — the first block not yet scrolled
 * past, and the fraction of it above the top of the view — so after a
 * reflow (another width, another text size) the same passage is on top.
 *
 * A link in the document never leaves it: an in-page anchor scrolls the
 * viewer, any other link is inert. The viewer may sit in an exam's tab.
 */
import { createPainter, type MatchPainter } from "./highlight";
import { currentEntry, markdownOutline, type OutlineItem, type TocEntry } from "./outline";
import { findTextMatches } from "./search";
import { type DocView, type SearchCount, type ViewOptions, type ViewStatus, watchSize } from "./view";
import { canZoom, MARKDOWN_ZOOMS, type MarkdownAnchor, type MarkdownViewState, zoomStep } from "./viewState";

/** Under this distance from an edge, a match is not "in view": the next one scrolls it to a third of the height. */
const MATCH_MARGIN = 24;
/** A heading reached from the outline sits this far under the top. */
const HEADING_GAP = 12;

export class MdView implements DocView {
  readonly kind = "markdown";
  status: ViewStatus = "loading";
  readonly page = 0;
  readonly pageCount = 0;
  readonly fitted = false;
  query: string;
  count: SearchCount = { current: 0, total: 0, pending: false };
  outline: OutlineItem[] | null = null;

  readonly #html: string;
  readonly #toc: readonly TocEntry[];
  readonly #element: HTMLDivElement;
  readonly #onChange: () => void;
  readonly #isActive: () => boolean;
  readonly #article: HTMLElement;
  readonly #painter: MatchPainter;
  #anchor: MarkdownAnchor | null;
  #zoom: number;
  #headings: (HTMLElement | null)[] = [];
  #ranges: Range[] = [];
  #current = -1;
  readonly #abort = new AbortController();
  #unwatch: (() => void) | null = null;
  #frame = 0;
  /** Where `restore` last put the scroll, until the reader moves it. */
  #placed: number | null = null;

  constructor(html: string, toc: readonly TocEntry[], { element, onChange, isActive }: ViewOptions, saved: MarkdownViewState) {
    this.#html = html;
    this.#toc = toc;
    this.#element = element;
    this.#onChange = onChange;
    this.#isActive = isActive;
    this.#anchor = saved.anchor;
    this.#zoom = saved.zoom;
    this.query = saved.query;
    this.#article = document.createElement("article");
    this.#article.className = "md-body md-doc doc-md";
    this.#painter = createPainter(this.#article);
  }

  async load(): Promise<void> {
    const article = this.#article;
    // The server's rendering, as the journal's reader shows it (`JournalArticle`).
    article.innerHTML = this.#html;
    article.style.setProperty("--doc-zoom", String(this.#zoom));
    this.#element.append(article);
    const { items, ids } = markdownOutline(this.#toc);
    this.outline = items;
    this.#headings = ids.map((id) => article.querySelector<HTMLElement>(`#${CSS.escape(id)}`));

    const signal = this.#abort.signal;
    this.#element.addEventListener("scroll", () => this.#onScroll(), { passive: true, signal });
    article.addEventListener("click", (event) => this.#onClick(event), { signal });
    this.#unwatch = watchSize(this.#element, () => this.restore());

    if (this.query) this.#find(false);
    this.restore();
    this.status = "ready";
    this.#onChange();
  }

  #onScroll(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      // The scroll `restore` made is not the reader's: the anchor stays
      // exact, never rounded to the pixel at each reflow.
      if (!this.#isActive() || this.#element.scrollTop === this.#placed) return;
      this.#placed = null;
      this.#anchor = this.#anchorNow();
      this.#onChange();
    });
  }

  #onClick(event: MouseEvent): void {
    const link = (event.target as Element | null)?.closest?.("a");
    if (!link || !this.#article.contains(link)) return;
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (!href.startsWith("#")) return;
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // Not encoded: the id as written.
    }
    const target = id ? this.#article.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
    if (target) this.#scrollToElement(target);
  }

  /** The first block not yet scrolled past, and how far into it the top of the view is. */
  #anchorNow(): MarkdownAnchor | null {
    const blocks = this.#article.children;
    if (!blocks.length) return null;
    const top = this.#element.scrollTop;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as HTMLElement;
      // Negative above the first block (the article's top padding).
      if (block.offsetTop + block.offsetHeight > top) {
        return { block: i, fraction: (top - block.offsetTop) / Math.max(1, block.offsetHeight) };
      }
    }
    return { block: blocks.length - 1, fraction: 1 };
  }

  restore(): void {
    const anchor = this.#anchor;
    const blocks = this.#article.children;
    if (!anchor || !blocks.length) return;
    const block = blocks[Math.min(anchor.block, blocks.length - 1)] as HTMLElement;
    this.#element.scrollTop = block.offsetTop + anchor.fraction * block.offsetHeight;
    this.#placed = this.#element.scrollTop;
  }

  state(): MarkdownViewState {
    return { kind: "markdown", anchor: this.#anchor, zoom: this.#zoom, query: this.query, outline: false };
  }

  // -- page: a Markdown document has none

  goToPage(): void {}
  previousPage(): void {}
  nextPage(): void {}
  fitWidth(): void {}

  // -- zoom: the text size

  get zoomValue(): number {
    return this.#zoom;
  }

  canZoom(dir: 1 | -1): boolean {
    return canZoom(MARKDOWN_ZOOMS, this.#zoom, dir);
  }

  zoom(dir: 1 | -1): void {
    // The passage on top stays on top through the reflow.
    const anchor = this.#isActive() ? this.#anchorNow() : this.#anchor;
    this.#zoom = zoomStep(MARKDOWN_ZOOMS, this.#zoom, dir);
    this.#article.style.setProperty("--doc-zoom", String(this.#zoom));
    this.#anchor = anchor;
    this.restore();
    this.#onChange();
  }

  // -- search

  search(query: string): void {
    this.query = query;
    this.#find(true);
  }

  #find(scroll: boolean): void {
    this.#painter.clear();
    this.#ranges = this.#painter.paint(findTextMatches(this.#article, this.query));
    // The current match: the first one at or below the top of the view.
    let current = -1;
    if (this.#ranges.length) {
      const top = this.#element.getBoundingClientRect().top;
      current = this.#ranges.findIndex((r) => r.getBoundingClientRect().top >= top - 1);
      if (current < 0) current = 0;
    }
    this.#select(current, scroll);
  }

  findAgain(previous: boolean): void {
    const n = this.#ranges.length;
    if (!n) return;
    this.#select((this.#current + (previous ? n - 1 : 1)) % n, true);
  }

  #select(index: number, scroll: boolean): void {
    this.#current = index;
    this.count = { current: index + 1, total: this.#ranges.length, pending: false };
    this.#painter.select(index);
    const range = this.#ranges[index];
    if (scroll && range) {
      const r = range.getBoundingClientRect();
      const box = this.#element.getBoundingClientRect();
      if (r.top < box.top + MATCH_MARGIN || r.bottom > box.bottom - MATCH_MARGIN) {
        this.#element.scrollTop += r.top - box.top - box.height / 3;
      }
      this.#anchor = this.#anchorNow();
    }
    this.#onChange();
  }

  // -- outline

  get currentOutlineIndex(): number {
    return currentEntry(
      this.#headings.map((h) => (h ? h.offsetTop : null)),
      // A heading reached from the outline counts as entered.
      this.#element.scrollTop + HEADING_GAP + 4,
    );
  }

  goToOutline(index: number): void {
    const heading = this.#headings[index];
    if (heading) this.#scrollToElement(heading);
  }

  #scrollToElement(target: HTMLElement): void {
    this.#element.scrollTop = target.offsetTop - HEADING_GAP;
    this.#anchor = this.#anchorNow();
    this.#onChange();
  }

  destroy(): void {
    this.#abort.abort();
    this.#unwatch?.();
    cancelAnimationFrame(this.#frame);
    this.#painter.clear();
    this.#article.remove();
  }
}
