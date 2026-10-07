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
 *   - Space: generous (32) between the ring, the conditions and the footer line.
 *   - Finish: one card for the conditions (ADR-079), hairlines, no shadow.
 *
 * The screen is split in two (#152): `LobbyScreen` draws it from props, and
 * `Lobby` connects it. `Lobby` watches `lobby:<id>` — the same topic as the
 * teacher's dashboard, so a student legitimately receives `lobby.count` and
 * `evaluation.state` there (§4.8), and the subject is also what makes the
 * connection COUNT as present (F-LIVE-02). It calls `onStart` the moment the
 * state turns `running`, so nobody has to reload to begin.
 */
import { useState, type ReactNode } from "react";

import { LobbyView } from "@quiz/contracts";

import { useT } from "../i18n";
import { useEventStream } from "../realtime/useEventStream";
import { useServerClock } from "../realtime/useServerClock";
import { Button, cx, Ring, useNow } from "../ui";
import { ConditionsList } from "./ConditionsList";

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
  },
  compact: {
    Root: "div",
    Title: "p",
    frame: "px-4 py-6",
    title: "text-xl",
    gap: "mt-5",
    ring: 148,
    percent: "text-2xl",
  },
} as const;

/** What the waiting room says, stripped of what only the live room knows. */
export type LobbyScreenView = Pick<LobbyView, "evaluation" | "conditions">;

/**
 * The waiting room as a picture: what the student reads, from props alone —
 * no stream, no clock, no request. {@link Lobby} feeds it live; the teacher's
 * launch step renders it as a preview (#152, ADR-018 addendum), which is why
 * it must never open the `lobby:` stream itself: a staff seat watching that
 * subject would be counted present (F-LIVE-02). It holds no question
 * content, only the evaluation's conditions.
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
  const size = SIZES[compact ? "compact" : "page"];
  const { Root, Title, gap } = size;

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

      {/* ADR-079 (amending ADR-076 §1): the conditions replace the rules
          card, and say everything it said — the duration with the student's
          extra time, the saving, the navigation — once, while the student
          has time to read it; the player itself stays bare. */}
      <ConditionsList conditions={view.conditions} compact={compact} className={gap} />

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
