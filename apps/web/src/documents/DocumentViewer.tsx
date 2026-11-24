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

import type { JournalTocEntry } from "@quiz/contracts";

import "./viewer.css";

import { useT } from "../i18n";
import { Button, cx, Spinner } from "../ui";
import { DocumentToolbar } from "./DocumentToolbar";
import { MdView } from "./MdView";
import { outlineTree, type OutlineNode } from "./outline";
import { PdfView } from "./PdfView";
import type { DocView } from "./view";
import { MAX_QUERY, readViewState, sameViewState, type DocumentViewState } from "./viewState";

export type DocumentSource =
  | { kind: "pdf"; url: string }
  /** HTML rendered and made safe by `packages/docrender`, and its table of contents. */
  | { kind: "markdown"; html: string; toc: readonly JournalTocEntry[] };

export interface DocumentViewerHandle {
  /** Focuses the search field and selects its text (a host's Ctrl+F). */
  focusSearch(): void;
  /** Focuses the document itself (its scroll area). */
  focusDocument(): void;
  /** The reading state now. */
  state(): DocumentViewState;
}

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
  /**
   * A PDF could not be loaded: pdf.js's error (an HTTP one carries its
   * `status`). A host that serves documents under a rule (an attempt's,
   * ADR-144 §7) reads a 404 as the rule turning false.
   */
  onLoadError?: (error: unknown) => void;
  ref?: Ref<DocumentViewerHandle>;
}

/** The viewer of one source: another source is another viewer, from its own kept state. */
export function DocumentViewer(props: DocumentViewerProps) {
  const { source } = props;
  return <Viewer key={source.kind === "pdf" ? `pdf:${source.url}` : `md:${source.html}`} {...props} />;
}

function Viewer({ source, title, initialState, onStateChange, active = true, onSearchEscape, onLoadError, ref }: DocumentViewerProps) {
  const t = useT();
  const ids = useId();
  const outlineId = `${ids}-outline`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const viewRef = useRef<DocView | null>(null);

  // The kept state is read once: a host that passes back what it was told
  // must not restart the view at every change.
  const [initial] = useState(() => readViewState(source.kind, initialState));

  const [outlineOpen, setOutlineOpen] = useState(initial.outline);
  const [query, setQuery] = useState(initial.query);
  const [, setTick] = useState(0);

  const tRef = useRef(t);
  tRef.current = t;
  const activeRef = useRef(active);
  activeRef.current = active;
  const outlineRef = useRef(outlineOpen);
  outlineRef.current = outlineOpen;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;
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
      onFailed: (error: unknown) => onLoadErrorRef.current?.(error),
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

  // The reader types; the view searches when it sees fit (pdf.js and
  // `MdView` both wait for a pause, and say so in their count).
  const onQuery = (text: string) => {
    const value = text.slice(0, MAX_QUERY);
    setQuery(value);
    viewRef.current?.search(value);
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
      if (!view) return;
      if (view.query !== query) view.search(query);
      view.findAgain(event.shiftKey);
    } else if (event.key === "Escape") {
      // Back to the document; the query and its highlights stay.
      event.preventDefault();
      event.stopPropagation();
      focusDocument();
      onSearchEscape?.();
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
  // Narrow is what the stylesheet decided: the outline then covers the document.
  const narrow = () => !!navRef.current && getComputedStyle(navRef.current).position === "absolute";

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
      onKeyDown={onRootKey}
      inert={!active}
      className={cx("@container/doc-viewer flex h-full min-h-0 flex-col bg-surface", !active && "invisible")}
    >
      <DocumentToolbar
        kind={source.kind}
        view={view}
        outlineOpen={outlineOpen}
        outlineId={outlineId}
        onToggleOutline={() => setOutlineOpen((open) => !open)}
        query={query}
        onQuery={onQuery}
        onSearchKey={onSearchKey}
        searchRef={searchRef}
        focusDocument={focusDocument}
      />
      <div className="relative flex min-h-0 flex-1">
        <nav
          ref={navRef}
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
