import { useQueryClient } from "@tanstack/react-query";

import { useNotify } from "./notify";
import { useEventStream } from "./realtime/useEventStream";

/**
 * Live updates over SSE (no WebSocket — ADR-005). The hint frame is a refresh
 * hint, never data: on any hint we invalidate the active queries and TanStack
 * Query refetches through the authorized endpoints. Reconnection (native to
 * EventSource) also triggers a full refetch — no replay needed.
 *
 * Hints may carry a typed notice; those surface as toasts, filtered by the
 * user's notification preferences.
 *
 * The connection itself is no longer opened here: `realtime/useEventStream`
 * owns the ONE stream of the page, so this hook and the live dashboard's own
 * watcher share a socket instead of holding two (WP8). Everything a screen
 * that only needs hints sees is unchanged.
 */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const notify = useNotify();
  useEventStream({
    enabled,
    onHint: (hint) => {
      void qc.invalidateQueries();
      if (hint.notice) notify(hint.notice.kind, hint.notice.message);
    },
    // On (re)connection everything is refetched: the same full refresh the
    // previous `onopen` did, and the reason no event has to be replayed.
    onRefresh: () => void qc.invalidateQueries(),
  });
}
