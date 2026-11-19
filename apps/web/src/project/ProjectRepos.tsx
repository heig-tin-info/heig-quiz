import { FolderGit2, GraduationCap, Loader2, Lock, LockOpen, Snowflake, Users } from "lucide-react";

import type { ProjectDetail, ProjectRepoView } from "@quiz/contracts";
import { projectGraded } from "@quiz/domain";

import { useT } from "../i18n";
import type { Navigate } from "../router";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  isoDateParts,
  pressable,
  RelativeTime,
  RepoLink,
  SectionHeading,
  T,
  TableHead,
  Tip,
  useSortableTable,
  type Column,
} from "../ui";
import { OpenInWorkspaceIcon, useReviewAction } from "./OpenInWorkspace";
import { AccessTag, CiBadge, CollectionBadge, MemberList, Score, StudentAccount, SyncBadge } from "./parts";
import {
  commitTone,
  entryRowId,
  filterEntries,
  joinedCount,
  repoEntries,
  repoFlags,
  reviewTag,
  shortSha,
  type CommitTone,
  type RepoEntry,
  type RepoFilter,
} from "./projectPage";

type SortKey = "student" | "score";

/**
 * The identity cell of a row: a group's name over its members, one per
 * line by name and GitHub login, a tag on each one not in the repository on
 * GitHub, and "x/y joined" beside the name while some are not (ADR-070,
 * 2026-11-19; M3-16b, B7: the current members only; "No member" for a
 * repository its group no longer holds anyone in), or a student — with
 * "left the roster", "no group" (a group project's student in none of its
 * groups) or their account.
 */
function IdentityCell({ entry, groupMode }: { entry: RepoEntry; groupMode: boolean }) {
  const t = useT();
  const deleted = entry.repo?.flags.deleted === true;
  if (entry.kind === "group") {
    const joined = joinedCount(entry.members);
    const incomplete = entry.repo !== null && joined.total > 0 && joined.n < joined.total;
    return (
      <span className="flex flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className={cx("font-semibold", deleted && "font-medium")}>{entry.label}</span>
          {incomplete ? <Badge tone="zinc">{t("project.access.joinedCount", joined)}</Badge> : null}
        </span>
        <MemberList members={entry.members} className="text-xs text-fg-muted" />
      </span>
    );
  }
  const { student } = entry;
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <span className={cx("font-semibold", deleted && "font-medium")}>{entry.label}</span>
      {entry.staff ? (
        <Tip label={t("project.repo.staffTest")}>
          <Badge tone="zinc" icon={GraduationCap}>
            {t("grading.staff")}
          </Badge>
        </Tip>
      ) : null}
      {student.enrollmentId === null ? (
        <Badge tone="zinc">{t("project.repo.leftRoster")}</Badge>
      ) : groupMode && entry.repo === null ? (
        <Badge tone="zinc">{t("project.repo.noGroup")}</Badge>
      ) : (
        <StudentAccount student={student} />
      )}
      <AccessTag member={student} />
    </span>
  );
}

/** The repository's cell: its link, or why there is none yet. Its readers' invitations are tags beside them. */
function RepoCell({ repo }: { repo: ProjectRepoView | null }) {
  const t = useT();
  if (!repo) return <span className="text-fg-faint">{t("project.repo.notAccepted")}</span>;
  if (repo.provisionStatus === "pending") return <Badge tone="zinc">{t("project.repo.provisioning")}</Badge>;
  if (repo.provisionStatus === "error") {
    return (
      <Tip label={repo.provisionError}>
        <Badge tone="red">{t("project.repo.provisionFailed")}</Badge>
      </Tip>
    );
  }
  return repo.fullName ? <RepoLink fullName={repo.fullName} icon /> : null;
}

/**
 * The student's commit count of a repository, as their own card shows it
 * (M3-14m), and GitHub's total, the App's commit included, in the tooltip:
 * nothing about GitHub when its cache holds no value, a hint when it is stale.
 */
function CommitCount({ repo }: { repo: ProjectRepoView }) {
  const t = useT();
  const { live } = repo;
  const tip = live ? t(live.stale ? "project.repo.commitsTipStale" : "project.repo.commitsTip", { n: live.commitCount }) : null;
  return (
    <Tip label={tip}>
      <span className={cx("text-xs", COMMIT_INK[commitTone(repo)])}>
        {repo.commits === 1 ? t("sproj.commits.one") : t("sproj.commits", { n: repo.commits })}
      </span>
    </Tip>
  );
}

const COMMIT_INK: Record<CommitTone, string> = { plain: "text-fg-faint", warning: "text-warning", danger: "text-danger" };

/**
 * The last-commit cell: `sha · relative time · n commits` in one, and under
 * it a group's unattributed commits (ADR-136). "0 commits" is amber, and red only once the repository's deadline was applied with
 * nothing received at all (`commitTone`); a repository that is not
 * provisioned has no history to speak of.
 */
function CommitCell({ repo, group }: { repo: ProjectRepoView | null; group: boolean }) {
  if (!repo || repo.provisionStatus !== "ok") return <>—</>;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        {repo.lastCommit ? <span className="font-mono text-xs text-fg-muted">{shortSha(repo.lastCommit.sha)}</span> : null}
        {repo.lastCommit?.at ? <RelativeTime iso={repo.lastCommit.at} className="text-xs text-fg-muted" /> : null}
        <CommitCount repo={repo} />
      </span>
      {group ? <Unattributed n={repo.unattributed.n} /> : null}
    </span>
  );
}

/**
 * The part of a group's count no member authored (ADR-136), muted under it:
 * nothing while every commit is a member's. The members' own counts are
 * beside their names.
 */
function Unattributed({ n }: { n: number }) {
  const t = useT();
  if (n === 0) return null;
  return (
    <Tip label={t("project.repo.unattributedTip")}>
      <span className="whitespace-nowrap text-xs text-fg-faint tabular-nums">{n === 1 ? t("project.repo.unattributed.one") : t("project.repo.unattributed", { n })}</span>
    </Tip>
  );
}

/**
 * The repository's own deadline: the sentence from `@2xl`, the date alone
 * where the column is narrow, the sentence then read by a screen reader only.
 */
function OwnDeadlineBadge({ at }: { at: string }) {
  const t = useT();
  const { date } = isoDateParts(at);
  return (
    <Badge tone="amber">
      <span aria-hidden className="@2xl:hidden">{date}</span>
      <span className="sr-only @2xl:not-sr-only">{t("project.repo.ownDeadline", { date })}</span>
    </Badge>
  );
}

/**
 * The lock, the freeze, the final review's state, the sync's pull request
 * (M3-07) and the flags of a repository, as tags; on a narrow table the
 * flags fold into one count. The review tag (M3-12b) says nothing while it
 * is trivially pending.
 */
function StateCell({ repo }: { repo: ProjectRepoView }) {
  const t = useT();
  const flags = repoFlags(repo);
  const review = reviewTag(repo);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {repo.locked ? (
        <Badge tone="zinc" icon={Lock}>
          {t("project.lock.locked")}
          {repo.staffLock !== null ? ` · ${t("project.lock.byStaff")}` : ""}
        </Badge>
      ) : repo.staffLock === false ? (
        <Badge tone="zinc" icon={LockOpen}>
          {t("project.lock.open")} · {t("project.lock.byStaff")}
        </Badge>
      ) : null}
      {repo.frozenAt ? (
        <Badge tone="zinc" icon={Snowflake}>
          {t("project.frozen")}
        </Badge>
      ) : repo.deadlineAppliedAt ? (
        <Badge tone="zinc" icon={Snowflake}>
          {t("project.frozen.provisional")}
        </Badge>
      ) : null}
      {repo.deadlineAt !== null ? <OwnDeadlineBadge at={repo.deadlineAt} /> : null}
      {review ? <Badge tone={review.tone}>{t(review.key)}</Badge> : null}
      <CollectionBadge repo={repo} />
      <SyncBadge repo={repo} />
      {/* Wrappers, not classes on the badges: a badge's own `inline-flex` would win over `hidden`. */}
      <span className="hidden @2xl:contents">
        {flags.map((f) => (
          <Badge key={f.key} tone={f.tone}>
            {t(f.key)}
          </Badge>
        ))}
      </span>
      {flags.length > 0 ? (
        <span className="@2xl:hidden">
          <Badge tone={flags.some((f) => f.tone === "red") ? "red" : flags[0]!.tone}>
            {flags.length === 1 ? t("project.flags.one") : t("project.flags.count", { n: flags.length })}
          </Badge>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The repositories (F-PROJ-13): one row per student of the roster, their
 * repository or "not accepted", then the repositories whose student left the
 * roster — as the server orders them, until a column is sorted. A group
 * project (M3-16b) has one row per group instead — its repository, its
 * scores once, its members under its name —, by name, then its students in
 * no group; "Student" sorts by the group's name. Seven
 * columns at most; the ones a phone drops (repository, last commit, CI, the
 * deadline) are on the row's own page (ADR-137), which every row opens — by
 * a click or Enter —, a row not accepted yet included.
 * A deleted repository stays, muted: it is a fact of the project.
 *
 * The staff's *Open in workspace* (ADR-129 §11, F-PROJ-27) is the last
 * column's icon, where the platform offers it; a phone drops the column and keeps the page's button.
 *
 * Nothing here waits for GitHub: `live` only adds counters when the cache
 * had them, and `liveStale` is said on the heading while the next refetch
 * fills it.
 */
export function ProjectRepos({
  project,
  onOpen,
  navigate,
  filter,
  onFilter,
}: {
  project: ProjectDetail;
  /** Opens a row's page (ADR-137), by its id (`entryRowId`). */
  onOpen: (rowId: string) => void;
  navigate: Navigate;
  /** The tile sub-figure in force, or `null` for all the rows. */
  filter: RepoFilter | null;
  onFilter: (filter: RepoFilter | null) => void;
}) {
  const t = useT();
  const entries = repoEntries(project);
  const shown = filterEntries(entries, filter, project);
  const graded = projectGraded(project.gradingMode);
  /** *Open in workspace* (ADR-129 §11): a last column, only where the platform offers it. */
  const reviewOf = useReviewAction(project);
  const { sorted, sort, toggle } = useSortableTable<RepoEntry, SortKey>(
    shown,
    (entry, key) => (key === "student" ? entry.label : (entry.repo?.scores.final?.points ?? -1)),
    null,
  );

  const heading = (
    <SectionHeading
      icon={FolderGit2}
      title={<span id="project-repos">{t("project.repos")}</span>}
      count={entries.length}
      actions={
        project.liveStale ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-fg-faint" role="status">
            <Loader2 className="size-3.5 animate-spin" /> {t("project.liveStale")}
          </span>
        ) : undefined
      }
    />
  );

  if (project.rows.length === 0) {
    return (
      <section aria-labelledby="project-repos" className="space-y-3">
        {heading}
        <Card className="px-6 py-4">
          <EmptyState
            icon={Users}
            title={t("project.repos.empty.title")}
            action={
              <Button
                variant="secondary"
                onClick={() => navigate({ view: "classroom", id: project.classroomId, tab: "roster" })}
              >
                {t("roster.add")}
              </Button>
            }
          />
        </Card>
      </section>
    );
  }

  const columns: Column<SortKey>[] = [
    { key: "student", label: t(project.groupMode ? "project.col.group" : "results.col.student") },
    { key: "repo", label: t("project.col.repo"), sortable: false, className: T.colMid },
    { key: "commit", label: t("project.col.commit"), sortable: false, className: T.colLow },
    { key: "ci", label: t("project.col.ci"), sortable: false, className: T.colMid },
    ...(graded ? [{ key: "score", label: t("project.col.score"), right: true } satisfies Column<SortKey>] : []),
    { key: "state", label: t("project.col.state"), sortable: false },
    ...(reviewOf
      ? [{ key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: cx(T.colHigh, T.stickyEnd) } satisfies Column<SortKey>]
      : []),
  ];
  const noneAccepted = project.state === "published" && entries.every((e) => e.repo === null);
  /** The row the tour points at to say a row opens its page: the first one that has a repository. */
  const firstOpenable = sorted.findIndex((e) => e.repo !== null);

  return (
    <section aria-labelledby="project-repos" className="space-y-3">
      {heading}
      {noneAccepted ? <p className="text-sm text-fg-muted">{t("project.repos.none")}</p> : null}
      {filter !== null ? (
        <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted" data-testid="project-filter">
          {t("project.filter.showing", { filter: t(`project.filter.${filter}`) })} ·
          <Button variant="ghost" size="sm" onClick={() => onFilter(null)}>
            {t("project.filter.all")}
          </Button>
        </p>
      ) : null}
      <Card className={`${T.container} overflow-x-auto`}>
        <table className={T.table}>
          <TableHead columns={columns} sort={sort} onToggle={toggle} />
          <tbody>
            {sorted.map((entry, index) => {
              const { repo } = entry;
              const rowId = entryRowId(entry);
              const opens = rowId ? () => onOpen(rowId) : undefined;
              return (
                <tr
                  key={entry.key}
                  className={cx(
                    T.row,
                    opens && `${T.rowHover} cursor-pointer`,
                    repo?.flags.deleted && "text-fg-faint",
                  )}
                  {...(opens ? pressable(opens, "row") : {})}
                  {...(index === firstOpenable ? { "data-coach": "project.repo" } : {})}
                >
                  <td className={T.td}>
                    <IdentityCell entry={entry} groupMode={project.groupMode} />
                  </td>
                  <td className={`${T.td} ${T.colMid}`}>
                    <RepoCell repo={repo} />
                  </td>
                  <td className={`${T.td} ${T.colLow} text-fg-muted`}>
                    <CommitCell repo={repo} group={entry.kind === "group"} />
                  </td>
                  <td className={`${T.td} ${T.colMid}`}>
                    <CiBadge status={repo?.ciStatus ?? "none"} />
                  </td>
                  {graded ? (
                    <td className={`${T.td} text-right`}>
                      <Score score={repo?.scores.final ?? null} gradingMode={project.gradingMode} adjustment={repo?.scores.adjustment ?? null} />
                    </td>
                  ) : null}
                  <td className={T.td}>{repo ? <StateCell repo={repo} /> : null}</td>
                  {reviewOf ? (
                    <td className={cx(T.td, T.colHigh, "whitespace-nowrap text-right", T.stickyEnd)}>
                      {repo ? <OpenInWorkspaceIcon projectId={project.id} repo={repo} action={reviewOf(repo)} /> : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
