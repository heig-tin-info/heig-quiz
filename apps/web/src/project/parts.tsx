/*
 * The small pieces the project page's sections share (M3-12): a score as
 * points out of their maximum, the final score with its grade and source, a
 * CI status as a tag.
 */
import type {
  ProjectGradeAdjustment,
  ProjectGradingMode,
  ProjectRepoCollection,
  ProjectRepoView,
  ProjectStudent,
  ProjectSyncState,
  RepoAccessState,
} from "@quiz/contracts";
import { ciShareOnly, formatGrade, formatScore, rateOf, WORKSPACE_PUSH_MAX_BYTES } from "@quiz/domain";

import { GitPullRequest, PackageCheck, RefreshCw, SlidersHorizontal, TriangleAlert } from "lucide-react";

import { Grade } from "../Grade";
import { studentName } from "../group/groupRules";
import { useT, type Dict, type TFunction } from "../i18n";
import { Badge, Button, cx, Dash, isoDateTime, RateRing, Tip, type Tone } from "../ui";
import { syncTag, type RepoMember } from "./projectPage";

/** A relative grade adjustment as written (ADR-135): signed, to the tenth ("+0.2", "−0.4"). */
export const signedTenth = (n: number): string => `${n < 0 ? "−" : "+"}${formatGrade(Math.abs(n))}`;

/** A score out of its maximum, to the tenth ("8/10", "7.2/26", "9" without one), or a dash without points. */
export function Points({ points, max }: { points: number | null; max: number | null }) {
  if (points === null) return <Dash />;
  return (
    <span className="tabular-nums">
      {formatScore(points)}
      {max !== null ? `/${formatScore(max)}` : ""}
    </span>
  );
}

/** The words of a final score's source (I42). */
export const SCORE_SOURCE_KEY: Record<NonNullable<ProjectRepoView["scores"]["final"]>["source"], keyof Dict> = {
  teacher: "project.score.source.teacher",
  criteria: "project.score.source.criteria",
  review: "project.review",
  ci: "project.col.ci",
};

/**
 * A final score as the table writes it: the points out of their maximum in
 * bold tabular text, the grade as text beside them (never a badge), and under
 * them, as faint text, where the score comes from (CI, review, teacher) —
 * visible, not only a tooltip (I42).
 *
 * The CI's score of a project graded by criteria (`ciShareOnly`, product
 * owner 2026-11-18) is only the CI's share: the AI and the teacher grade the
 * rest later. The server sends no grade for it; a small ring of the CI's
 * rate on the red-to-green ramp stands before the points, still written.
 */
export function Score({
  score,
  gradingMode,
  adjustment = null,
}: {
  score: ProjectRepoView["scores"]["final"];
  gradingMode: ProjectGradingMode;
  /** The grade's adjustment (ADR-135): its mark beside the grade, which is already the adjusted one. */
  adjustment?: ProjectGradeAdjustment | null;
}) {
  const t = useT();
  if (!score) return <Dash />;
  const { max } = score;
  const rate = ciShareOnly(gradingMode, score.source) && max !== null ? rateOf(score.points, max) : null;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className={cx("inline-flex gap-x-2", rate === null ? "items-baseline" : "items-center")}>
        {rate !== null && max !== null ? (
          <RateRing
            rate={rate}
            sentence={t("project.score.ciRate", { points: formatScore(score.points), max: formatScore(max), rate: Math.round(rate * 100) })}
          />
        ) : null}
        <span className="font-semibold">
          <Points points={score.points} max={max} />
        </span>
        {score.grade ? (
          <span className="inline-flex items-center gap-1 tabular-nums text-fg-muted">
            <Grade value={score.grade.grade} />
            <AdjustmentMark adjustment={adjustment} />
          </span>
        ) : null}
      </span>
      <span className="text-xs text-fg-faint">{t(SCORE_SOURCE_KEY[score.source])}</span>
    </span>
  );
}

/** "Base grade moved from 4.1 to 4.6" (ADR-135): the one sentence of an absolute pin whose base moved. */
export const baseMovedText = (t: TFunction, moved: NonNullable<ProjectGradeAdjustment["moved"]>): string =>
  t("project.adjust.baseMoved", { from: formatGrade(moved.from), to: formatGrade(moved.to) });

/**
 * The mark of an adjusted grade (ADR-135), after the grade it marks: a
 * small faint icon whose bubble holds the justification — the warning icon
 * instead when an absolute pin's base grade moved since it was written,
 * the move said first. Its words are also in the text for a screen reader.
 * Nothing without an adjustment.
 */
export function AdjustmentMark({ adjustment }: { adjustment: ProjectGradeAdjustment | null }) {
  const t = useT();
  if (!adjustment) return null;
  const { moved } = adjustment;
  const label = moved ? `${baseMovedText(t, moved)}. ${adjustment.comment}` : adjustment.comment;
  const Icon = moved ? TriangleAlert : SlidersHorizontal;
  return (
    <Tip label={label}>
      <span className={cx("inline-flex", moved ? "text-warning" : "text-fg-faint")} data-testid="grade-adjusted">
        <Icon aria-hidden className="size-3.5" />
        <span className="sr-only">
          {t("project.adjust.mark")}: {label}
        </span>
      </span>
    </Tip>
  );
}

/** Who adjusted a grade, and when (ADR-135): a faint caption. */
export function AdjustmentByline({ adjustment }: { adjustment: Pick<ProjectGradeAdjustment, "by" | "at"> }) {
  const t = useT();
  return <span className="text-xs text-fg-faint">{t("project.adjust.by", { by: adjustment.by ?? "—", date: isoDateTime(adjustment.at) })}</span>;
}

/**
 * The sync of a repository as a tag (F-PROJ-12, M3-07; `syncTag`): its
 * pull request, linked to GitHub in a new tab when it has one — the click
 * never reaches the row —, else its outcome; nothing when the sync never
 * reached it.
 */
export function SyncBadge({ repo }: { repo: ProjectRepoView }) {
  const t = useT();
  const tag = syncTag(repo);
  if (!tag) return null;
  const badge = (
    <Badge tone={tag.tone} icon={tag.n === undefined ? undefined : GitPullRequest}>
      {tag.n === undefined ? t(tag.key) : t(tag.key, { n: tag.n })}
    </Badge>
  );
  if (!tag.href) return badge;
  return (
    <a href={tag.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="hover:underline">
      {badge}
    </a>
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
  if (status === "none") return <Dash />;
  return <Badge tone={CI[status].tone}>{t(CI[status].key)}</Badge>;
}

/** A student's second line: the GitHub account they linked, or that their seat is not claimed. */
export function StudentAccount({ student }: { student: ProjectStudent }) {
  const t = useT();
  if (!student.claimed) return <span className="text-xs text-fg-faint">{t("project.repo.notClaimed")}</span>;
  return student.githubLogin ? <span className="font-mono text-xs text-fg-faint">{student.githubLogin}</span> : null;
}

/** A member's access as a tag (ADR-070, 2026-11-19): only for one not in, a joined member says nothing. */
const ACCESS: Record<Exclude<RepoAccessState, "joined">, { tone: Tone; key: keyof Dict }> = {
  pending: { tone: "amber", key: "project.access.pending" },
  expired: { tone: "red", key: "project.access.expired" },
  unlinked: { tone: "zinc", key: "project.access.unlinked" },
};

/**
 * A student's access to their repository on GitHub as a tag, a group's
 * member's or a student's own alike: nothing once joined, nothing without a
 * repository or an invitation, nothing for an unclaimed seat (which says
 * that instead).
 */
export function AccessTag({ member }: { member: RepoMember }) {
  const t = useT();
  if (member.access === null || member.access === "joined" || !member.claimed) return null;
  const { tone, key } = ACCESS[member.access];
  return <Badge tone={tone}>{t(key)}</Badge>;
}

/**
 * A group's current members (ADR-070 §4, M3-16b, B7), one per line: name,
 * GitHub login, the commits they authored (ADR-136, right-aligned) and the
 * access tag in four columns from `@2xl` (the table's width), wrapping
 * below it — "No member" for a repository its group no longer holds anyone
 * in (R1). The table's row and the repository's sheet draw the same.
 */
export function MemberList({ members, className }: { members: RepoMember[]; className?: string }) {
  const t = useT();
  if (members.length === 0) return <span className={cx("text-fg-faint", className)}>{t("project.repo.noMember")}</span>;
  return (
    <ul className={cx("flex flex-col gap-0.5 @2xl:grid @2xl:grid-cols-[repeat(4,max-content)] @2xl:items-center @2xl:gap-x-2", className)}>
      {members.map((m) => (
        <li key={m.enrollmentId ?? m.email} className="flex flex-wrap items-center gap-x-1.5 @2xl:contents">
          <span className="whitespace-nowrap">{studentName(m)}</span>
          <span>
            <StudentAccount student={m} />
          </span>
          <span className="min-w-6 text-right tabular-nums">{m.authored ? <AuthoredCount n={m.authored.n} /> : null}</span>
          <span>
            <AccessTag member={m} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A member's commit count (ADR-136): "3 commits" where the line wraps, the
 * figure alone in its column from `@2xl`, its unit said to a screen reader
 * and on hover.
 */
function AuthoredCount({ n }: { n: number }) {
  const t = useT();
  const label = n === 1 ? t("sproj.commits.one") : t("sproj.commits", { n });
  return (
    <>
      <span className="@2xl:hidden">{label}</span>
      <span className="hidden @2xl:inline">
        <Tip label={label}>
          <span>
            <span aria-hidden>{n}</span>
            <span className="sr-only">{label}</span>
          </span>
        </Tip>
      </span>
    </>
  );
}

/**
 * The source's *Sync* (F-PROJ-12): a primary in the header when the server
 * names it, a secondary beside Publish or Release, or the Source tile's.
 * `coach` is the tour's anchor, one per page.
 */
export function SyncButton({
  sync,
  onSync,
  syncing,
  variant = "secondary",
  size,
  coach,
}: {
  sync: ProjectSyncState;
  onSync: () => void;
  syncing: boolean;
  variant?: "primary" | "secondary";
  size?: "sm";
  coach: "project.primary" | "project.sync";
}) {
  const t = useT();
  return (
    <Button variant={variant} size={size} data-coach={coach} onClick={onSync} loading={syncing || sync.inProgress}>
      <RefreshCw /> {t(sync.inProgress ? "project.sync.inProgress" : "project.sync")}
    </Button>
  );
}

/**
 * The online workspace's collection at the deadline, as a tag (ADR-130 §7):
 * `collected`, or `not collected` for any outcome that handed nothing in
 * while there was something to, an unconfirmed order included (its sentence
 * says so); nothing for a repository never collected, or whose workspace
 * matched the last push.
 */
function collectionTag(collection: ProjectRepoView["collection"]): { key: keyof Dict; tone: Tone; collected: boolean } | null {
  if (collection === null || collection.outcome === "unchanged") return null;
  return collection.outcome === "collected"
    ? { key: "project.collection.collected", tone: "zinc", collected: true }
    : { key: "project.collection.notCollected", tone: "amber", collected: false };
}

export function CollectionBadge({ repo }: { repo: ProjectRepoView }) {
  const t = useT();
  const tag = collectionTag(repo.collection);
  if (!tag) return null;
  return (
    <Badge tone={tag.tone} {...(tag.collected ? { icon: PackageCheck } : {})}>
      {t(tag.key)}
    </Badge>
  );
}

/** The sentence of each outcome; an unconfirmed order (`pending`) and a collection name their time. */
const COLLECTION_SAID: Record<NonNullable<ProjectRepoCollection["outcome"]> | "pending", keyof Dict> = {
  pending: "project.collection.pending",
  collected: "project.collection.at",
  unchanged: "project.collection.unchanged",
  no_snapshot: "project.collection.no_snapshot",
  branch_not_handed_out: "project.collection.branch_not_handed_out",
  too_large: "project.collection.too_large",
  too_late: "project.collection.too_late",
  failed: "project.collection.failed",
};

/** What the collection was, in words, for the repository's sheet: when, or why not, and the files it could not read. */
export function CollectionFacts({ repo }: { repo: ProjectRepoView }) {
  const t = useT();
  const c = repo.collection;
  if (c === null) return null;
  const said = t(COLLECTION_SAID[c.outcome ?? "pending"], { at: isoDateTime(c.at), mib: WORKSPACE_PUSH_MAX_BYTES / 1024 / 1024 });
  return (
    <div className="flex flex-col items-start gap-1 text-[13px]">
      <CollectionBadge repo={repo} />
      <p className="text-fg-muted">{said}</p>
      {c.unreadable ? (
        <p className="text-fg-muted">{c.unreadable === 1 ? t("project.collection.unreadable.one") : t("project.collection.unreadable", { n: c.unreadable })}</p>
      ) : null}
    </div>
  );
}
