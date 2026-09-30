/**
 * Super Powers (ADR-054): for one hour, an admin's session reaches every
 * course and pool of the instance; otherwise the admin works like any
 * teacher, on their own seats. The server decides and keeps the time
 * (`Me.session.superPowersUntil`); this side only counts down to it, for
 * display, and asks again when it reaches zero.
 *
 * Switching them on or off changes what every query may return, so the
 * whole cache is invalidated, not one key: the pages on screen refetch with
 * the new reach — a colleague's course answers 404 once they are off.
 */
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AlertTriangle, Zap } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import type { Me, SuperPowersState } from "@quiz/contracts";

import { api } from "./api";
import { useT } from "./i18n";
import { meKey } from "./queryKeys";
import { ModeBanner } from "./Shell";
import { Button, Card, FormError, isoDateParts, SectionHeading, SettingRow, useNow } from "./ui";

const PATH = "/app/api/me/super-powers";
/** The last minutes, when the banner turns to a countdown by the second. */
const ENDING_MS = 5 * 60_000;

/** Every query refetches with the reach the server now gives. */
const everything = (qc: QueryClient) => qc.invalidateQueries();

function useSuperPowersSwitch(on: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<SuperPowersState>(PATH, { method: on ? "POST" : "DELETE" }),
    onSuccess: () => everything(qc),
  });
}

/** `m:ss` of a remaining time. */
function clock(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * The time left, in the banner: whole minutes while there are more than
 * five, then a countdown by the second behind a warning sign. The leaf that
 * ticks, so the page under the banner does not re-render every second.
 * At zero it asks the server again — once, then every few seconds while the
 * server's clock, which decides, has not reached the end yet.
 */
function TimeLeft({ until }: { until: string }) {
  const t = useT();
  const qc = useQueryClient();
  const now = useNow(1_000);
  const left = Math.max(0, Date.parse(until) - now);
  const over = left === 0;
  useEffect(() => {
    if (!over) return;
    void everything(qc);
    const retry = setInterval(() => void qc.invalidateQueries({ queryKey: meKey }), 5_000);
    return () => clearInterval(retry);
  }, [over, qc]);
  if (left > ENDING_MS) {
    return (
      <span className="shrink-0 tabular-nums opacity-90">
        {t("superPowers.minutesLeft", { n: String(Math.ceil(left / 60_000)) })}
      </span>
    );
  }
  return (
    <span role="timer" className="flex shrink-0 items-center gap-1.5 font-bold tabular-nums">
      <AlertTriangle aria-hidden className="size-3.5" />
      {t("superPowers.endsIn", { time: clock(left) })}
    </span>
  );
}

/**
 * The red strip above everything while Super Powers run, with the time left
 * and the way out. Any other session: the children, as they are.
 */
export function SuperPowersBanner({ me, children }: { me: Me; children: ReactNode }) {
  const until = me.session?.superPowersUntil ?? null;
  if (until === null) return children;
  return <ActiveBanner until={until}>{children}</ActiveBanner>;
}

function ActiveBanner({ until, children }: { until: string; children: ReactNode }) {
  const t = useT();
  const off = useSuperPowersSwitch(false);
  return (
    <ModeBanner
      tone="danger"
      icon={<Zap />}
      message={t("superPowers.banner")}
      short={t("superPowers.title")}
      aside={<TimeLeft until={until} />}
      action={{
        label: t("superPowers.disable"),
        onClick: () => off.mutate(),
        disabled: off.isPending,
      }}
    >
      {children}
    </ModeBanner>
  );
}

/**
 * The settings section, for an admin: what Super Powers do, in one sentence,
 * and the switch. While they run it says until when, and offers the way out
 * the banner offers too.
 */
export function SuperPowersSection({ me }: { me: Me }) {
  const t = useT();
  const until = me.session?.superPowersUntil ?? null;
  const toggle = useSuperPowersSwitch(until === null);
  return (
    <section className="space-y-3">
      <SectionHeading icon={Zap} title={t("superPowers.title")} />
      <Card className="px-5">
        <SettingRow
          title={
            until === null
              ? t("superPowers.off")
              : t("superPowers.onUntil", { time: isoDateParts(until).time })
          }
          desc={t("superPowers.hint")}
        >
          <Button
            variant="secondary"
            size="sm"
            loading={toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {until === null ? t("superPowers.enable") : t("superPowers.disable")}
          </Button>
        </SettingRow>
      </Card>
      <FormError error={toggle.error} fallback={t("error.save")} />
    </section>
  );
}
