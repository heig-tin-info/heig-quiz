import { Circle, CircleCheck, CircleDashed, ExternalLink, GraduationCap } from "lucide-react";

import { TRAINING_MISSIONS, TRAINING_OPTIONAL, type TrainingMission, type TrainingStatus } from "@quiz/contracts";

import { DOCS_URL } from "../Header";
import { useT } from "../i18n";
import type { Route } from "../router";
import { Badge, Button, Card, cx, SectionHeading, textLink } from "../ui";

/**
 * The progress card of the training classroom (ADR-105 §4), on its
 * Activities tab only, above the activities: the four missions, each with
 * its state derived from the data by the server — never stored, never
 * ticked by hand.
 *
 * The four decisions:
 *   - Type: the mission titles at 14 px semibold, their one line in the
 *     muted 13 px; the state is an icon, not a word, so the four rows scan
 *     as a list and not as a table.
 *   - Color: ONE accent at most, `trainingAccent`'s mission's button. Done
 *     is the success check `Alert` already uses; unavailable is faint.
 *   - Space: tight rows (12 px), the card's own padding around them.
 *   - Finish: the hairline card, no shadow, no new colour.
 *
 * The button LEADS to where the mission happens and never performs the
 * gesture (ADR-018: the seat and the switch are the teacher's to learn where
 * they are): mission 1 brings the page's "Join as student" into view and
 * under focus (`onStudent`, the page's own) — or, once the seat exists,
 * points at the account menu's switch in words; mission 2 opens the live
 * quiz's page the status names; mission 3 the pools; mission 4 the
 * Settings. The required missions done is the training complete: the card
 * says so and links the guide's chapter; the optional one keeps its door,
 * secondary.
 *
 * Content, not chrome: no coach anchor, no `useScreenCommands`, no DOM
 * query, so the classroom's tour plays as on any first visit (ADR-087 §9).
 */

/** The guide's chapter, on the documentation site. */
const GUIDE_URL = `${DOCS_URL}guide/training/`;

const stateOf = (status: TrainingStatus, key: TrainingMission) =>
  status.missions.find((m) => m.key === key)?.state ?? "todo";

/** The first mission still to do, in the card's order; undefined once every one is done. */
const nextMission = (status: TrainingStatus) => TRAINING_MISSIONS.find((key) => stateOf(status, key) === "todo");

/** Whether every required mission is done: the training is complete (ADR-105 §4). */
export function trainingComplete(status: TrainingStatus): boolean {
  return TRAINING_MISSIONS.every((key) => key === TRAINING_OPTIONAL || stateOf(status, key) === "done");
}

/**
 * The ONE rule the card and the classroom page share (ADR-105 §4–5): the
 * mission whose button is the screen's accent, or null when the page keeps
 * its own ("New ▾"). It is the next required mission still to do — never the
 * optional one, so the training complete gives the accent back — unless
 * that mission has no door to lead to: mission 1 for a teacher already
 * seated (the card says the next gesture in words), mission 2 once the live
 * quiz is deleted. The page then keeps its primary rather than none.
 */
export function trainingAccent(status: TrainingStatus, seated: boolean): TrainingMission | null {
  const next = nextMission(status);
  if (next === undefined || next === TRAINING_OPTIONAL) return null;
  if (next === "student" && seated) return null;
  if (next === "run" && status.course?.liveEvaluationId == null) return null;
  return next;
}

export function TrainingCard({
  status,
  onStudent,
  navigate,
}: {
  status: TrainingStatus;
  /**
   * Brings the page's "Join as student" control into view and under focus;
   * absent once the teacher holds their seat and the control is gone.
   */
  onStudent?: () => void;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const seated = onStudent === undefined;
  const next = nextMission(status);
  const accent = trainingAccent(status, seated);
  const complete = trainingComplete(status);
  const liveQuiz = status.course?.liveEvaluationId ?? null;

  /** Where each mission's button leads; absent when the door is gone (the seat taken, the live quiz deleted). */
  const lead: Record<TrainingMission, (() => void) | undefined> = {
    student: onStudent,
    run: liveQuiz === null ? undefined : () => navigate({ view: "evaluation", id: liveQuiz }),
    own: () => navigate({ view: "pools" }),
    tools: () => navigate({ view: "settings" }),
  };

  return (
    <Card className="space-y-4 p-5">
      <SectionHeading
        icon={GraduationCap}
        title={t("training.card.title")}
        description={complete ? undefined : t("training.card.description")}
        help="training"
      />
      <ol className="space-y-3">
        {TRAINING_MISSIONS.map((key) => {
          const state = stateOf(status, key);
          const isNext = key === next;
          const go = isNext ? lead[key] : undefined;
          const Icon = state === "done" ? CircleCheck : state === "unavailable" ? CircleDashed : Circle;
          return (
            // On a phone the button wraps under the text, aligned with it
            // (the icon's width and the gap), rather than squeezing the line.
            <li key={key} className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap">
              {/* Unavailable says so in words on the row: the icon then adds nothing to read. */}
              <Icon
                className={cx(
                  "mt-0.5 size-5 shrink-0",
                  state === "done" ? "text-success" : state === "unavailable" ? "text-fg-faint" : "text-fg-muted",
                )}
                {...(state === "unavailable"
                  ? { "aria-hidden": true }
                  : { role: "img", "aria-label": t(`training.state.${state}`) })}
              />
              <div className="min-w-0 flex-1 basis-56 space-y-0.5">
                <p className={cx("text-sm font-semibold", state === "unavailable" && "text-fg-muted")}>
                  {t(`training.mission.${key}.title`)}
                  {key === TRAINING_OPTIONAL ? (
                    <Badge tone="zinc" className="ml-2 align-middle">
                      {t("training.mission.tools.optional")}
                    </Badge>
                  ) : null}
                </p>
                <p className="text-[13px] text-fg-muted">
                  {state === "unavailable" ? t("training.state.unavailable") : t(`training.mission.${key}.text`)}
                </p>
                {/* The seat exists: the next gesture is the frame's switch,
                    named here and never done from here (ADR-018). */}
                {isNext && key === "student" && seated ? (
                  <p className="text-[13px] text-fg">{t("training.seatHint")}</p>
                ) : null}
              </div>
              {go ? (
                <Button
                  size="sm"
                  variant={key === accent ? "primary" : "secondary"}
                  onClick={go}
                  className="ml-8 shrink-0 sm:ml-0"
                >
                  {t(`training.go.${key}`)}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {complete ? (
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="font-semibold">{t("training.complete")}</span>
          <a
            href={GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cx(textLink, "inline-flex items-center gap-1 text-fg-muted")}
          >
            {t("training.guide")} <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </p>
      ) : null}
    </Card>
  );
}
