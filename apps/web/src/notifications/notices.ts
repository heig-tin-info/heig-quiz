import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useToast, type ToastTone } from "../notify";

/**
 * A notice a page words from the difference between two reads of its data
 * (F-PROJ-21): what the toast says, its tone, and a `key` per kind so a
 * notice of the same kind replaces the one standing rather than stacking.
 */
export interface Notice {
  key: string;
  message: string;
  tone?: ToastTone;
}

/** A commit of a payload: what the two project pages compare a push by. */
export type Commit = { sha: string } | null;

/** Whether a push landed between two reads: the commit shown changed, or appeared. */
export const pushed = (was: Commit | undefined, now: Commit): boolean => now !== null && now.sha !== was?.sha;

/**
 * Toasts the notices of a page's data as it is re-read (F-PROJ-21, merge
 * task M3-09c). A notice is NOT a notification (ADR-030): nothing comes
 * from the server but the data the page shows anyway, re-read on its
 * interval or on a hint; the notices are computed here, in the browser, by
 * `notices(prev, next)` — a pure function of the page's — and worded
 * through `t()` by it. The toast primitive is the page's own (`useToast`).
 *
 * The rule of the `ToastGate`: the first read after the page mounts is the
 * BASELINE and toasts nothing — cached data shown before that read is not a
 * read (its `dataUpdatedAt` is older than the mount, whatever a failed
 * refetch since says), so coming back to a page never replays what
 * happened while away. A read whose data is unchanged (the same reference,
 * by TanStack's structural sharing) notices nothing. A new query key resets
 * the baseline (`isFetchedAfterMount` false again): the previous page's
 * data is never compared with the next's.
 */
export function useNoticeToasts<T>(
  query: Pick<UseQueryResult<T>, "data" | "dataUpdatedAt" | "isFetchedAfterMount">,
  notices: (prev: T, next: T) => Notice[],
): void {
  const toast = useToast();
  const mountedAt = useRef(Date.now());
  const prev = useRef<T | undefined>(undefined);
  // Read at effect time: the page hands a new arrow each render, which is no change.
  const noticesNow = useRef(notices);
  noticesNow.current = notices;
  const { data, dataUpdatedAt, isFetchedAfterMount } = query;
  useEffect(() => {
    if (!isFetchedAfterMount || data === undefined || dataUpdatedAt < mountedAt.current) {
      prev.current = undefined;
      return;
    }
    const before = prev.current;
    prev.current = data;
    if (before === undefined || before === data) return;
    for (const n of noticesNow.current(before, data)) toast(n.message, n.tone ?? "success", { key: n.key });
  }, [data, dataUpdatedAt, isFetchedAfterMount, toast]);
}
