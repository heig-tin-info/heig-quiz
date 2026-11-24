/**
 * What the toolbar and the host read of a viewer, the PDF one and the
 * Markdown one alike. A view owns its scroll element and its reading state;
 * it calls `onChange` whenever something the toolbar shows, or the state,
 * has changed.
 */
import type { OutlineItem } from "./outline";
import type { DocumentKind, DocumentViewState } from "./viewState";

export interface SearchCount {
  /** 1-based; 0 when nothing is selected. */
  current: number;
  total: number;
  /** The PDF is still being searched: the count may grow. */
  pending: boolean;
}

export type ViewStatus = "loading" | "ready" | "failed";

export interface ViewOptions {
  /** The scroll element the view draws into (absolutely positioned, for pdf.js). */
  element: HTMLDivElement;
  onChange: () => void;
  /** Whether the viewer is on screen: a hidden one never records a position. */
  isActive: () => boolean;
  /** The accessible name of a PDF page ("Page 3"), in the interface language. */
  pageLabel: (page: number) => string;
  /** The document could not be loaded: what failed (pdf.js's error, its `status` for an HTTP one). */
  onFailed?: (error: unknown) => void;
}

export interface DocView {
  readonly kind: DocumentKind;
  readonly status: ViewStatus;
  /** The current page and the page count of a PDF; 0 for Markdown. */
  readonly page: number;
  readonly pageCount: number;
  /** The scale (PDF) or the text size (Markdown), 1 = 100 %; null before the first layout. */
  readonly zoomValue: number | null;
  /** The PDF follows the viewer's width. */
  readonly fitted: boolean;
  readonly query: string;
  readonly count: SearchCount;
  /** Null while it is being read. */
  readonly outline: OutlineItem[] | null;
  readonly currentOutlineIndex: number;
  load(): Promise<void>;
  canZoom(dir: 1 | -1): boolean;
  zoom(dir: 1 | -1): void;
  fitWidth(): void;
  goToPage(page: number): void;
  previousPage(): void;
  nextPage(): void;
  search(query: string): void;
  findAgain(previous: boolean): void;
  goToOutline(index: number): void;
  /** Puts the kept position back in view, at the current width and zoom. */
  restore(): void;
  /** The reading state, outline aside (the outline panel is the component's). */
  state(): DocumentViewState;
  destroy(): void;
}

/** Calls `fn` on a real, non-zero change of `element`'s size; returns the disconnect. */
export function watchSize(element: HTMLElement, fn: () => void): () => void {
  let last = "";
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width === 0 || height === 0) return;
    const key = `${Math.round(width)}x${Math.round(height)}`;
    if (key === last) return;
    last = key;
    fn();
  });
  observer.observe(element);
  return () => observer.disconnect();
}
