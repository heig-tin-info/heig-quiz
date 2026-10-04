import type { UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";

import type { ProjectRepoScores, ProjectRepoView, ScoreOverride } from "@quiz/contracts";

import { useT } from "../i18n";
import { FormError } from "../queryError";
import { Button, Field, Textarea } from "../ui";
import { refusalMessage, scoredRunMax } from "./projectPage";

const POINTS_ID = "project-teacher-points";
const MAX_ID = "project-teacher-max";
const COMMENT_ID = "project-teacher-comment";

/** What the form sends: `points` as typed (null clears), the maximum only when the teacher gives it, the comment as written. */
export function scoreOverrideBody(
  points: string,
  max: string,
  comment: string,
  ownMax: boolean,
): ScoreOverride | null {
  const p = Number(points);
  if (points.trim() === "" || !Number.isFinite(p) || p < 0 || p > 1000) return null;
  const body: ScoreOverride = { points: p, comment: comment.trim() };
  if (ownMax) {
    const m = Number(max);
    if (max.trim() === "" || !Number.isFinite(m) || m <= 0) return null;
    body.max = m;
  }
  return body;
}

/**
 * The teacher's score of a repository (F-PROJ-14, M3-12b): points, the
 * maximum when the repository has no scored run to take it from (`scoredRunMax`
 * null: pass / fail only, malformed, several annotations, or a run to
 * verify), a comment, and Clear once a score exists. Save is the sheet's one
 * primary action. The refusals are worded under the fields; the answer is
 * the caller's to lay over the row.
 */
export function TeacherScoreForm({
  repo,
  score,
}: {
  repo: ProjectRepoView;
  score: UseMutationResult<ProjectRepoScores, unknown, ScoreOverride>;
}) {
  const t = useT();
  const teacher = repo.scores.teacher;
  const runMax = scoredRunMax(repo);
  const ownMax = runMax === null;
  const [points, setPoints] = useState(teacher ? String(teacher.points) : "");
  const [max, setMax] = useState(teacher?.max !== null && teacher?.max !== undefined ? String(teacher.max) : "");
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
          label={t("project.teacherScore.points")}
          type="number"
          inputMode="decimal"
          min={0}
          max={ownMax ? undefined : runMax}
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
          {t("project.teacherScore.save")}
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
