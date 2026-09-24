import type { DashboardRow } from "@quiz/contracts";

import { useT } from "../i18n";
import type { GridState } from "../realtime/grid";
import { presence } from "../realtime/grid";
import { Badge, Card, cx, Ring, SectionHeading } from "../ui";

/**
 * The waiting room, teacher side (F-LIVE-03, mockup 06 seen from the desk):
 * who is here, who is not, and who has extra time — the three things worth
 * knowing in the ninety seconds before pressing Start.
 *
 * It replaces the grid rather than sitting above it: before anybody has
 * started, the grid is twenty-four rows of empty circles, which is a wall
 * that says nothing. The names are chips and not a table for the same
 * reason — there is one fact per student here, and a table would spend four
 * columns saying it.
 */
export function LobbyPanel({ state }: { state: GridState }) {
  const t = useT();
  const counts = presence(state);
  const here = state.view.rows.filter((r) => r.online);
  const away = state.view.rows.filter((r) => !r.online);
  const bonus = state.view.rows.filter((r) => r.timeBonusPercent > 0);

  const chips = (rows: DashboardRow[], muted: boolean) => (
    <ul className="flex flex-wrap gap-1.5">
      {rows.map((row) => (
        <li
          key={row.seatId}
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[13px]",
            muted ? "text-fg-muted" : "text-fg",
          )}
        >
          <span
            aria-hidden
            className={cx("size-1.5 rounded-full", muted ? "bg-line-strong" : "bg-success")}
          />
          {row.displayName}
          {row.timeBonusPercent > 0 ? (
            <Badge tone="accent">{t("live.row.bonus", { n: row.timeBonusPercent })}</Badge>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <Card className="space-y-6 px-6 py-6">
      <div className="flex flex-wrap items-center gap-8">
        <Ring
          value={counts.present}
          max={counts.enrolled}
          size={168}
          label={t("live.lobbyRing", { present: counts.present, enrolled: counts.enrolled })}
        >
          <span className="text-[28px] font-bold tabular-nums">{counts.present}</span>
          <span className="text-xs text-fg-muted">{t("live.presentLabel")}</span>
        </Ring>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-base font-bold">{t("live.lobbyTitle")}</p>
          <p className="mt-1 text-sm text-fg-muted">{t("live.lobbyBody")}</p>
          {bonus.length > 0 ? (
            <p className="mt-3 text-[13px] text-fg-muted">
              {bonus.length === 1
                ? t("live.lobbyBonusOne")
                : t("live.lobbyBonus", { n: bonus.length })}
            </p>
          ) : null}
        </div>
      </div>

      {here.length > 0 ? (
        <section className="space-y-2">
          <SectionHeading title={t("live.lobbyHere")} count={here.length} />
          {chips(here, false)}
        </section>
      ) : null}
      {away.length > 0 ? (
        <section className="space-y-2">
          <SectionHeading title={t("live.lobbyAway")} count={away.length} />
          {chips(away, true)}
        </section>
      ) : null}
    </Card>
  );
}
