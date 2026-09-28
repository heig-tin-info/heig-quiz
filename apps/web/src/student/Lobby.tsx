/**
 * The waiting room (F-EVAL-06).
 *
 * This screen has NO primary action, which is the whole point: the student
 * has arrived, there is nothing left to do, and the page must say so without
 * inventing a button. The four decisions follow from that:
 *   - Type: the evaluation's title at page-title size, everything else quiet.
 *   - Color: none. The ring is `fg`, not the accent — it is the only living
 *     element on the page, and a red disc reads as an alarm on a screen whose
 *     message is "relax, it has not started".
 *   - Space: generous (32) between the ring, the rules and the footer line.
 *   - Finish: one card for the rules, hairlines, no shadow.
 *
 * The screen is split in two (#152): `LobbyScreen` draws it from props, and
 * `Lobby` connects it. `Lobby` watches `lobby:<id>` — the same topic as the
 * teacher's dashboard, so a student legitimately receives `lobby.count` and
 * `evaluation.state` there (§4.8), and the subject is also what makes the
 * connection COUNT as present (F-LIVE-02). It calls `onStart` the moment the
 * state turns `running`, so nobody has to reload to begin.
 */
import { useState, type ReactNode } from "react";
import { CheckCheck, CircleMinus, Save, ShieldCheck } from "lucide-react";

import { LobbyView } from "@quiz/contracts";

import { useT } from "../i18n";
import { useEventStream } from "../realtime/useEventStream";
import { useServerClock } from "../realtime/useServerClock";
import { Badge, Button, Card, cx, Ring, useNow } from "../ui";

const NAV_COPY = {
  free: { title: "lobby.nav.free.title", body: "lobby.nav.free.body" },
  forward_only: { title: "lobby.nav.forward.title", body: "lobby.nav.forward.body" },
  milestones: { title: "lobby.nav.milestones.title", body: "lobby.nav.milestones.body" },
} as const;

/**
 * The two sizes of the waiting room: the student's page, and the miniature
 * the launch step shows in a side column or a sheet (a `div` with a plain
 * title there, since it sits inside a page that has its own `main` and `h1`).
 */
const SIZES = {
  page: {
    Root: "main",
    Title: "h1",
    frame: "max-w-160 px-4 py-10 sm:px-6",
    title: "text-[28px]",
    gap: "mt-8",
    ring: 208,
    percent: "text-[32px]",
    rule: "px-5 py-4",
  },
  compact: {
    Root: "div",
    Title: "p",
    frame: "px-4 py-6",
    title: "text-xl",
    gap: "mt-5",
    ring: 148,
    percent: "text-2xl",
    rule: "px-4 py-3",
  },
} as const;

/** What the waiting room says, stripped of what only the live room knows. */
export type LobbyScreenView = Pick<
  LobbyView,
  "evaluation" | "navigation" | "negativeMarking" | "timeBonusPercent"
>;

/**
 * The waiting room as a picture: what the student reads, from props alone —
 * no stream, no clock, no request. {@link Lobby} feeds it live; the teacher's
 * launch step renders it as a preview (#152, ADR-018 addendum), which is why
 * it must never open the `lobby:` stream itself: a staff seat watching that
 * subject would be counted present (F-LIVE-02). It holds no question
 * content, only the evaluation's rules.
 *
 * `status` is the footer line (connection and wall clock) and `onLeave` the
 * way out; the preview has neither. `compact` draws it at the size of a side
 * column, in a `div` rather than the page's `main`.
 */
export function LobbyScreen({
  view,
  present,
  enrolled,
  status,
  onLeave,
  compact = false,
}: {
  view: LobbyScreenView;
  present: number;
  enrolled: number;
  status?: ReactNode;
  onLeave?: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const percent = enrolled > 0 ? Math.round((present / enrolled) * 100) : 0;
  const durationS = view.evaluation.announcedDurationS;
  const bonusS = durationS === null ? null : Math.round((durationS * view.timeBonusPercent) / 100);
  const size = SIZES[compact ? "compact" : "page"];
  const { Root, Title, gap } = size;

  // Three fixed lines (§6.3), the navigation rule first: `LobbyView` carries
  // the evaluation's `settings.navigation` for exactly this line. A fourth
  // when the evaluation uses negative marking (ADR-026): the student must
  // know that a guess costs points BEFORE the first question, and this is
  // the one screen they read while they have time to.
  const rules = [
    { icon: CheckCheck, ...NAV_COPY[view.navigation] } as const,
    ...(view.negativeMarking === true
      ? [{ icon: CircleMinus, title: "lobby.negative.title", body: "lobby.negative.body" } as const]
      : []),
    { icon: Save, title: "lobby.saving.title", body: "lobby.saving.body" } as const,
    { icon: ShieldCheck, title: "lobby.attempt.title", body: "lobby.attempt.body" } as const,
  ];

  return (
    <Root
      className={cx(
        "mx-auto flex w-full flex-col items-center text-center",
        size.frame,
      )}
    >
      <p className="text-[13px] font-medium uppercase tracking-wide text-fg-faint">
        {t("lobby.title")}
      </p>
      <Title className={cx("mt-2 font-bold leading-tight tracking-[-0.02em]", size.title)}>
        {view.evaluation.title}
      </Title>
      {durationS === null ? null : (
        <p className="mt-2 text-sm text-fg-muted">
          {t("lobby.duration", { n: Math.round(durationS / 60) })}
        </p>
      )}

      <Ring
        value={present}
        max={enrolled}
        size={size.ring}
        className={gap}
        label={t("lobby.presence", { present, enrolled })}
      >
        <span className={cx("font-bold leading-none tabular-nums", size.percent)}>
          {percent} %
        </span>
        <span className="mt-1 text-[13px] text-fg-muted">{t("lobby.present")}</span>
        <span className="mt-2 text-[15px] font-medium tabular-nums">
          {present} / {enrolled}
        </span>
      </Ring>

      <p className={cx(gap, "text-base text-fg-muted")}>{t("lobby.waiting")}</p>
      {/* Said here, once, while the student has time to read it — the player
          itself stays bare (the sentence used to sit under every question). */}
      <p className="mt-2 text-[13px] text-fg-muted">{t("lobby.hint.saving")}</p>

      <Card className={cx(gap, "w-full divide-y divide-line text-left")}>
        {rules.map((rule) => (
          <div
            key={rule.title}
            className={cx("flex items-start gap-3", size.rule)}
          >
            <rule.icon className="mt-0.5 size-4 shrink-0 text-fg-faint" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{t(rule.title)}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-fg-muted">{t(rule.body)}</p>
            </div>
          </div>
        ))}
      </Card>

      {view.timeBonusPercent > 0 && bonusS !== null ? (
        <Badge tone="accent" className="mt-5">
          {t("lobby.bonus", {
            n: view.timeBonusPercent,
            time: t("lobby.duration", { n: Math.round((durationS! + bonusS) / 60) }),
          })}
        </Badge>
      ) : null}

      {status ? (
        <p className="mt-8 flex flex-wrap items-center justify-center gap-2 text-[13px] text-fg-faint">
          {status}
        </p>
      ) : null}

      {onLeave ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onLeave}>
          {t("lobby.leave")}
        </Button>
      ) : null}
    </Root>
  );
}

/**
 * The connected waiting room: {@link LobbyScreen} fed by the `lobby:<id>`
 * stream — the subscription that counts the student present — and by the
 * server clock.
 */
export function Lobby({
  view,
  onStart,
  onLeave,
}: {
  view: LobbyView;
  onStart: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const clock = useServerClock();
  const [count, setCount] = useState({ present: view.present, enrolled: view.enrolled });
  // One second, for the wall clock under the ring: the only place the student
  // sees that the page is alive while nothing else moves.
  const tick = useNow(1_000);

  const { connected } = useEventStream({
    watch: `lobby:${view.evaluation.id}`,
    onEvent: (event) => {
      if (event.type === "clock" || event.type === "snapshot") clock.sample(event.serverNow);
      // A start (or a resume) that landed between the entry and this
      // connection is only in the snapshot: no `evaluation.state` follows it.
      if (
        event.type === "snapshot" &&
        LobbyView.safeParse(event.state).data?.evaluation.state === "running"
      ) {
        onStart();
      }
      if (event.type === "lobby.count") {
        setCount({ present: event.present, enrolled: event.enrolled });
      }
      if (event.type === "evaluation.state") {
        clock.sample(event.serverNow);
        if (event.state === "running") onStart();
      }
    },
  });

  const time = new Date(clock.synced ? clock.now() : tick);

  return (
    <LobbyScreen
      view={view}
      present={count.present}
      enrolled={count.enrolled}
      onLeave={onLeave}
      status={
        <>
          <span>{connected ? t("lobby.connected") : t("lobby.connecting")}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {String(time.getHours()).padStart(2, "0")}:{String(time.getMinutes()).padStart(2, "0")}:
            {String(time.getSeconds()).padStart(2, "0")}
          </span>
        </>
      }
    />
  );
}
