import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import type { PoolSubscribers as Subscribers } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { poolSubscribersKey } from "../queryKeys";
import { Card, QueryError, SectionHeading, Skeleton } from "../ui";

/**
 * "Subscribers (N)" in the Settings tab of a public pool (ADR-095): the
 * teachers who follow it, by name only — no avatar, no address — and with
 * nothing to remove: a subscriber would read the public pool anyway. Told to
 * the owner and the members; the pool's detail carries the count (`null`
 * for anyone else), so the section is not drawn for them.
 */
export function PoolSubscribers({ poolId, count }: { poolId: string; count: number }) {
  const t = useT();
  const list = useQuery<Subscribers>({
    queryKey: poolSubscribersKey(poolId),
    queryFn: () => api(`/app/api/pools/${poolId}/subscribers`),
  });
  return (
    <section className="space-y-3">
      <SectionHeading title={t("share.subscribers", { n: count })} />
      <Card className="px-5 py-3">
        <p className="text-xs text-fg-muted">{t("share.subscribers.help")}</p>
        {list.isLoading ? (
          <Skeleton className="mt-3 h-6 w-48" />
        ) : list.isError ? (
          <div className="mt-3">
            <QueryError title={t("share.subscribers", { n: count })} query={list} />
          </div>
        ) : list.data!.subscribers.length === 0 ? (
          <p className="mt-3 text-sm text-fg-muted">{t("share.subscribers.empty")}</p>
        ) : (
          <ul className="mt-2">
            {list.data!.subscribers.map((s, i) => (
              <li key={i} className="flex items-center gap-2 border-t border-line py-2 text-sm first:border-t-0">
                <Bell aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
                <span className="min-w-0 truncate">{s.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
