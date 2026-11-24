/**
 * The document viewer's toolbar (DESIGN.md, "The document viewer"): the
 * outline toggle, the page (a PDF's: previous, an editable "x / n", next),
 * the zoom (out, the value, in, and fit to width for a PDF), and the search
 * field with its count and its two arrows. Nothing to download, print or
 * open: a document provided during an evaluation is read here.
 *
 * It reads the view itself (`DocView`) and drives it; the viewer keeps the
 * outline panel and the search query, which outlive a view.
 *
 * Every control is a toggle, a step or a field, never the screen's action:
 * the accent stays the host's (the player's "Hand in"), so a pressed toggle
 * is the neutral ink chip, not the accent one.
 */
import { ChevronDown, ChevronUp, MoveHorizontal, Search, TableOfContents, ZoomIn, ZoomOut } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { controlSize, fieldPillClass } from "@quiz/ui";

import { useI18n } from "../i18n";
import { cx, IconButton, percent, TextInput } from "../ui";
import type { DocView } from "./view";
import { parsePageInput, type DocumentKind } from "./viewState";

/** A toggle pressed in the ink's direction, never the accent's. */
const NEUTRAL_PRESSED =
  "aria-pressed:bg-surface-3 aria-pressed:text-fg aria-expanded:bg-surface-3 aria-expanded:text-fg";

/**
 * The page arrows step aside on a phone (under 24 rem of viewer): the page
 * field and the scroll reach every page, and the toolbar keeps to one row
 * above the search.
 */
const STEP_ARROW = "@max-[24rem]/doc-viewer:hidden";

export interface DocumentToolbarProps {
  kind: DocumentKind;
  /** The view, null until it is built. */
  view: DocView | null;
  outlineOpen: boolean;
  outlineId: string;
  onToggleOutline: () => void;
  query: string;
  onQuery: (text: string) => void;
  onSearchKey: (event: KeyboardEvent<HTMLInputElement>) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Hands the focus back to the document (Escape in the page field). */
  focusDocument: () => void;
}

export function DocumentToolbar({
  kind,
  view,
  outlineOpen,
  outlineId,
  onToggleOutline,
  query,
  onQuery,
  onSearchKey,
  searchRef,
  focusDocument,
}: DocumentToolbarProps) {
  const { t, locale } = useI18n();
  const countId = useId();
  const pdf = kind === "pdf";
  const zoomValue = view?.zoomValue ?? null;
  const { current, total, pending } = view?.count ?? { current: 0, total: 0, pending: false };
  const count = !query.trim() || (pending && !total)
    ? ""
    : total
      ? t("docs.search.count", { current: current || 1, total })
      : t("docs.search.none");

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
      <IconButton
        tipSide="bottom"
        size="md"
        label={t("docs.outline")}
        aria-expanded={outlineOpen}
        aria-controls={outlineId}
        onClick={onToggleOutline}
        className={NEUTRAL_PRESSED}
      >
        <TableOfContents />
      </IconButton>

      {pdf ? (
        <div className="flex items-center gap-0.5 border-l border-line pl-1">
          <IconButton
            tipSide="bottom"
            size="md"
            label={t("docs.page.previous")}
            disabled={!view?.pageCount || view.page <= 1}
            onClick={() => view?.previousPage()}
            className={STEP_ARROW}
          >
            <ChevronUp />
          </IconButton>
          <PageField view={view} focusDocument={focusDocument} />
          <IconButton
            tipSide="bottom"
            size="md"
            label={t("docs.page.next")}
            disabled={!view?.pageCount || view.page >= view.pageCount}
            onClick={() => view?.nextPage()}
            className={STEP_ARROW}
          >
            <ChevronDown />
          </IconButton>
        </div>
      ) : null}

      <div className="flex items-center gap-0.5 border-l border-line pl-1">
        <IconButton
          tipSide="bottom"
          size="md"
          label={t(pdf ? "docs.zoom.out" : "docs.zoom.textOut")}
          disabled={!view?.canZoom(-1)}
          onClick={() => view?.zoom(-1)}
        >
          <ZoomOut />
        </IconButton>
        <span aria-live="polite" className="min-w-10 text-center text-[13px] tabular-nums text-fg-muted">
          {zoomValue !== null ? percent(zoomValue, locale) : ""}
        </span>
        <IconButton
          tipSide="bottom"
          size="md"
          label={t(pdf ? "docs.zoom.in" : "docs.zoom.textIn")}
          disabled={!view?.canZoom(1)}
          onClick={() => view?.zoom(1)}
        >
          <ZoomIn />
        </IconButton>
        {pdf ? (
          <IconButton
            tipSide="bottom"
            size="md"
            label={t("docs.zoom.fit")}
            aria-pressed={view?.fitted ?? false}
            disabled={zoomValue === null}
            onClick={() => view?.fitWidth()}
            className={NEUTRAL_PRESSED}
          >
            <MoveHorizontal />
          </IconButton>
        ) : null}
      </div>

      <div
        role="search"
        className={cx(
          fieldPillClass,
          controlSize.md.height,
          "ml-auto flex min-w-48 flex-[0_1_18rem] items-center gap-0.5 pl-3 pr-1",
          "@max-[32.5rem]:ml-0 @max-[32.5rem]:basis-full",
        )}
      >
        <Search aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
        <input
          ref={searchRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={t("docs.search.placeholder")}
          aria-label={t("docs.search")}
          aria-describedby={countId}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onSearchKey}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-fg outline-none placeholder:text-fg-faint [&::-webkit-search-cancel-button]:hidden"
        />
        <span
          id={countId}
          aria-live="polite"
          className={cx("whitespace-nowrap px-1 text-xs tabular-nums", total || !count ? "text-fg-faint" : "text-warning")}
        >
          {count}
        </span>
        <IconButton tipSide="bottom" size="xs" label={t("docs.search.previous")} disabled={!total} onClick={() => view?.findAgain(true)}>
          <ChevronUp />
        </IconButton>
        <IconButton tipSide="bottom" size="xs" label={t("docs.search.next")} disabled={!total} onClick={() => view?.findAgain(false)}>
          <ChevronDown />
        </IconButton>
      </div>
    </div>
  );
}

/**
 * The page field of a PDF: the current page, or what the reader types into
 * it. Enter (or leaving it) goes to that page, clamped to the document;
 * Escape puts the current page back and hands the focus to the document.
 */
function PageField({ view, focusDocument }: { view: DocView | null; focusDocument: () => void }) {
  const { t } = useI18n();
  const totalId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [text, setTextState] = useState<string | null>(null);
  // Read by `go`, which the blur of an Escape calls before a re-render.
  const draft = useRef<string | null>(null);
  const setText = (value: string | null) => {
    draft.current = value;
    setTextState(value);
  };
  const pageCount = view?.pageCount ?? 0;

  const go = () => {
    const page = view && draft.current !== null ? parsePageInput(draft.current, view.pageCount) : null;
    if (view && page !== null) view.goToPage(page);
    setText(null);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      go();
      field.current?.select();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setText(null);
      focusDocument();
    }
  };

  return (
    <div className="flex items-center gap-1 text-[13px] tabular-nums text-fg-muted">
      <TextInput
        ref={field}
        size="sm"
        inputMode="numeric"
        autoComplete="off"
        aria-label={t("docs.page")}
        aria-describedby={totalId}
        disabled={!pageCount}
        value={pageCount ? (text ?? String(view?.page ?? "")) : ""}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => {
          setText(String(view?.page ?? ""));
          requestAnimationFrame(() => field.current?.select());
        }}
        onBlur={go}
        className="w-14 text-center tabular-nums"
      />
      <span id={totalId} className="whitespace-nowrap">
        {pageCount ? t("docs.page.of", { total: pageCount }) : ""}
      </span>
    </div>
  );
}
