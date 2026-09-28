import { useQueryClient } from "@tanstack/react-query";

import { useNotificationToasts } from "./notifications/toasts";
import { invalidateHint } from "./realtime/hints";
import { useEventStream } from "./realtime/useEventStream";

/**
 * Live updates over SSE (no WebSocket — ADR-005). The hint frame is a refresh
 * hint, never data: a hint invalidates the queries its kinds may have made
 * stale (`realtime/hints.ts`) and TanStack Query refetches the active ones
 * through the authorized endpoints. Reconnection (native to
 * EventSource) also triggers a full refetch — no replay needed.
 *
 * A hint carries no data, and so nothing to toast: a notification arriving
 * is toasted from the inbox the `notifications` hint makes the bell re-read
 * (`notifications/toasts.ts`, ADR-030 addendum §a). Each open of the stream
 * rebases it, so a reconnect never replays the unread inbox. `quiet` pages
 * (an attempt, a projection, the live dashboard) toast nothing.
 *
 * The connection itself is no longer opened here: `realtime/useEventStream`
 * owns the ONE stream of the page, so this hook and the live dashboard's own
 * watcher share a socket instead of holding two (WP8). Everything a screen
 * that only needs hints sees is unchanged.
 */
export function useLiveUpdates(enabled: boolean, quiet: boolean) {
  const qc = useQueryClient();
  const rebase = useNotificationToasts(quiet);
  useEventStream({
    enabled,
    onHint: (hint) => void invalidateHint(qc, hint.kinds),
    onFirstOpen: rebase,
    onReopen: rebase,
    // On (re)connection everything is refetched: the same full refresh the
    // previous `onopen` did, and the reason no event has to be replayed.
    onRefresh: () => void qc.invalidateQueries(),
  });
}
