/**
 * The documents an evaluation provides, beside the questions (ADR-144 §7,
 * F-LIVE-15; DESIGN.md, "The documents panel"). The product owner's
 * validated mockup is the reference for its behaviour.
 *
 * A **Documents** button in the player's dock, above the calculator's and
 * the notepad's (it closes neither), opens the panel:
 *   - from 900 px, a SPLIT view: the questions on the left, the panel a
 *     fixed column on the right under the player's bar, whose clock and
 *     "Hand in" stay over the questions (the player scrolls the
 *     window, so the column is fixed, not a flex sibling), a draggable
 *     separator between — pointer, ←/→ (Shift for larger steps), Home/End,
 *     a double click back to 46 % of the window; the panel keeps 360 px, the
 *     questions 420 px. The docks and the player's questions move left of
 *     it (`--tool-dock-inset`);
 *   - under 900 px, an OVERLAY under the player's bar, which Escape puts
 *     away;
 *   - FULL SCREEN, a CSS layer on the same node (never the browser's
 *     Fullscreen API: a kiosk or Safe Exam Browser is full screen already),
 *     built as the player's expand layer: the clock, the save state and one
 *     primary action, "Back to the questions". Escape leaves it.
 *
 * One tab per document (its kind's icon and its title, `Tabs`), a strip
 * that scrolls, with a menu of them once they do not all fit; the viewer's
 * own toolbar below. Ctrl/⌘+F while the panel is open
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
 * pause and the close events carry no list, so the panel hides while the
 * attempt is paused, and `useAttempt` reads the attempt view again at the
 * resume. A 404 from a document's route marks that document "not
 * available" in its tab and asks the host to read the attempt again
 * (`onGone`): a list without it drops its tab, an empty one hides the
 * panel, and a list that still holds it leaves the mark — its file is
 * missing (a staging copy holds the rows only). The files are read by the viewer from the
 * routes the host names — the attempt's for a student, the course's staff
 * routes for the teacher's stateless preview — never navigated to.
 */
import { BookOpenText, ChevronDown, FileCode2, FileText, FileX, Maximize2, X } from "lucide-react";
import {
  useCallback,
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
import {
  Button,
  cx,
  EmptyState,
  IconButton,
  LAYER_BACKDROP,
  Menu,
  QueryError,
  Spinner,
  TabPanel,
  Tabs,
  ToolDockButton,
  useLayer,
  useMinWidth,
  useScrollLock,
  Z,
} from "../ui";
import { loadPanel, savePanel, type PanelState } from "./documentsStore";
import { ExpandStatus } from "./ExpandLayer";

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
  /** A route answered 404: the host reads the attempt view again. */
  onGone?: () => void;
}

/** The tabs' and the panels' ids (`Tabs`, `TabPanel`). */
const ID_PREFIX = "docs";

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
  persist,
  hidden,
  slot,
  offset,
}: {
  attemptId: string;
  documents: PlayerDocuments;
  /** Keep the state in this tab's storage; false keeps it in memory (the preview, an impersonation). */
  persist: boolean;
  /** The attempt may not read now whatever the list says: the evaluation is paused, or over. */
  hidden: boolean;
  /** Its place in the dock's stack, above the other tools. */
  slot: number;
  offset: string;
}) {
  const t = useT();
  const { list, routes } = documents;
  const [panel, setPanel] = useState<PanelState>(() => loadPanel(attemptId, persist));
  // Each viewer's reading state changes as the student scrolls: kept here,
  // written with the rest, never a render of its own.
  const docStates = useRef<Record<string, unknown>>(panel.docs);
  // The documents a route answered 404 for, kept while the list holds them.
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(new Set());
  const visible = list.length > 0 && !hidden;
  useEffect(() => {
    if (!visible) setUnavailable(new Set());
  }, [visible]);

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
  const onGone = (id: string) => {
    setUnavailable((ids) => new Set(ids).add(id));
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
          unavailable={unavailable}
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
  unavailable,
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
  unavailable: ReadonlySet<string>;
  onGone: (id: string) => void;
}) {
  const t = useT();
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
    style.setProperty("--tool-dock-inset", `${width}px`);
    return () => void style.removeProperty("--tool-dock-inset");
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
  const kindIcon = (doc: ProvidedDocument) => (doc.kind === "pdf" ? FileText : FileCode2);

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
        <header className="flex shrink-0 items-stretch">
          <Tabs
            value={active.id}
            onChange={select}
            idPrefix={ID_PREFIX}
            label={t("docs.player.title")}
            truncate
            className="min-w-0 flex-1 pl-2"
            items={list.map((doc) => ({ value: doc.id, label: doc.title, icon: kindIcon(doc) }))}
            trailing={(overflows) =>
              overflows ? (
                <Menu
                  label={t("docs.player.all")}
                  trigger={
                    <IconButton label={t("docs.player.all")}>
                      <ChevronDown />
                    </IconButton>
                  }
                  items={list.map((doc) => ({ label: doc.title, icon: kindIcon(doc), onSelect: () => select(doc.id) }))}
                />
              ) : null
            }
          />
          {/* The hairline under the strip runs on under the controls. */}
          <div className="flex shrink-0 items-center gap-1 border-b border-line pr-2 pl-1">
            {full ? (
              <>
                <div className="flex items-center gap-3 pr-1">
                  <ExpandStatus />
                </div>
                <Button variant="primary" size="sm" onClick={() => update({ full: false })}>
                  {t("docs.player.back")}
                </Button>
              </>
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
          </div>
        </header>
        <div className={cx("relative min-h-0 flex-1", resizing && "pointer-events-none")}>
          {list
            .filter((doc) => mounted.includes(doc.id))
            .map((doc) => (
              <TabPanel
                key={doc.id}
                idPrefix={ID_PREFIX}
                value={doc.id}
                className={cx("absolute inset-0", doc.id !== active.id && "invisible")}
              >
                {unavailable.has(doc.id) ? (
                  doc.id === active.id ? (
                    <div className="grid h-full place-items-center px-4">
                      <EmptyState icon={FileX} title={t("docs.player.gone")} />
                    </div>
                  ) : null
                ) : (
                  <ProvidedViewer
                    document={doc}
                    routes={routes}
                    active={doc.id === active.id}
                    initialState={docStates.current[doc.id]}
                    onState={(state) => {
                      docStates.current[doc.id] = state;
                      onStateChange();
                    }}
                    onGone={() => onGone(doc.id)}
                    handle={(handle) => viewers.current.set(doc.id, handle)}
                  />
                )}
              </TabPanel>
            ))}
        </div>
      </section>
    </>
  );
}

/** Under full screen: the page dimmed, its scroll locked, as under the expand layer. */
function FullScreenBackdrop() {
  useScrollLock();
  return <div aria-hidden className={cx("fixed inset-0", LAYER_BACKDROP, Z.modal)} />;
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
