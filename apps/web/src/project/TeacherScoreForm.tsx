import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

import { ScoreOverride, type ProjectDetail, type ProjectRepoScores, type ProjectRepoView } from "@quiz/contracts";

import { useT } from "../i18n";
import { FormError } from "../queryError";
import { Badge, Button, Fact, Field, isoDateTime, Textarea } from "../ui";
import { Points, Score } from "./parts";
import { refusalMessage, reviewView, shortSha, teacherScoreBlock } from "./projectPage";

const POINTS_ID = "project-teacher-points";
const MAX_ID = "project-teacher-max";
const COMMENT_ID = "project-teacher-comment";

/**
 * What the form sends, as the contract reads it (`ScoreOverride`, invariant
 * 7): the points as typed, the maximum only when the teacher gives it
 * (`ownMax`: the repository has no scored run), the comment as written,
 * trimmed. Null while nothing can be sent: no points, no own maximum where
 * one is required, or a value the contract refuses.
 */
export function scoreOverrideBody(points: string, max: string, comment: string, ownMax: boolean): ScoreOverride | null {
  if (points.trim() === "" || (ownMax && max.trim() === "")) return null;
  const raw = { points: Number(points), comment: comment.trim(), ...(ownMax ? { max: Number(max) } : {}) };
  return ScoreOverride.safeParse(raw).data ?? null;
}

/**
 * The teacher's score of a repository (F-PROJ-14, M3-12b): points, the
 * maximum when the server says the score is held to none (`scoreMax` null:
 * pass / fail only, malformed, several annotations, or a run to verify), a
 * comment, and Clear once a score exists. Save is the sheet's one primary
 * action. The refusals are worded under the fields; the answer is the
 * caller's to lay over the row.
 */
function TeacherScoreForm({
  repo,
  score,
}: {
  repo: ProjectRepoView;
  score: UseMutationResult<ProjectRepoScores, unknown, ScoreOverride>;
}) {
  const t = useT();
  const teacher = repo.scores.teacher;
  const runMax = repo.scores.scoreMax;
  const ownMax = runMax === null;
  const [points, setPoints] = useState(teacher ? String(teacher.points) : "");
  const [max, setMax] = useState(teacher?.max != null ? String(teacher.max) : "");
  const [comment, setComment] = useState(teacher?.comment ?? "");
  const body = scoreOverrideBody(points, max, comment, ownMax);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (body) score.mutate(body);
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field
          id={POINTS_ID}
          label={t("eval.col.points")}
          type="number"
          inputMode="decimal"
          min={0}
          max={runMax ?? undefined}
          step="any"
          size="sm"
          width="w-24"
          value={points}
          onChange={(e) => setPoints(e.target.value)}
        />
        {ownMax ? (
          <Field
            id={MAX_ID}
            label={t("project.teacherScore.max")}
            type="number"
            inputMode="decimal"
            min={1}
            step="any"
            size="sm"
            width="w-24"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        ) : (
          <span className="pb-1.5 text-sm text-fg-muted tabular-nums">{t("project.teacherScore.outOf", { max: runMax })}</span>
        )}
      </div>
      <p className="text-[13px] text-fg-muted">
        {t(ownMax ? "project.teacherScore.ownMax.desc" : "project.teacherScore.runMax.desc")}
      </p>
      <Textarea
        id={COMMENT_ID}
        label={t("project.teacherScore.comment")}
        rows={2}
        maxLength={2000}
        className="min-h-16"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <FormError error={score.error} describe={(error) => refusalMessage(error, t)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={body === null} loading={score.isPending && score.variables?.points !== null}>
          {t("common.save")}
        </Button>
        {teacher ? (
          <Button
            variant="secondary"
            size="sm"
            loading={score.isPending && score.variables?.points === null}
            onClick={() => {
              setPoints("");
              setMax("");
              setComment("");
              score.mutate({ points: null });
            }}
          >
            {t("project.teacherScore.clear")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** The final review's state (F-PROJ-11): its tag and, where a word is not enough, the line that says why or what next. */
function ReviewState({ review }: { review: ProjectRepoView["review"] }) {
  const t = useT();
  const view = reviewView(review);
  return (
    <Fact label={t("project.sheet.review")}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={view.tone}>{t(view.key)}</Badge>
        {view.detail ? (
          <span className="text-[13px] text-fg-muted">
            {t(view.detail, {
              date: review.askedAt ? isoDateTime(review.askedAt) : "—",
              sha: review.sha ? shortSha(review.sha) : "—",
            })}
          </span>
        ) : null}
      </span>
    </Fact>
  );
}

/**
 * The Scores section of the repository's sheet (F-PROJ-13, F-PROJ-14): the
 * five scores slot by slot with the final review's state beside them, then
 * the teacher's score form — or, where the form cannot apply, why: the
 * project is not graded, or the repository is not frozen for good yet.
 */
export function ScoreSection({
  project,
  repo,
  score,
}: {
  project: Pick<ProjectDetail, "gradingMode">;
  repo: ProjectRepoView;
  score: UseMutationResult<ProjectRepoScores, unknown, ScoreOverride>;
}) {
  const t = useT();
  const block = teacherScoreBlock(repo, project);
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Fact label={t("project.score.current")}>
          <Points points={repo.scores.current?.points ?? null} max={repo.scores.current?.max ?? null} />
        </Fact>
        <Fact label={t("project.score.frozen")}>
          <Points points={repo.scores.frozen?.points ?? null} max={repo.scores.frozen?.max ?? null} />
        </Fact>
        <Fact label={t("project.reviewLabel")}>
          <Points points={repo.scores.review?.points ?? null} max={repo.scores.review?.max ?? null} />
        </Fact>
        <Fact label={t("project.teacherScore")}>
          <Points points={repo.scores.teacher?.points ?? null} max={repo.scores.teacher?.max ?? null} />
        </Fact>
        <Fact label={t("project.score.final")}>
          <Score score={repo.scores.final} />
        </Fact>
        <ReviewState review={repo.review} />
      </dl>
      <div className="space-y-3 border-t border-line pt-3">
        <h4 className="text-[13px] font-medium">{t("project.teacherScore")}</h4>
        {block === null ? (
          <TeacherScoreForm key={repo.scores.teacher?.gradedAt ?? "none"} repo={repo} score={score} />
        ) : (
          <p className="text-[13px] text-fg-muted">
            {t(block === "grading_none" ? "project.refusal.gradingNone" : "project.teacherScore.waitsFreeze")}
          </p>
        )}
      </div>
    </>
  );
}
