import { Circle, CircleCheck, CircleDashed, ExternalLink, GraduationCap } from "lucide-react";

import { TRAINING_MISSIONS, type TrainingMission, type TrainingStatus } from "@quiz/contracts";

import { useEvaluations } from "../evaluation/api";
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
 *   - Color: ONE accent, the next `todo` mission's button. Done is the
 *     success check `Alert` already uses; unavailable is faint.
 *   - Space: tight rows (12 px), the card's own padding around them.
 *   - Finish: the hairline card, no shadow, no new colour.
 *
 * The button LEADS to where the mission happens and never performs the
 * gesture (ADR-018: the seat and the switch are the teacher's to learn where
 * they are): mission 1 brings "Join as student" into view and under focus —
 * or, once the seat exists, points at the account menu's switch in words;
 * mission 2 opens the live quiz's page; mission 3 the pools; mission 4 the
 * Settings. Missions 1 to 3 done is the training complete (mission 4 is
 * optional): the card says so and links the guide's chapter.
 *
 * Content, not chrome: no coach anchor, no `useScreenCommands`, so the
 * classroom's tour plays as on any first visit (ADR-087 §9).
 */

/** The live quiz's title in the content module (ADR-105 §3, French content only, Assumption 5). */
const LIVE_QUIZ_TITLE = "Le quiz en direct";
/** The guide's chapter, on the documentation site. */
const GUIDE_URL = `${DOCS_URL}guide/training/`;

/** The three missions that make the training complete; the fourth is optional. */
const REQUIRED: readonly TrainingMission[] = ["student", "run", "own"];

/** Whether missions 1 to 3 are done: the training is complete (ADR-105 §4). */
export function trainingComplete(status: TrainingStatus): boolean {
  return REQUIRED.every((key) => status.missions.find((m) => m.key === key)?.state === "done");
}

/**
 * Brings the classroom's "Join as student" control into view and under
 * focus: the coach anchor `classroom.join` already names it, and the tour
 * and the card must point at the same button.
 */
function revealJoin() {
  const join = document.querySelector<HTMLElement>('[data-coach="classroom.join"]');
  // jsdom has no `scrollIntoView`, hence the optional call.
  join?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  join?.focus();
}

export function TrainingCard({
  classroomId,
  status,
  hasSeat,
  navigate,
}: {
  classroomId: string;
  status: TrainingStatus;
  /** The teacher already holds their staff seat: "Join as student" is gone. */
  hasSeat: boolean;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  // The same read as the list below, deduplicated on its key: the live
  // quiz's page is reached by its title among the classroom's activities.
  const evaluations = useEvaluations(classroomId);
  const liveQuiz = evaluations.data?.find((e) => e.title === LIVE_QUIZ_TITLE);
  const stateOf = (key: TrainingMission) => status.missions.find((m) => m.key === key)?.state ?? "todo";
  const next = TRAINING_MISSIONS.find((key) => stateOf(key) === "todo");
  const complete = trainingComplete(status);

  const lead: Record<TrainingMission, () => void> = {
    student: revealJoin,
    run: () => {
      if (liveQuiz) navigate({ view: "evaluation", id: liveQuiz.id });
      else document.getElementById("classroom-evaluations")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    },
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
          const state = stateOf(key);
          const isNext = key === next;
          const Icon = state === "done" ? CircleCheck : state === "unavailable" ? CircleDashed : Circle;
          return (
            // On a phone the button wraps under the text, aligned with it
            // (the icon's width and the gap), rather than squeezing the line.
            <li key={key} className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:flex-nowrap">
              <Icon
                className={cx(
                  "mt-0.5 size-5 shrink-0",
                  state === "done" ? "text-success" : state === "unavailable" ? "text-fg-faint" : "text-fg-muted",
                )}
                aria-label={t(`training.state.${state}`)}
                role="img"
              />
              <div className="min-w-0 flex-1 basis-56 space-y-0.5">
                <p className={cx("text-sm font-semibold", state === "unavailable" && "text-fg-muted")}>
                  {t(`training.mission.${key}.title`)}
                  {key === "tools" ? (
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
                {isNext && key === "student" && hasSeat ? (
                  <p className="text-[13px] text-fg">{t("training.seatHint")}</p>
                ) : null}
              </div>
              {isNext && !(key === "student" && hasSeat) ? (
                <Button size="sm" onClick={lead[key]} className="ml-8 shrink-0 sm:ml-0">
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
