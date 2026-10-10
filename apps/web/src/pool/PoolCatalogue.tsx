import { useQuery } from "@tanstack/react-query";
import { BellPlus, Check, Globe } from "lucide-react";
import { useEffect, useState } from "react";

import type { CatalogueQueryInput, PoolSummary } from "@quiz/contracts";

import { api, useMe } from "../api";
import { useT } from "../i18n";
import { poolCatalogueKey } from "../queryKeys";
import type { Route } from "../router";
import { Button, EmptyState, QueryError, SearchInput, Skeleton, Spinner } from "../ui";
import { PoolCard } from "./PoolCard";
import { usePoolSubscription } from "./subscription";

/** The pause after the last keystroke before the search is sent. */
const TYPING_MS = 250;

/** The query as typed, delayed: one request per pause, not one per letter. */
function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), TYPING_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/**
 * Follow (or stop following) a public pool from its card. A secondary
 * button: the catalogue's primary is the search, and the shelf's "New pool"
 * is not offered here (one primary per screen).
 */
function FollowButton({ pool }: { pool: PoolSummary }) {
  const t = useT();
  const { subscribe, unsubscribe } = usePoolSubscription(pool.id);
  // The server says what can be done (`subscriptionState`): a seat or a private pool has nothing to follow.
  if (pool.subscription === "none") return null;
  return pool.subscription === "subscribed" ? (
    <Button
      size="sm"
      variant="secondary"
      loading={unsubscribe.isPending}
      onClick={() => unsubscribe.mutate()}
      aria-label={t("pool.unsubscribe")}
    >
      <Check /> {t("pool.subscribed")}
    </Button>
  ) : (
    <Button size="sm" variant="secondary" loading={subscribe.isPending} onClick={() => subscribe.mutate()}>
      <BellPlus /> {t("pool.subscribe")}
    </Button>
  );
}

/**
 * "Explore" on the pools page (ADR-095): the public pools of the school,
 * searched over their name, description, domain and concepts, the most
 * followed first. Public pools only, and not widened by Super Powers.
 */
export function PoolCatalogue({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const me = useMe();
  const [typed, setTyped] = useState("");
  const q = useDebounced(typed.trim());
  const list = useQuery<PoolSummary[]>({
    queryKey: poolCatalogueKey(q),
    queryFn: () => api(`/app/api/pools/catalogue?${new URLSearchParams({ q } satisfies CatalogueQueryInput)}`),
    placeholderData: (previous) => previous,
  });
  const rows = list.data ?? [];

  return (
    <div className="space-y-6">
      <SearchInput
        className="w-full sm:max-w-md"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={t("pools.catalogue.search")}
        aria-label={t("pools.catalogue.search")}
      />
      {list.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : list.isError ? (
        <QueryError title={t("pools.catalogue")} query={list} />
      ) : rows.length === 0 ? (
        <EmptyState icon={Globe} title={t(q === "" ? "pools.catalogue.empty.title" : "pools.catalogue.none.title")}>
          {t(q === "" ? "pools.catalogue.empty.body" : "pools.catalogue.none.body")}
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((pool) => (
            <PoolCard key={pool.id} pool={pool} me={me.data} navigate={navigate} action={<FollowButton pool={pool} />} />
          ))}
        </div>
      )}
      {list.isFetching && !list.isLoading ? <Spinner className="py-2" /> : null}
    </div>
  );
}
