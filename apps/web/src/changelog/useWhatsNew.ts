import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { ChangelogList, Me } from "@quiz/contracts";

import { api } from "../api";
import { changelogUnseenKey } from "../queryKeys";

/**
 * The entries live since the reader's last acknowledgement, and the
 * acknowledgement. Asked only by the account's own portal session out of the
 * student view, which is a teacher's preview of their seat (ADR-018); the
 * server sends nothing to any other session anyway. `pending` holds while
 * they load or wait to be read: the coach waits for them.
 */
export function useWhatsNew(me: Me | null | undefined, studentView: boolean) {
  const qc = useQueryClient();
  const enabled = me != null && (me.session?.kind ?? "portal") === "portal" && !studentView;
  const unseen = useQuery({
    queryKey: changelogUnseenKey,
    queryFn: () => api<ChangelogList>("/app/api/changelog/unseen"),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  // Closed is read, whatever closed it: the dialog goes at once, and a lost
  // acknowledgement only shows the same entries on the next visit.
  const acknowledge = useCallback(() => {
    qc.setQueryData<ChangelogList>(changelogUnseenKey, []);
    void api("/app/api/me/changelog", { method: "POST" }).catch(() => {});
  }, [qc]);
  const entries = enabled ? (unseen.data ?? []) : [];
  return { entries, pending: enabled && (unseen.isPending || entries.length > 0), acknowledge };
}
