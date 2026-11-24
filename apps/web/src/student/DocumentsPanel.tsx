/**
 * The documents an evaluation provides, beside the questions (ADR-144 §7,
 * F-LIVE-15; DESIGN.md, "The documents panel"). The product owner's
 * validated mockup is the reference for its behaviour.
 *
 * A **Documents** button in the player's dock, above the calculator's and
 * the notepad's (it closes neither), opens the panel:
 *   - from 900 px, a SPLIT view: the questions on the left, the panel a
 *     fixed column on the right under the player's bar, which keeps the
 *     clock and "Hand in" across the window (the player scrolls the
 *     window, so the column is fixed, not a flex sibling), a draggable
 *     separator between — pointer, ←/→ (Shift for larger steps), Home/End,
 *     a double click back to 46 % of the window; the panel keeps 360 px, the
 *     questions 420 px. The docks and the player's frame move left of it
 *     (`--tool-dock-inset`, `--docs-inset`);
 *   - under 900 px, an OVERLAY under the player's bar, which Escape puts
 *     away;
 *   - FULL SCREEN, a CSS layer on the same node (never the browser's
 *     Fullscreen API: a kiosk or Safe Exam Browser is full screen already),
 *     built as the player's expand layer: the clock, the save state and one
 *     primary action, "Back to the questions". Escape leaves it.
 *
 * One tab per document (its kind's icon and its title), a strip that
 * scrolls; the viewer's own toolbar below. Ctrl/⌘+F while the panel is open
 * searches the document on screen. Escape: the search first, then the
 * document, then full screen (or the overlay).
 *
 * What the student set — open or not, full screen, the document on screen,
 * the width, each document's position, zoom, search and outline — is kept
 * per attempt (`documentsStore.ts`), in memory only for the teacher's
 * preview and an impersonation. A viewer is mounted once its document is
 * first shown and unmounted when the panel closes or hides: its bytes and
 * its HTML go with it, its reading state stays.
 *
 * The rule is the server's: the list is the attempt view's, `[]` while the
 * attempt may not read (a pause, a hand-in, an expiry, the close). The
 * pause and the close events carry no list, so the host hides the panel
 * while the attempt is paused, and re-reads the attempt view on resume; a
 * 404 from either route hides it at once and asks the host to read the
 * attempt again (`onGone`). The files are read by the viewer from the
 * routes the host names — the attempt's for a student, the course's staff
 * routes for the teacher's stateless preview — never navigated to.
 */
import { BookOpenText, ChevronDown, FileCode2, FileText, Maximize2, X } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";

import { DocumentHtml, type ProvidedDocument } from "@quiz/contracts";

import { api, ApiError } from "../api";
import { DocumentViewer, type DocumentViewerHandle } from "../documents/DocumentViewer";
import { useT } from "../i18n";
import { useToast } from "../notify";
import {
  Button,
  ClockCountdown,
  cx,
  IconButton,
  Menu,
  QueryError,
  Spinner,
  SyncBadge,
  ToolDockButton,
  useLayer,
  useMinWidth,
  useScrollLock,
  Z,
} from "../ui";
import { loadPanel, savePanel, type PanelState } from "./documentsStore";
import { ExpandChrome } from "./ExpandLayer";

/** Where a document's file and rendered HTML are read. */
export interface DocumentRoutes {
  file: (documentId: string) => string;
  html: (documentId: string) => string;
}

/** A student's: the routes of their own attempt, under the read rule (F-LIVE-15). */
export const attemptDocumentRoutes = (attemptId: string): DocumentRoutes => ({
  file: (id) => `/app/api/attempts/${attemptId}/documents/${id}/file`,
  html: (id) => `/app/api/attempts/${attemptId}/documents/${id}/html`,
});

/** The teacher's stateless preview: the course's staff routes (ADR-144 §5, §6). */
export const courseDocumentRoutes = (courseId: string): DocumentRoutes => ({
  file: (id) => `/app/api/courses/${courseId}/documents/${id}/file`,
  html: (id) => `/app/api/courses/${courseId}/documents/${id}/html`,
});

/** What the player hands the panel. */
export interface PlayerDocuments {
  /** The attempt view's list: the documents the attempt may read now, in their order. */
  list: readonly ProvidedDocument[];
  routes: DocumentRoutes;
  /** Keep the state in this tab's storage; false keeps it in memory (the preview, an impersonation). */
  persist: boolean;
  /** A route answered 404: the rule turned false. The host reads the attempt view again. */
  onGone?: () => void;
}

/** The split view's width bounds (the mockup's). */
export const PANEL_MIN = 360;
export const QUESTIONS_MIN = 420;
const DEFAULT_SHARE = 0.46;
/** From this width the panel splits the screen; under it, an overlay. */
export const SPLIT_FROM = 900;

const clampWidth = (width: number, windowWidth: number) =>
  Math.round(Math.min(Math.max(width, PANEL_MIN), Math.max(PANEL_MIN, windowWidth - QUESTIONS_MIN)));

/** The window's width, followed. */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** An HTTP 404, from the API client or from pdf.js (its `ResponseException`). */
const isGone = (error: unknown) =>
  (error instanceof ApiError && error.status === 404) ||
  (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404);

export function DocumentsPanel({
  attemptId,
  documents,
  hidden,
  slot,
  offset,
}: {
  attemptId: string;
  documents: PlayerDocuments;
  /** The attempt may not read now whatever the list says: the evaluation is paused, or over. */
  hidden: boolean;
  /** Its place in the dock's stack, above the other tools. */
  slot: number;
  offset: string;
}) {
  const t = useT();
  const { list, routes, persist } = documents;
  const [panel, setPanel] = useState<PanelState>(() => loadPanel(attemptId, persist));
  // Each viewer's reading state changes as the student scrolls: kept here,
  // written with the rest, never a render of its own.
  const docStates = useRef<Record<string, unknown>>(panel.docs);
  // The list a route answered 404 for: hidden until the host reads a new one.
  const [goneFor, setGoneFor] = useState<readonly ProvidedDocument[] | null>(null);
  const visible = list.length > 0 && !hidden && goneFor !== list;

  const save = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persistLater = useCallback(
    (next: PanelState) => {
      clearTimeout(save.current);
      save.current = setTimeout(
        () =>
          savePanel(attemptId, persist, {
            ...next,
            docs: { ...docStates.current },
          }),
        150,
      );
    },
    [attemptId, persist],
  );
  useEffect(() => persistLater(panel), [panel, persistLater]);
  useEffect(() => () => clearTimeout(save.current), []);

  const update = (change: Partial<PanelState>) => setPanel((current) => ({ ...current, ...change }));
  const open = visible && panel.open;
  const active = list.find((d) => d.id === panel.active) ?? list[0] ?? null;
  const toast = useToast();
  const onGone = () => {
    setGoneFor(list);
    toast(t("docs.player.gone"), "info", { key: "docs:gone" });
    documents.onGone?.();
  };

  const button = useRef<HTMLButtonElement>(null);
  const setOpen = (next: boolean) => {
    update(next ? { open: true } : { open: false, full: false });
    if (!next) button.current?.focus();
  };

  if (!visible) return null;
  return (
    <>
      <ToolDockButton
        buttonRef={button}
        icon={BookOpenText}
        label={open ? t("docs.player.close") : t("docs.player.open")}
        pressed={open}
        onClick={() => setOpen(!open)}
        slot={slot}
        offset={offset}
        dockProps={{ "data-docs-dock": true }}
      />
      {open && active ? (
        <Panel
          list={list}
          active={active}
          routes={routes}
          panel={panel}
          update={update}
          docStates={docStates}
          onStateChange={() => persistLater(panel)}
          onClose={() => setOpen(false)}
          onGone={onGone}
        />
      ) : null}
    </>
  );
}

function Panel({
  list,
  active,
  routes,
  panel,
  update,
  docStates,
  onStateChange,
  onClose,
  onGone,
}: {
  list: readonly ProvidedDocument[];
  active: ProvidedDocument;
  routes: DocumentRoutes;
  panel: PanelState;
  update: (change: Partial<PanelState>) => void;
  docStates: RefObject<Record<string, unknown>>;
  onStateChange: () => void;
  onClose: () => void;
  onGone: () => void;
}) {
  const t = useT();
  const chrome = useContext(ExpandChrome);
  const wide = useMinWidth(SPLIT_FROM);
  const windowWidth = useWindowWidth();
  const full = panel.full;
  const split = wide && !full;
  const width = clampWidth(panel.width ?? windowWidth * DEFAULT_SHARE, windowWidth);
  const root = useRef<HTMLElement>(null);
  const viewers = useRef(new Map<string, DocumentViewerHandle | null>());
  // A viewer is mounted once its document is first shown, and stays while the panel is open.
  const [mounted, setMounted] = useState<string[]>([active.id]);
  useEffect(() => {
    setMounted((ids) => (ids.includes(active.id) ? ids : [...ids, active.id]));
  }, [active.id]);
  const [resizing, setResizing] = useState(false);

  // The docks and the questions move left of the column (split view only).
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    if (!split) return;
    style.setProperty("--docs-inset", `${width}px`);
    style.setProperty("--tool-dock-inset", `${width}px`);
    return () => {
      style.removeProperty("--docs-inset");
      style.removeProperty("--tool-dock-inset");
    };
  }, [split, width]);

  // Full screen is a layer: focus kept inside, Escape handled below.
  useLayer(root, () => update({ full: false }), {
    enabled: full,
    escape: false,
  });

  // Opened: the document itself takes the focus, so the arrows read it.
  useEffect(() => {
    const frame = requestAnimationFrame(() => viewers.current.get(active.id)?.focusDocument());
    return () => cancelAnimationFrame(frame);
  }, []);

  // Ctrl/⌘+F while the panel is open finds in the document on screen, from anywhere on the page.
  const activeId = active.id;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f")
        return;
      event.preventDefault();
      viewers.current.get(activeId)?.focusSearch();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeId]);

  // Escape, once the viewer left it alone (its search and its outline take it first).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (full) {
      event.preventDefault();
      update({ full: false });
    } else if (!wide) {
      event.preventDefault();
      onClose();
    }
  };

  const select = (id: string) => update({ active: id });

  return (
    <>
      {full ? <FullScreenBackdrop /> : null}
      <section
        ref={root}
        aria-label={t("docs.player.title")}
        {...(full ? { role: "dialog", "aria-modal": true } : {})}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-docs-panel=""
        data-docs-split={split ? "" : undefined}
        style={split ? { width } : undefined}
        className={cx(
          "fixed flex flex-col bg-surface focus:outline-none",
          full
            ? cx("inset-4 overflow-hidden rounded-sheet border border-line shadow-overlay", Z.modal)
            : split
              ? cx("top-[calc(var(--banner-h)+var(--bar-h))] right-0 bottom-0 border-l border-line", Z.tool)
              : cx("inset-x-0 bottom-0 top-[calc(var(--banner-h)+var(--bar-h))] shadow-overlay", Z.tool),
          resizing && "select-none",
        )}
      >
        {split ? (
          <Separator
            width={width}
            windowWidth={windowWidth}
            onWidth={(next) => update({ width: clampWidth(next, window.innerWidth) })}
            onResizing={setResizing}
          />
        ) : null}
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line pl-2 pr-2">
          <Tabs list={list} active={active.id} onSelect={select} />
          {full ? (
            <div className="flex shrink-0 items-center gap-3 pl-2">
              {chrome === null || chrome.deadlineAt === null ? null : (
                <ClockCountdown deadlineAt={chrome.deadlineAt} clock={chrome.clock} paused={chrome.paused} />
              )}
              {chrome?.sync === undefined ? null : <SyncBadge state={chrome.sync} />}
              <Button variant="primary" size="sm" onClick={() => update({ full: false })}>
                {t("docs.player.back")}
              </Button>
            </div>
          ) : (
            <>
              <IconButton label={t("docs.player.full")} aria-pressed={false} onClick={() => update({ full: true })}>
                <Maximize2 />
              </IconButton>
              <IconButton label={t("docs.player.close")} onClick={onClose}>
                <X />
              </IconButton>
            </>
          )}
        </header>
        <div className={cx("relative min-h-0 flex-1", resizing && "pointer-events-none")}>
          {list
            .filter((doc) => mounted.includes(doc.id))
            .map((doc) => (
              <div
                key={doc.id}
                id={`docs-panel-${doc.id}`}
                role="tabpanel"
                aria-labelledby={`docs-tab-${doc.id}`}
                className="absolute inset-0"
              >
                <ProvidedViewer
                  document={doc}
                  routes={routes}
                  active={doc.id === active.id}
                  initialState={docStates.current[doc.id]}
                  onState={(state) => {
                    docStates.current[doc.id] = state;
                    onStateChange();
                  }}
                  onGone={onGone}
                  handle={(handle) => viewers.current.set(doc.id, handle)}
                />
              </div>
            ))}
        </div>
      </section>
    </>
  );
}

/** Under full screen: the page dimmed, its scroll locked, as under the expand layer. */
function FullScreenBackdrop() {
  useScrollLock();
  return <div aria-hidden className={cx("fixed inset-0 bg-fg/30 backdrop-blur-[2px]", Z.modal)} />;
}

/**
 * One tab per document: its kind's icon and its title; a strip that
 * scrolls. When the tabs do not all fit (ten of them in a 400 px panel), a
 * menu beside the strip lists every document by its title.
 */
function Tabs({
  list,
  active,
  onSelect,
}: {
  list: readonly ProvidedDocument[];
  active: string;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const strip = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const box = strip.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(box.scrollWidth > box.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [list.length]);
  // The selected tab in sight: the strip scrolls, never the page.
  useEffect(() => {
    const box = strip.current;
    const tab = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !tab) return;
    const left = tab.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft) box.scrollLeft = left - 8;
    else if (left + tab.offsetWidth > box.scrollLeft + box.clientWidth) {
      box.scrollLeft = left + tab.offsetWidth - box.clientWidth + 8;
    }
  }, [active]);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = list.findIndex((d) => d.id === active);
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      Home: -index,
      End: list.length - 1 - index,
    }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = list[(index + step + list.length) % list.length]!;
    onSelect(next.id);
    strip.current?.querySelector<HTMLElement>(`#docs-tab-${CSS.escape(next.id)}`)?.focus();
  };
  return (
    <>
      <div
        ref={strip}
        role="tablist"
        aria-label={t("docs.player.title")}
        onKeyDown={onKey}
        className="flex min-w-0 flex-1 gap-1 self-stretch overflow-x-auto [scrollbar-width:thin]"
      >
        {list.map((doc) => {
          const selected = doc.id === active;
          const Icon = doc.kind === "pdf" ? FileText : FileCode2;
          return (
            <button
              key={doc.id}
              id={`docs-tab-${doc.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`docs-panel-${doc.id}`}
              tabIndex={selected ? 0 : -1}
              title={doc.title}
              onClick={() => onSelect(doc.id)}
              className={cx(
                "relative inline-flex max-w-48 shrink-0 items-center gap-1.5 px-2.5 text-[13px] transition-colors focus-visible:outline-offset-[-2px]",
                selected
                  ? "font-semibold text-fg after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-fg"
                  : "font-medium text-fg-muted hover:text-fg",
              )}
            >
              <Icon className="size-4 shrink-0 text-fg-faint" aria-hidden />
              <span className="truncate">{doc.title}</span>
            </button>
          );
        })}
      </div>
      {overflows ? (
        <Menu
          label={t("docs.player.all")}
          trigger={
            <IconButton label={t("docs.player.all")}>
              <ChevronDown />
            </IconButton>
          }
          items={list.map((doc) => ({
            label: doc.title,
            icon: doc.kind === "pdf" ? FileText : FileCode2,
            onSelect: () => onSelect(doc.id),
          }))}
        />
      ) : null}
    </>
  );
}

/**
 * The separator of the split view (`role="separator"`, the panel's width as
 * its value): a pointer drag, ←/→ by 16 px (64 with Shift) — the separator
 * moves with the arrow, so ← widens the panel —, Home the widest, End the
 * narrowest, a double click back to 46 % of the window.
 */
function Separator({
  width,
  windowWidth,
  onWidth,
  onResizing,
}: {
  width: number;
  windowWidth: number;
  onWidth: (width: number) => void;
  onResizing: (resizing: boolean) => void;
}) {
  const t = useT();
  const max = Math.max(PANEL_MIN, windowWidth - QUESTIONS_MIN);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    onResizing(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging) onWidth(window.innerWidth - event.clientX);
  };
  const stop = () => {
    setDragging(false);
    onResizing(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const next = {
      ArrowLeft: width + step,
      ArrowRight: width - step,
      Home: max,
      End: PANEL_MIN,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onWidth(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("docs.player.resize")}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onWidth(window.innerWidth * DEFAULT_SHARE)}
      className="group absolute inset-y-0 -left-1 z-10 grid w-2 cursor-col-resize touch-none place-items-center focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={cx(
          "h-10 w-1.5 rounded-full transition-[background-color,height] duration-120",
          dragging ? "h-14 bg-fg-faint" : "bg-line-strong group-hover:h-14 group-hover:bg-fg-faint",
          "group-focus-visible:bg-accent group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent",
        )}
      />
    </div>
  );
}

/** One document in its viewer, from the routes the host named. */
function ProvidedViewer({
  document,
  routes,
  active,
  initialState,
  onState,
  onGone,
  handle,
}: {
  document: ProvidedDocument;
  routes: DocumentRoutes;
  active: boolean;
  initialState: unknown;
  onState: (state: unknown) => void;
  onGone: () => void;
  handle: (handle: DocumentViewerHandle | null) => void;
}) {
  const common = {
    title: document.title,
    active,
    initialState,
    onStateChange: onState,
    onLoadError: (error: unknown) => {
      if (isGone(error)) onGone();
    },
    ref: handle,
  };
  if (document.kind === "pdf")
    return <DocumentViewer source={{ kind: "pdf", url: routes.file(document.id) }} {...common} />;
  return <MarkdownViewer url={routes.html(document.id)} onGone={onGone} common={common} />;
}

/** A Markdown document: its HTML, read once and dropped with the viewer (`gcTime: 0`). */
function MarkdownViewer({
  url,
  onGone,
  common,
}: {
  url: string;
  onGone: () => void;
  common: Omit<Parameters<typeof DocumentViewer>[0], "source">;
}) {
  const t = useT();
  const html = useQuery({
    queryKey: ["provided-document-html", url],
    queryFn: async () => DocumentHtml.parse(await api(url)),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const gone = html.isError && isGone(html.error);
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);
  if (html.isPending || gone) {
    return common.active === false ? null : <Spinner label={t("docs.loading")} className="h-full" />;
  }
  if (html.isError) {
    return common.active === false ? null : (
      <div className="grid h-full place-items-center px-4">
        <QueryError title={t("docs.failed")} query={html} />
      </div>
    );
  }
  return <DocumentViewer source={{ kind: "markdown", html: html.data.html, toc: html.data.toc }} {...common} />;
}
