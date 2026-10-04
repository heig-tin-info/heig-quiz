/*
 * The small pieces the project page's sections share (M3-12): a repository
 * named on GitHub, a score as points out of their maximum, the final score
 * with its grade and source, a CI status as a tag.
 */
import type { ProjectRepoView } from "@quiz/contracts";

import { Grade } from "../Grade";
import { useT, type Dict } from "../i18n";
import { Badge, cx, GithubIcon, type Tone } from "../ui";
import { repoHref, repoShortName } from "./projectPage";

/**
 * A repository on GitHub, as a mono link in a new tab: its short name in a
 * table cell, its full name in a sheet's subtitle. The click never reaches
 * the row it sits on.
 */
export function RepoLink({
  fullName,
  full,
  icon,
  className,
}: {
  fullName: string;
  /** The whole `owner/name` rather than the name alone. */
  full?: boolean;
  icon?: boolean;
  className?: string;
}) {
  return (
    <a
      href={repoHref(fullName)}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={cx("inline-flex max-w-full items-center gap-1.5 font-mono text-[13px] hover:underline", className)}
    >
      {icon ? <GithubIcon className="size-3.5 shrink-0 text-fg-faint" /> : null}
      {/* One line, cut with an ellipsis where the cell is narrower than the name. */}
      <span className="truncate">{full ? fullName : repoShortName(fullName)}</span>
    </a>
  );
}

/** Points out of their maximum ("8/10", "9" without one), or a dash without points. */
export function Points({ points, max }: { points: number | null; max: number | null }) {
  if (points === null) return <span className="text-fg-faint">—</span>;
  return (
    <span className="tabular-nums">
      {points}
      {max !== null ? `/${max}` : ""}
    </span>
  );
}

/** The words of a final score's source (I42). */
export const SCORE_SOURCE_KEY: Record<NonNullable<ProjectRepoView["scores"]["final"]>["source"], keyof Dict> = {
  teacher: "project.score.source.teacher",
  review: "project.review",
  ci: "project.col.ci",
};

/** A final score as the table writes it: points out of their maximum, the grade, and where it comes from. */
export function Score({ score }: { score: ProjectRepoView["scores"]["final"] }) {
  const t = useT();
  if (!score) return <span className="text-fg-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
      <Points points={score.points} max={score.max} />
      {score.grade ? (
        <span className="font-semibold tabular-nums">
          <Grade value={score.grade.grade} />
        </span>
      ) : null}
      <span className="text-xs text-fg-faint">{t(SCORE_SOURCE_KEY[score.source])}</span>
    </span>
  );
}

/** A CI status as a tag: running, pass or fail; a dash while the repository has no run at all. */
const CI: Record<Exclude<ProjectRepoView["ciStatus"], "none">, { tone: Tone; key: keyof Dict }> = {
  pending: { tone: "zinc", key: "project.ci.pending" },
  pass: { tone: "green", key: "project.ci.pass" },
  fail: { tone: "red", key: "project.ci.fail" },
};

export function CiBadge({ status }: { status: ProjectRepoView["ciStatus"] }) {
  const t = useT();
  if (status === "none") return <span className="text-fg-faint">—</span>;
  return <Badge tone={CI[status].tone}>{t(CI[status].key)}</Badge>;
}
