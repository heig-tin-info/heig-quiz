/**
 * The waiting room (mockup `06-etudiant-attente.html`, F-EVAL-06).
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
 * It watches `lobby:<id>` — the same topic as the teacher's dashboard, so a
 * student legitimately receives `lobby.count` and `evaluation.state` there
 * (§4.8), and the subject is also what makes the connection COUNT as present
 * (F-LIVE-02). It calls `onStart` the moment the state turns `running`, so
 * nobody has to reload to begin.
 */
import { useState } from "react";
import { CheckCheck, Clock, Save, ShieldCheck } from "lucide-react";

import type { LobbyView } from "@quiz/contracts";

import { useAttemptStream } from "../attempt/attemptStream";
import { useT } from "../i18n";
import { useServerClock } from "../realtime/useServerClock";
import { Badge, Button, Card, Ring, useNow } from "../ui";

const NAV_COPY = {
  free: { title: "lobby.nav.free.title", body: "lobby.nav.free.body" },
  forward_only: { title: "lobby.nav.forward.title", body: "lobby.nav.forward.body" },
  milestones: { title: "lobby.nav.milestones.title", body: "lobby.nav.milestones.body" },
} as const;

export function Lobby({
  view,
  navigation,
  onStart,
  onLeave,
}: {
  view: LobbyView;
  /**
   * From the evaluation's settings, when the caller knows them. `LobbyView`
   * does not carry them (§4.4), so the first rule is only shown to a student
   * whose attempt has already been created once.
   */
  navigation?: keyof typeof NAV_COPY | undefined;
  onStart: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const clock = useServerClock();
  const [count, setCount] = useState({ present: view.present, enrolled: view.enrolled });
  const [connected, setConnected] = useState(false);
  // One second, for the wall clock under the ring: the only place the student
  // sees that the page is alive while nothing else moves.
  const tick = useNow(1_000);

  useAttemptStream(`lobby:${view.evaluation.id}`, {
    onEvent: (event) => {
      if (event.type === "clock" || event.type === "snapshot") clock.sample(event.serverNow);
      if (event.type === "lobby.count") {
        setCount({ present: event.present, enrolled: event.enrolled });
      }
      if (event.type === "evaluation.state") {
        clock.sample(event.serverNow);
        if (event.state === "running") onStart();
      }
    },
    onOpen: () => setConnected(true),
    onReconnect: () => setConnected(true),
    onError: () => setConnected(false),
  });

  const percent = count.enrolled > 0 ? Math.round((count.present / count.enrolled) * 100) : 0;
  const durationS = view.evaluation.announcedDurationS;
  const bonusS = durationS === null ? null : Math.round((durationS * view.timeBonusPercent) / 100);
  const time = new Date(clock.synced ? clock.now() : tick);

  // Three fixed lines (§6.3). The navigation rule replaces the generic clock
  // one as soon as the caller knows which navigation was configured.
  const rules = [
    navigation === undefined
      ? ({ icon: Clock, title: "lobby.clock.title", body: "lobby.clock.body" } as const)
      : ({ icon: CheckCheck, ...NAV_COPY[navigation] } as const),
    { icon: Save, title: "lobby.saving.title", body: "lobby.saving.body" } as const,
    { icon: ShieldCheck, title: "lobby.attempt.title", body: "lobby.attempt.body" } as const,
  ];

  return (
    <main className="mx-auto flex w-full max-w-160 flex-col items-center px-4 py-10 text-center sm:px-6">
      <p className="text-[13px] font-medium uppercase tracking-wide text-fg-faint">
        {t("lobby.title")}
      </p>
      <h1 className="mt-2 text-[28px] font-bold leading-tight tracking-[-0.02em]">
        {view.evaluation.title}
      </h1>
      {durationS === null ? null : (
        <p className="mt-2 text-sm text-fg-muted">
          {t("lobby.duration", { n: Math.round(durationS / 60) })}
        </p>
      )}

      <Ring
        value={count.present}
        max={count.enrolled}
        className="mt-8"
        label={t("lobby.presence", { present: count.present, enrolled: count.enrolled })}
      >
        <span className="text-[32px] font-bold leading-none tabular-nums">{percent} %</span>
        <span className="mt-1 text-[13px] text-fg-muted">{t("lobby.present")}</span>
        <span className="mt-2 text-[15px] font-medium tabular-nums">
          {count.present} / {count.enrolled}
        </span>
      </Ring>

      <p className="mt-8 text-base text-fg-muted">{t("lobby.waiting")}</p>
      {/* Said here, once, while the student has time to read it — the player
          itself stays bare (the sentence used to sit under every question). */}
      <p className="mt-2 text-[13px] text-fg-muted">{t("lobby.hint.saving")}</p>

      <Card className="mt-8 w-full divide-y divide-line text-left">
        {rules.map((rule) => (
          <div key={rule.title} className="flex items-start gap-3 px-5 py-4">
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

      <p className="mt-8 flex flex-wrap items-center justify-center gap-2 text-[13px] text-fg-faint">
        <span>{connected ? t("lobby.connected") : t("lobby.connecting")}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">
          {String(time.getHours()).padStart(2, "0")}:{String(time.getMinutes()).padStart(2, "0")}:
          {String(time.getSeconds()).padStart(2, "0")}
        </span>
      </p>

      <Button variant="ghost" size="sm" className="mt-2" onClick={onLeave}>
        {t("lobby.leave")}
      </Button>
    </main>
  );
}
