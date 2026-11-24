/**
 * One document — a PDF, or a Markdown document the server rendered — with
 * its toolbar (outline, page, zoom, search) and its outline panel
 * (DESIGN.md, "The document viewer").
 *
 * The viewer is never an iframe: the document is part of the page, so a
 * copy made in it is a copy of the page for the integrity journal
 * (ADR-088). It fills its parent (a flex column of its own) and adapts to
 * the width it is given, down to a 400 px panel.
 *
 * State. The viewer starts from `initialState` (read through
 * `readViewState`: a kept state is never trusted) and reports every change
 * of its reading state through `onStateChange` — position, zoom, query and
 * whether the outline is open — so a host can put the document back exactly
 * where it was after a remount. `active={false}` hides it IN PLACE (its
 * pages and its scroll stay; it records nothing and takes no focus), so a
 * host may keep several mounted and show one.
 *
 * Keyboard. Ctrl+F (⌘+F) inside the viewer focuses its search, and so does
 * the handle's `focusSearch()` for a host that takes the shortcut wider.
 * In the search field Enter goes to the next match and Shift+Enter to the
 * previous one; Escape hands the focus back to the document (the query and
 * its highlights stay) and calls `onSearchEscape`.
 */
import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";

import { useT } from "../i18n";
import { Button, cx, Spinner } from "../ui";
import { DocumentToolbar } from "./DocumentToolbar";
import { MdView } from "./MdView";
import { outlineTree, type OutlineNode, type TocEntry } from "./outline";
import { PdfView } from "./PdfView";
import type { DocView } from "./view";
import { MAX_QUERY, parsePageInput, readViewState, sameViewState, type DocumentViewState } from "./viewState";

export type DocumentSource =
  | { kind: "pdf"; url: string }
  /** HTML rendered and made safe by `packages/docrender`, and its table of contents. */
  | { kind: "markdown"; html: string; toc: readonly TocEntry[] };

export interface DocumentViewerHandle {
  /** Focuses the search field and selects its text (a host's Ctrl+F). */
  focusSearch(): void;
  /** Focuses the document itself (its scroll area). */
  focusDocument(): void;
  /** The reading state now. */
  state(): DocumentViewState;
}

/** A Markdown search runs once the reader pauses; pdf.js waits on its own. */
const MARKDOWN_SEARCH_DELAY = 120;
/** At this width or under, the outline covers the document, and folds once used. */
const NARROW_OUTLINE = 520;

export interface DocumentViewerProps {
  source: DocumentSource;
  /** The document's name: the accessible name of its reading area. */
  title: string;
  /** What a host kept of an earlier mount, in any shape (it is checked). */
  initialState?: unknown;
  onStateChange?: (state: DocumentViewState) => void;
  /** False: hidden in place, its position and its pages kept. */
  active?: boolean;
  /** Escape in the search field gave the focus back to the document. */
  onSearchEscape?: () => void;
  ref?: Ref<DocumentViewerHandle>;
}

/** The viewer of one source: another source is another viewer, from its own kept state. */
export function DocumentViewer(props: DocumentViewerProps) {
  const { source } = props;
  return <Viewer key={source.kind === "pdf" ? `pdf:${source.url}` : `md:${source.html}`} {...props} />;
}

function Viewer({ source, title, initialState, onStateChange, active = true, onSearchEscape, ref }: DocumentViewerProps) {
  const t = useT();
  const ids = useId();
  const outlineId = `${ids}-outline`;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<DocView | null>(null);

  // The kept state is read once: a host that passes back what it was told
  // must not restart the view at every change.
  const [initial] = useState(() => readViewState(source.kind, initialState));

  const [outlineOpen, setOutlineOpen] = useState(initial.outline);
  const [query, setQuery] = useState(initial.query);
  const [pageText, setPageText] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const tRef = useRef(t);
  tRef.current = t;
  const activeRef = useRef(active);
  activeRef.current = active;
  const outlineRef = useRef(outlineOpen);
  outlineRef.current = outlineOpen;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const reported = useRef<DocumentViewState | null>(null);

  /** The state now, the outline included; reported to the host when it changed. */
  const currentState = useCallback((): DocumentViewState => {
    const view = viewRef.current;
    const state = view ? view.state() : initial;
    return { ...state, outline: outlineRef.current };
  }, [initial]);
  const report = useCallback(() => {
    if (!activeRef.current) return;
    const state = currentState();
    if (reported.current && sameViewState(reported.current, state)) return;
    reported.current = state;
    onStateChangeRef.current?.(state);
  }, [currentState]);

  // The view: one per mount (`DocumentViewer` keys a new source to a new
  // viewer), destroyed with it. Its changes are coalesced to one render, and
  // one report, per frame.
  useEffect(() => {
    const element = scrollRef.current!;
    let frame = 0;
    const onChange = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((n) => n + 1);
        report();
      });
    };
    const options = {
      element,
      onChange,
      isActive: () => activeRef.current,
      pageLabel: (page: number) => tRef.current("docs.page.landmark", { page }),
    };
    const view: DocView =
      source.kind === "pdf"
        ? new PdfView(source.url, options, initial as Extract<DocumentViewState, { kind: "pdf" }>)
        : new MdView(source.html, source.toc, options, initial as Extract<DocumentViewState, { kind: "markdown" }>);
    viewRef.current = view;
    reported.current = { ...initial };
    void view.load();
    return () => {
      cancelAnimationFrame(frame);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Shown again: back to the kept position, at the width it has now.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      const frame = requestAnimationFrame(() => viewRef.current?.restore());
      wasActive.current = active;
      return () => cancelAnimationFrame(frame);
    }
    wasActive.current = active;
    return undefined;
  }, [active]);

  useEffect(report, [outlineOpen, report]);

  // The reader types; the search follows (at once for a PDF, after a pause for Markdown).
  const searchTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);
  const onQuery = (text: string) => {
    const value = text.slice(0, MAX_QUERY);
    setQuery(value);
    window.clearTimeout(searchTimer.current);
    const view = viewRef.current;
    if (!view) return;
    if (view.kind === "pdf") view.search(value);
    else searchTimer.current = window.setTimeout(() => view.search(value), MARKDOWN_SEARCH_DELAY);
  };

  const focusDocument = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), []);
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);
  useImperativeHandle(ref, () => ({ focusSearch, focusDocument, state: currentState }), [focusSearch, focusDocument, currentState]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const view = viewRef.current;
    if (event.key === "Enter") {
      event.preventDefault();
      window.clearTimeout(searchTimer.current);
      if (!view) return;
      if (view.query !== query) view.search(query);
      else view.findAgain(event.shiftKey);
    } else if (event.key === "Escape") {
      // Back to the document; the query and its highlights stay.
      event.preventDefault();
      event.stopPropagation();
      focusDocument();
      onSearchEscape?.();
    }
  };

  const goToPageText = () => {
    const view = viewRef.current;
    const page = view ? parsePageInput(pageText ?? "", view.pageCount) : null;
    if (view && page !== null) view.goToPage(page);
    setPageText(null);
  };
  const onPageKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToPageText();
      pageRef.current?.select();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setPageText(null);
      focusDocument();
    }
  };

  const onRootKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      focusSearch();
    }
  };

  const view = viewRef.current;
  const status = view?.status ?? "loading";
  const outline = view?.outline ?? null;
  const tree = useMemo(() => (outline ? outlineTree(outline) : []), [outline]);
  const narrow = () => {
    const width = rootRef.current?.clientWidth ?? 0;
    return width > 0 && width <= NARROW_OUTLINE;
  };

  const goToOutline = (index: number) => {
    viewRef.current?.goToOutline(index);
    // In a narrow viewer the outline covers the page: it folds once used.
    if (narrow()) setOutlineOpen(false);
  };
  const onOutlineKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && narrow()) {
      event.preventDefault();
      event.stopPropagation();
      setOutlineOpen(false);
      focusDocument();
    }
  };

  return (
    <div
      ref={rootRef}
      onKeyDown={onRootKey}
      inert={!active}
      className={cx("@container/doc-viewer flex h-full min-h-0 flex-col bg-surface", !active && "invisible")}
    >
      <DocumentToolbar
        state={{
          kind: source.kind,
          page: view?.page ?? 0,
          pageCount: view?.pageCount ?? 0,
          zoomValue: view?.zoomValue ?? null,
          canZoomIn: view?.canZoom(1) ?? false,
          canZoomOut: view?.canZoom(-1) ?? false,
          fitted: view?.fitted ?? false,
          count: view?.count ?? { current: 0, total: 0, pending: false },
          outlineOpen,
        }}
        actions={{
          onToggleOutline: () => setOutlineOpen((open) => !open),
          onPreviousPage: () => viewRef.current?.previousPage(),
          onNextPage: () => viewRef.current?.nextPage(),
          onZoom: (dir) => viewRef.current?.zoom(dir),
          onFitWidth: () => viewRef.current?.fitWidth(),
          onFindAgain: (previous) => viewRef.current?.findAgain(previous),
        }}
        fields={{
          outlineId,
          pageText: pageText ?? String(view?.page ?? ""),
          onPageText: setPageText,
          onPageKey,
          onPageFocus: () => {
            setPageText(String(viewRef.current?.page ?? ""));
            requestAnimationFrame(() => pageRef.current?.select());
          },
          onPageBlur: goToPageText,
          pageRef,
          query,
          searched: view?.query === query,
          onQuery,
          onSearchKey,
          searchRef,
          countId: `${ids}-count`,
          pageTotalId: `${ids}-total`,
        }}
      />
      <div className="relative flex min-h-0 flex-1">
        <nav
          id={outlineId}
          aria-label={t("docs.outline")}
          hidden={!outlineOpen}
          onKeyDown={onOutlineKey}
          className={cx(
            "w-60 shrink-0 overflow-auto border-r border-line bg-surface-2 px-2 py-3 text-[13px]",
            "@max-[32.5rem]/doc-viewer:absolute @max-[32.5rem]/doc-viewer:inset-y-0 @max-[32.5rem]/doc-viewer:left-0 @max-[32.5rem]/doc-viewer:z-10 @max-[32.5rem]/doc-viewer:w-[min(16rem,85%)] @max-[32.5rem]/doc-viewer:shadow-popover",
          )}
        >
          {outline === null ? (
            <p className="px-2 py-1 text-fg-faint">{t("docs.loading")}</p>
          ) : outline.length === 0 ? (
            <p className="px-2 py-1 text-fg-faint">{t("docs.outline.empty")}</p>
          ) : (
            <OutlineList nodes={tree} current={view?.currentOutlineIndex ?? -1} onGo={goToOutline} open={outlineOpen} />
          )}
        </nav>
        <div className="relative min-w-0 flex-1 bg-surface-2">
          <div
            ref={scrollRef}
            tabIndex={0}
            role="region"
            aria-label={title}
            aria-busy={status === "loading"}
            className={cx(
              "absolute inset-0 overflow-auto focus-visible:outline-offset-[-2px]",
              source.kind === "pdf" ? "doc-pdf" : "bg-surface",
            )}
          />
          {status === "loading" ? (
            <div className="absolute inset-0 grid place-items-center">
              <Spinner label={t("docs.loading")} className="" />
            </div>
          ) : status === "failed" ? (
            <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-sm text-fg-muted">{t("docs.failed")}</p>
              <Button variant="secondary" size="sm" onClick={() => void viewRef.current?.load()}>
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The outline as nested lists; the entry being read is marked, and kept in sight. */
function OutlineList({
  nodes,
  current,
  onGo,
  open,
}: {
  nodes: OutlineNode[];
  current: number;
  onGo: (index: number) => void;
  open: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // The panel scrolls, never the page around it (`scrollIntoView` would).
  useEffect(() => {
    const panel = listRef.current?.parentElement;
    const entry = listRef.current?.querySelector('[aria-current="true"]');
    if (!open || !panel || !entry) return;
    const box = panel.getBoundingClientRect();
    const rect = entry.getBoundingClientRect();
    if (rect.top < box.top) panel.scrollTop -= box.top - rect.top + 8;
    else if (rect.bottom > box.bottom) panel.scrollTop += rect.bottom - box.bottom + 8;
  }, [current, open]);
  const entry = (node: OutlineNode, nested: boolean) => (
    <li key={node.index}>
      <button
        type="button"
        aria-current={node.index === current ? "true" : undefined}
        onClick={() => onGo(node.index)}
        className={cx(
          "block w-full rounded-lg px-2 py-1 text-left leading-snug transition-colors hover:bg-surface-3 hover:text-fg",
          nested ? "text-xs text-fg-muted" : "text-fg",
          "aria-[current=true]:bg-surface-3 aria-[current=true]:font-semibold aria-[current=true]:text-fg",
        )}
      >
        {node.item.title}
      </button>
      {node.children.length ? <ul className="pl-3">{node.children.map((child) => entry(child, true))}</ul> : null}
    </li>
  );
  return <ul ref={listRef}>{nodes.map((node) => entry(node, false))}</ul>;
}
