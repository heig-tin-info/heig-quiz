/**
 * The score a project's CI reports (ported from classroom's `grade.ts`;
 * "score" is points/max, a "grade" is the Swiss 1–6 —
 * `docs/merge/07-incompatibilities.md` §7.4).
 *
 * Convention: the `grading.yml` workflow of a student repository emits
 * `::notice title=GRADE::<points>/<max>`. The server reads the check-run
 * annotations and applies these rules:
 * - exactly ONE `GRADE` annotation must be present (several, even identical,
 *   invalidate the score; anti-tampering mitigation H5);
 * - the message must follow `points/max`, dot decimals, `max > 0`,
 *   `points <= max`.
 *
 * The annotation title stays `GRADE`: it is written by the workflows already
 * living in the student repositories, so it is a wire name, not our word.
 */

export const SCORE_ANNOTATION_TITLE = "GRADE";

const SCORE_MESSAGE_RE = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/;

export type ScoreParse =
  | { status: "ok"; points: number; max: number }
  | { status: "no_annotation" }
  | { status: "malformed"; message: string }
  | { status: "multiple"; count: number };

export interface AnnotationLike {
  title: string | null;
  message: string | null;
}

/** Parses the message of a GRADE annotation (`"4.5/6"` to points/max). */
function parseScoreMessage(message: string): ScoreParse {
  const m = SCORE_MESSAGE_RE.exec(message);
  if (!m) return { status: "malformed", message };
  const points = Number(m[1]);
  const max = Number(m[2]);
  if (!(max > 0) || points > max) return { status: "malformed", message };
  return { status: "ok", points, max };
}

/** Applies these rules to the full set of annotations of a run. */
export function extractScore(annotations: readonly AnnotationLike[]): ScoreParse {
  const scores = annotations.filter((a) => a.title === SCORE_ANNOTATION_TITLE);
  if (scores.length === 0) return { status: "no_annotation" };
  if (scores.length > 1) return { status: "multiple", count: scores.length };
  return parseScoreMessage(scores[0]?.message ?? "");
}
