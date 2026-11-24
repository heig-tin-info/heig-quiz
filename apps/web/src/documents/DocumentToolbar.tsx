/**
 * The document viewer's toolbar (DESIGN.md, "The document viewer"): the
 * outline toggle, the page (a PDF's: previous, an editable "x / n", next),
 * the zoom (out, the value, in, and fit to width for a PDF), and the search
 * field with its count and its two arrows. Nothing to download, print or
 * open: a document provided during an evaluation is read here.
 *
 * Every control is a toggle, a step or a field, never the screen's action:
 * the accent stays the host's (the player's "Hand in"), so a pressed toggle
 * is the neutral ink chip, not the accent one.
 */
import { ChevronDown, ChevronUp, MoveHorizontal, Search, TableOfContents, ZoomIn, ZoomOut } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";

import { controlSize } from "@quiz/ui";

import { useI18n } from "../i18n";
import { cx, IconButton, percent, TextInput } from "../ui";
import type { DocumentKind } from "./viewState";
import type { SearchCount } from "./view";

/** A toggle pressed in the ink's direction, never the accent's. */
const NEUTRAL_PRESSED =
  "aria-pressed:bg-surface-3 aria-pressed:text-fg aria-expanded:bg-surface-3 aria-expanded:text-fg";

/** What the toolbar shows of the viewer. */
export interface ToolbarState {
  kind: DocumentKind;
  page: number;
  pageCount: number;
  zoomValue: number | null;
  canZoomIn: boolean;
  canZoomOut: boolean;
  fitted: boolean;
  count: SearchCount;
  outlineOpen: boolean;
}

export interface ToolbarActions {
  onToggleOutline: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onZoom: (dir: 1 | -1) => void;
  onFitWidth: () => void;
  onFindAgain: (previous: boolean) => void;
}

export interface ToolbarFields {
  outlineId: string;
  /** The page field: its text while the reader types, the current page otherwise. */
  pageText: string;
  onPageText: (text: string) => void;
  onPageKey: (event: KeyboardEvent<HTMLInputElement>) => void;
  onPageFocus: () => void;
  onPageBlur: () => void;
  pageRef: RefObject<HTMLInputElement | null>;
  query: string;
  /** Whether a search was run on the query (the count speaks of it). */
  searched: boolean;
  onQuery: (text: string) => void;
  onSearchKey: (event: KeyboardEvent<HTMLInputElement>) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  countId: string;
  pageTotalId: string;
}

export function DocumentToolbar({ state, actions, fields }: { state: ToolbarState; actions: ToolbarActions; fields: ToolbarFields }) {
  const { t, locale } = useI18n();
  const pdf = state.kind === "pdf";
  const ready = state.zoomValue !== null;
  const { current, total, pending } = state.count;
  const count = !fields.query.trim() || !fields.searched
    ? ""
    : total
      ? t("docs.search.count", { current: current || 1, total })
      : pending
        ? ""
        : t("docs.search.none");

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
      <IconButton
        size="md"
        label={t("docs.outline")}
        aria-expanded={state.outlineOpen}
        aria-controls={fields.outlineId}
        onClick={actions.onToggleOutline}
        className={NEUTRAL_PRESSED}
      >
        <TableOfContents />
      </IconButton>

      {pdf ? (
        <div className="flex items-center gap-0.5 border-l border-line pl-1.5">
          <IconButton
            size="md"
            label={t("docs.page.previous")}
            disabled={!state.pageCount || state.page <= 1}
            onClick={actions.onPreviousPage}
          >
            <ChevronUp />
          </IconButton>
          <div className="flex items-center gap-1 text-[13px] tabular-nums text-fg-muted">
            <TextInput
              ref={fields.pageRef}
              size="sm"
              inputMode="numeric"
              autoComplete="off"
              aria-label={t("docs.page")}
              aria-describedby={fields.pageTotalId}
              disabled={!state.pageCount}
              value={state.pageCount ? fields.pageText : ""}
              onChange={(e) => fields.onPageText(e.target.value)}
              onKeyDown={fields.onPageKey}
              onFocus={fields.onPageFocus}
              onBlur={fields.onPageBlur}
              className="w-14 text-center tabular-nums"
            />
            <span id={fields.pageTotalId} className="whitespace-nowrap">
              {state.pageCount ? t("docs.page.of", { total: state.pageCount }) : ""}
            </span>
          </div>
          <IconButton
            size="md"
            label={t("docs.page.next")}
            disabled={!state.pageCount || state.page >= state.pageCount}
            onClick={actions.onNextPage}
          >
            <ChevronDown />
          </IconButton>
        </div>
      ) : null}

      <div className="flex items-center gap-0.5 border-l border-line pl-1.5">
        <IconButton
          size="md"
          label={t(pdf ? "docs.zoom.out" : "docs.zoom.textOut")}
          disabled={!state.canZoomOut}
          onClick={() => actions.onZoom(-1)}
        >
          <ZoomOut />
        </IconButton>
        <span aria-live="polite" className="min-w-12 text-center text-[13px] tabular-nums text-fg-muted">
          {ready ? percent(state.zoomValue!, locale) : ""}
        </span>
        <IconButton
          size="md"
          label={t(pdf ? "docs.zoom.in" : "docs.zoom.textIn")}
          disabled={!state.canZoomIn}
          onClick={() => actions.onZoom(1)}
        >
          <ZoomIn />
        </IconButton>
        {pdf ? (
          <IconButton
            size="md"
            label={t("docs.zoom.fit")}
            aria-pressed={state.fitted}
            disabled={!ready}
            onClick={actions.onFitWidth}
            className={NEUTRAL_PRESSED}
          >
            <MoveHorizontal />
          </IconButton>
        ) : null}
      </div>

      <div
        role="search"
        className={cx(
          controlSize.md.height,
          "ml-auto flex min-w-48 flex-[0_1_18rem] items-center gap-0.5 rounded-control border border-line-strong bg-surface pl-3 pr-1",
          "transition-colors focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20 hover:border-fg-faint",
          "@max-[32.5rem]:ml-0 @max-[32.5rem]:basis-full",
        )}
      >
        <Search aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
        <input
          ref={fields.searchRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={fields.query}
          placeholder={t("docs.search.placeholder")}
          aria-label={t("docs.search")}
          aria-describedby={fields.countId}
          onChange={(e) => fields.onQuery(e.target.value)}
          onKeyDown={fields.onSearchKey}
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-fg outline-none placeholder:text-fg-faint [&::-webkit-search-cancel-button]:hidden"
        />
        <span
          id={fields.countId}
          aria-live="polite"
          className={cx("whitespace-nowrap px-1 text-xs tabular-nums", total || !count ? "text-fg-faint" : "text-warning")}
        >
          {count}
        </span>
        <IconButton size="xs" label={t("docs.search.previous")} disabled={!total} onClick={() => actions.onFindAgain(true)}>
          <ChevronUp />
        </IconButton>
        <IconButton size="xs" label={t("docs.search.next")} disabled={!total} onClick={() => actions.onFindAgain(false)}>
          <ChevronDown />
        </IconButton>
      </div>
    </div>
  );
}
