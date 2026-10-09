/**
 * The exam integrity journal, from the student's side (F-EVAL-13): leaving
 * the evaluation page is journaled and the student is told so, in a toast
 * that informs and never blocks. Nothing here is proof of anything, and
 * nothing here ever stands in the student's way.
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
 */
import { useCallback, useEffect } from "react";

import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import type { Report } from "./signals";

/** An absence shorter than this is a slip (a notification, a mis-click): no toast. */
export const AWAY_NOTICE_MS = 1_000;
/** At most one toast of each kind per attempt in this interval. */
export const NOTICE_INTERVAL_MS = 5 * 60_000;

/** What the student can be told about. */
export type IntegrityKind = "focus";

const NOTICE: Record<IntegrityKind, keyof Dict> = {
  focus: "player.integrity.focus",
};

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
 * least {@link AWAY_NOTICE_MS}.
 *
 * An absence starts as the tab hides or the window really loses the focus,
 * and ends as the tab shows or the window gets the focus back, whichever
 * comes first. A blur that only moved the focus into an iframe of the page
 * (a question's embedded content) is not one: the focus has settled after
 * the blur's own tick, so the check runs on the next. From inside such an
 * iframe, leaving for another application raises nothing on this page, so
 * that absence is only caught if the tab hides.
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
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(settle);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [report, journaled, notify, notice]);
}
