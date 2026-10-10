import { Globe, History, Lock, Users } from "lucide-react";
import type { ReactNode } from "react";

import type { Me, PoolSummary } from "@quiz/contracts";

import { useI18n, useT, type TFunction } from "../i18n";
import type { Route } from "../router";
import { Badge, Card, cx, RelativeTime, Tip } from "../ui";
import { PoolIcon } from "./PoolIcon";

/** The visibility badge of a pool: what it says, and who else is on it. */
export function VisibilityBadge({ pool }: { pool: PoolSummary }) {
  const t = useT();
  if (pool.visibility === "public") {
    return (
      <Badge tone="amber" icon={Globe}>
        {t("pools.visibility.public")}
      </Badge>
    );
  }
  if (pool.visibility === "shared") {
    return (
      <Badge tone="zinc" icon={Users}>
        {t(
          pool.memberCount === 0
            ? "pools.visibility.sharedNone"
            : pool.memberCount === 1
              ? "pools.visibility.sharedOne"
              : "pools.visibility.shared",
          { n: pool.memberCount },
        )}
      </Badge>
    );
  }
  return (
    <Badge tone="zinc" icon={Lock}>
      {t("pools.visibility.private")}
    </Badge>
  );
}

/** What I may do in a pool that is not mine ("Contributor"); null for an owner. */
function poolRoleLabel(pool: PoolSummary, t: TFunction): string | null {
  return pool.role !== "owner" ? t(`share.role.${pool.role}`) : null;
}

/**
 * One pool of a shelf or of the catalogue: the card is one door, with the
 * pool's icon, its name (and its owner beside it when it is not mine), its
 * domain, its description and, on a public pool, the `users` counter of the
 * teachers who follow it or sit on it (ADR-095; never a star, which means
 * question favourites). `action`, when given, sits in the footer beside the
 * badge: the catalogue's Subscribe.
 */
export function PoolCard({
  pool,
  me,
  navigate,
  action,
}: {
  pool: PoolSummary;
  me: Me | null | undefined;
  navigate: (r: Route) => void;
  action?: ReactNode;
}) {
  const t = useT();
  const { locale } = useI18n();
  const mine = me != null && pool.ownerId === me.id;
  // In the catalogue a reader is the rule, not news: the footer keeps its room for Subscribe.
  const roleLabel = action ? null : poolRoleLabel(pool, t);
  const followers = pool.subscriberCount + pool.memberCount;
  // The domain in the reader's language, the other one when only that exists.
  const domain = locale === "fr" ? pool.domainFr || pool.domainEn : pool.domainEn || pool.domainFr;

  return (
    // A column, so the date strip is at the BOTTOM of every card and not
    // wherever its own text ended: three cards side by side with three rules
    // at three heights read as three different objects.
    <Card className="relative flex h-full flex-col overflow-hidden">
      {/* The card IS the door, so the whole of it is one button. */}
      <button
        type="button"
        onClick={() => navigate({ view: "pool", id: pool.id })}
        className={cx(
          "flex w-full flex-1 items-start gap-3 p-4 text-left transition-colors hover:bg-surface-2/50",
          pool.isPublic && "pr-14",
        )}
      >
        <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-field bg-surface-2 text-fg-muted">
          <PoolIcon icon={pool.icon} color={pool.color} className="size-8.75" />
        </span>
        <span className="min-w-0 flex-1">
          {/* Two pools may share a name: the owner is told beside it when the pool is not mine. */}
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-bold">{pool.name}</span>
            {!mine ? (
              <span className="max-w-[45%] shrink-0 truncate text-xs text-fg-faint">{pool.ownerName}</span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-xs text-fg-muted">
            {t(pool.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
              n: pool.questionCount,
            })}
            {domain !== "" ? <span className="text-fg-faint">{` · ${domain}`}</span> : null}
          </span>
          {pool.description !== "" ? (
            <span className="mt-2 line-clamp-3 block text-xs text-fg-muted">{pool.description}</span>
          ) : null}
        </span>
      </button>
      {pool.isPublic ? (
        // Beside the door, not in it: a tooltip of its own, and the button stays one target.
        <Tip label={t("pools.followers", { n: followers })} className="absolute right-3 top-3 inline-flex">
          <span className="inline-flex items-center gap-1 text-xs tabular-nums text-fg-faint">
            <Users aria-hidden className="size-3.5" />
            <span aria-label={t("pools.followers", { n: followers })}>{followers}</span>
          </span>
        </Tip>
      ) : null}
      {/* The last change, said by its icon rather than by the same word on
          every card, and set to the right where a date is read. Outside the
          door: the date carries its own tooltip and focus. */}
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-fg-faint">
        <span className="flex min-w-0 items-center gap-2">
          <VisibilityBadge pool={pool} />
          {roleLabel ? <span className="truncate">{roleLabel}</span> : null}
        </span>
        {action}
        <span className="flex shrink-0 items-center gap-1.5">
          <History aria-hidden className="size-3.5" />
          <span className="sr-only">{t("pools.updated")}</span>
          <RelativeTime iso={pool.updatedAt} />
        </span>
      </div>
    </Card>
  );
}

