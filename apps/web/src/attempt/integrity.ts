/**
 * The exam integrity journal, from the student's side (F-EVAL-13, ADR-088):
 * leaving the evaluation page, and pasting a text that was not copied on it,
 * are journaled and the student is told so, in a toast that informs and
 * never blocks. Nothing here is proof of anything, and nothing here ever
 * stands in the student's way.
 *
 * What is sent keeps the journal's existing shape (`AttemptEventBody`):
 * `visibility {state}` on every change of the tab's visibility, `focus
 * {focused:false}` as the window loses the focus and `focus {focused:true}`
 * as it gets it back. Each is sent AT ONCE, never late and never
 * backdated: the server times every entry on receipt (invariant 5), so the
 * length of an absence — and the rule that one under a second is not worth
 * the teacher's attention — is read from the server's times, by the
 * teacher's view. The client measures an absence for one thing only: whether
 * the student's own toast is worth showing.
 *
 * A paste sends `paste {length}` and nothing else: never the text, and never
 * whether the page had lost the focus, which the server reads from its own
 * journal (ADR-088 §4).
 */
import { useCallback, useEffect } from "react";

import { PASTE_MAX_LENGTH } from "@quiz/contracts";

import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import type { Report } from "./signals";

/** An absence shorter than this is a slip (a notification, a mis-click): no toast. */
export const AWAY_NOTICE_MS = 1_000;
/** At most one toast of each kind per attempt in this interval. */
export const NOTICE_INTERVAL_MS = 5 * 60_000;

/** A pasted text shorter than this (whitespace collapsed) is a word, not a passage. */
const PASTE_MIN_LENGTH = 20;
/** How many of the page's latest copies a paste is compared with. */
const COPIES_KEPT = 5;

/** What the student can be told about. */
export type IntegrityKind = "focus" | "paste";

const NOTICE: Record<IntegrityKind, keyof Dict> = {
  focus: "player.integrity.focus",
  paste: "player.integrity.paste",
};

/**
 * The texts copied, cut or dragged on this page, latest last, in memory and
 * in this tab only (a copy from another Quiz tab looks external; ADR-088
 * §1). Each copy keeps what the selection showed and what the clipboard was
 * given, which an editor such as CodeMirror may write differently.
 */
const copies: string[][] = [];

/** The comparison form of a text: whitespace collapsed, ends trimmed. */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text selected on the page, a form field's included. */
function selectedText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const { selectionStart, selectionEnd } = el;
    if (selectionStart !== null && selectionEnd !== null) return el.value.slice(selectionStart, selectionEnd);
  }
  return document.getSelection()?.toString() ?? "";
}

/** The plain text a clipboard (copy, cut, paste) or drag (dragstart, drop) event carries. */
const carried = (event: Event) =>
  ((event as ClipboardEvent).clipboardData ?? (event as DragEvent).dataTransfer)?.getData("text/plain") ?? "";

/** Whether `text` (normalized) is, or is part of, a recent copy of this page. */
const copiedHere = (text: string) => copies.some((variants) => variants.some((v) => v.includes(text)));

/**
 * When an attempt last showed a toast of each kind. Module-level on purpose:
 * the limit must survive a remount of the player (Home and back, a retake
 * screen), which a ref would not.
 */
const lastNotice = new Map<string, number>();

/**
 * Tells the student about one kind of event, at most once per
 * {@link NOTICE_INTERVAL_MS} per kind and attempt: a toast at the top right,
 * informative, dismissable, gone by itself.
 */
export function useIntegrityNotice(attemptId: string): (kind: IntegrityKind) => void {
  const toast = useToast();
  const t = useT();
  return useCallback(
    (kind) => {
      const key = `${attemptId}:${kind}`;
      const now = Date.now();
      const last = lastNotice.get(key);
      if (last !== undefined && now - last < NOTICE_INTERVAL_MS) return;
      lastNotice.set(key, now);
      toast(t(NOTICE[kind]), "info", { corner: "top", key: `integrity:${kind}` });
    },
    [attemptId, toast, t],
  );
}

/**
 * Journals the page being left and the return to it while `journaled`, and
 * tells the student, when `notify`, as they come back from an absence of at
 * least {@link AWAY_NOTICE_MS}. Journals as well a paste or a drop of a text
 * of at least {@link PASTE_MIN_LENGTH} characters that none of the page's
 * {@link COPIES_KEPT} latest copies holds, and tells the student at once.
 * The listeners only read: an editor (CodeMirror, a form field) still gets
 * the paste, which is never prevented.
 *
 * An absence starts as the tab hides or the window really loses the focus,
 * and ends as the tab shows or the window gets the focus back, whichever
 * comes first. A blur that only moved the focus into an iframe of the page
 * (a question's embedded content) is not one: the focus has settled after
 * the blur's own tick, so the check runs on the next. From inside such an
 * iframe, leaving for another application raises nothing on this page, so
 * that absence is only caught if the tab hides, and a paste there is not
 * seen at all.
 */
export function useIntegrityJournal(
  attemptId: string,
  report: Report,
  { journaled, notify }: { journaled: boolean; notify: boolean },
): void {
  const notice = useIntegrityNotice(attemptId);

  useEffect(() => {
    if (!journaled) return;
    let awaySince: number | null = null;
    // A `focused:false` went out: its `focused:true` is owed.
    let blurred = false;
    let settle: ReturnType<typeof setTimeout> | undefined;

    const leave = () => {
      awaySince ??= Date.now();
    };
    const arrive = () => {
      if (awaySince === null) return;
      const away = Date.now() - awaySince;
      awaySince = null;
      if (notify && away >= AWAY_NOTICE_MS) notice("focus");
    };
    const onVisibility = () => {
      report({ kind: "visibility", details: { state: document.visibilityState } });
      if (document.visibilityState === "hidden") leave();
      else arrive();
    };
    const onBlur = () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement) return;
        blurred = true;
        report({ kind: "focus", details: { focused: false } });
        leave();
      }, 0);
    };
    const onFocus = () => {
      clearTimeout(settle);
      if (blurred) {
        blurred = false;
        report({ kind: "focus", details: { focused: true } });
      }
      arrive();
    };
    // A copy is read twice: before the page's own handlers, from the
    // selection, and after them, from what they gave the clipboard.
    let copying: string[] | null = null;
    const onCopyStart = (event: Event) => {
      // A drag carries its text from the start; a copy's clipboard is still empty.
      copying = [normalize(carried(event) || selectedText())];
      copies.push(copying);
      if (copies.length > COPIES_KEPT) copies.shift();
    };
    const onCopyEnd = (event: Event) => {
      const given = normalize(carried(event));
      if (copying !== null && given !== "" && !copying.includes(given)) copying.push(given);
      copying = null;
    };
    const onInsert = (event: Event) => {
      const text = carried(event);
      const normalized = normalize(text);
      if (normalized.length < PASTE_MIN_LENGTH || copiedHere(normalized)) return;
      report({ kind: "paste", details: { length: Math.min(text.length, PASTE_MAX_LENGTH) } });
      if (notify) notice("paste");
    };
    // Every listener, once: [target, event, handler, capture phase].
    const listeners: [EventTarget, string, (event: Event) => void, boolean][] = [
      [document, "visibilitychange", onVisibility, false],
      [window, "blur", onBlur, false],
      [window, "focus", onFocus, false],
      [document, "copy", onCopyStart, true],
      [document, "cut", onCopyStart, true],
      [document, "dragstart", onCopyStart, true],
      [window, "copy", onCopyEnd, false],
      [window, "cut", onCopyEnd, false],
      [document, "paste", onInsert, true],
      [document, "drop", onInsert, true],
    ];
    for (const [target, type, handler, capture] of listeners) target.addEventListener(type, handler, capture);
    return () => {
      clearTimeout(settle);
      for (const [target, type, handler, capture] of listeners) target.removeEventListener(type, handler, capture);
    };
  }, [report, journaled, notify, notice]);
}
