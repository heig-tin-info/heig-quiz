/**
 * The notepad's place on the player (ADR-090): a `ToolDock` — the round
 * button at the bottom right, above the calculator's when both are on — and
 * the non-modal panel above it, as wide as the scientific calculator's.
 *
 * Plain text only: no markdown, no toolbar, nothing rendered — a monospace
 * page with a hairline under each line, as on a ruled pad. Up to
 * {@link MAX_PAGES} pages of {@link MAX_PAGE_LENGTH} characters; the page
 * controls sit at the bottom: delete, previous, "Page x of y", next, new.
 * Deleting asks nothing: a toast offers to undo it (a page that held nothing
 * is simply gone).
 *
 * `noClipboard` (`provided_no_clipboard`) blocks copy, cut, paste and drag
 * IN the notepad only; the answer fields keep theirs. Otherwise a copy out
 * of it is one of the page's own copies for the integrity journal
 * (`attempt/integrity.ts`, ADR-088 §4): pasting it into an answer is not
 * journaled, while a paste into it from outside is.
 *
 * Closed, it stays mounted (`keepMounted`); it opens with focus in the
 * page. Nothing of it reaches the server.
 */
import { ChevronLeft, ChevronRight, FilePlus, NotebookPen, Trash2, X } from "lucide-react";
import { useEffect, useRef, type SyntheticEvent } from "react";

import { useT } from "../i18n";
import { useToast } from "../notify";
import { areaClass, cx, IconButton, ToolDock, type ToolDockSeat } from "../ui";
import { MAX_PAGE_LENGTH, MAX_PAGES } from "./store";
import type { Notepad } from "./useNotepad";

/** The `beforeinput` kinds a blocked clipboard refuses, beside the plain events. */
const CLIPBOARD_INPUTS = new Set([
  "insertFromPaste",
  "insertFromPasteAsQuotation",
  "insertFromDrop",
  "insertFromYank",
  "deleteByCut",
  "deleteByDrag",
]);

const block = (event: SyntheticEvent) => event.preventDefault();

export function NotepadDock({
  notepad,
  noClipboard,
  seat,
}: {
  notepad: Notepad;
  noClipboard: boolean;
  seat: ToolDockSeat;
}) {
  const t = useT();
  const toast = useToast();
  const page = useRef<HTMLTextAreaElement>(null);
  const { pages, page: index, saveFailed } = notepad;
  // React's `onBeforeInput` is a polyfill without `inputType`: the native
  // event is the one that names a paste, a drop or a cut.
  useEffect(() => {
    const field = page.current;
    if (!noClipboard || !field) return;
    const refuse = (event: InputEvent) => {
      if (CLIPBOARD_INPUTS.has(event.inputType)) event.preventDefault();
    };
    field.addEventListener("beforeinput", refuse);
    return () => field.removeEventListener("beforeinput", refuse);
  }, [noClipboard]);

  const clipboard = noClipboard
    ? { onCopy: block, onCut: block, onPaste: block, onDragStart: block, onDrop: block }
    : {};

  const remove = () => {
    const undo = notepad.deletePage();
    if (undo) toast(t("notepad.deleted"), "info", { key: "notepad:delete", action: { label: t("notepad.undo"), run: undo } });
    page.current?.focus();
  };

  return (
    <ToolDock
      icon={NotebookPen}
      openLabel={t("notepad.open")}
      closeLabel={t("notepad.close")}
      offset="var(--player-footer-h,0px)"
      panelClassName="flex h-[30rem] w-[22rem] flex-col p-3"
      keepMounted
      {...seat}
      onOpen={() => page.current?.focus()}
    >
      {(close, titleId) => (
        <>
          <div className="mb-2 flex items-center gap-2 pl-1">
            <h2 id={titleId} className="text-[13px] font-semibold">
              {t("notepad.title")}
            </h2>
            {noClipboard ? <span className="text-[12px] text-fg-faint">{t("notepad.noClipboard")}</span> : null}
            <span className="ml-auto">
              <IconButton label={t("notepad.close")} size="sm" onClick={close}>
                <X />
              </IconButton>
            </span>
          </div>
          <textarea
            ref={page}
            aria-label={t("notepad.page", { n: index + 1, total: pages.length })}
            value={pages[index] ?? ""}
            maxLength={MAX_PAGE_LENGTH}
            onChange={(event) => notepad.setText(event.target.value)}
            spellCheck={false}
            {...clipboard}
            // The field's chrome (`areaClass`), in the code face and ruled.
            // The whole panel is this one field: focused, its border turns
            // to the ink rather than the accent's red frame and ring.
            className={cx(
              areaClass,
              "notepad-ruled min-h-0 w-full flex-1 resize-none pb-1 font-mono !text-[13px] focus:!border-fg focus:!ring-0",
            )}
          />
          {saveFailed ? (
            <p role="status" className="mt-1.5 text-[12px] leading-snug text-warning">
              {t("notepad.saveFailed")}
            </p>
          ) : null}
          <div className="mt-2 flex items-center gap-1">
            <IconButton label={t("notepad.delete")} size="sm" onClick={remove}>
              <Trash2 />
            </IconButton>
            <span className="flex-1" />
            <IconButton label={t("notepad.previous")} size="sm" disabled={index === 0} onClick={() => notepad.go(-1)}>
              <ChevronLeft />
            </IconButton>
            <span className="min-w-[6.5rem] text-center text-[12px] tabular-nums text-fg-muted" aria-live="polite">
              {t("notepad.page", { n: index + 1, total: pages.length })}
            </span>
            <IconButton
              label={t("notepad.next")}
              size="sm"
              disabled={index >= pages.length - 1}
              onClick={() => notepad.go(1)}
            >
              <ChevronRight />
            </IconButton>
            <span className="flex-1" />
            <IconButton
              label={pages.length >= MAX_PAGES ? t("notepad.full", { n: MAX_PAGES }) : t("notepad.new")}
              size="sm"
              disabled={pages.length >= MAX_PAGES}
              onClick={() => {
                notepad.newPage();
                page.current?.focus();
              }}
            >
              <FilePlus />
            </IconButton>
          </div>
        </>
      )}
    </ToolDock>
  );
}
