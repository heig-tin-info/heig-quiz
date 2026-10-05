import { FolderGit2, Loader2, Lock, LockOpen, Snowflake, Users } from "lucide-react";

import type { ProjectDetail, ProjectRepoView } from "@quiz/contracts";

import { useT } from "../i18n";
import type { Navigate } from "../router";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  isoDateTime,
  pressable,
  RelativeTime,
  SectionHeading,
  T,
  TableHead,
  Tip,
  useSortableTable,
  type Column,
} from "../ui";
import { CiBadge, MemberList, RepoLink, Score, StudentAccount, SyncBadge } from "./parts";
import { repoEntries, repoFlags, reviewTag, shortSha, type RepoEntry } from "./projectPage";

type SortKey = "student" | "score" | "deadline";

/**
 * The identity cell of a row: a group's name over its members, each by name
 * and GitHub login (M3-16b, B7: the current members only; "No member" for
 * a repository its group no longer holds anyone in), or a student — with
 * "left the roster", "no group" (a group project's student in none of its
 * groups) or their account.
 */
function IdentityCell({ entry, groupMode }: { entry: RepoEntry; groupMode: boolean }) {
  const t = useT();
  const deleted = entry.repo?.flags.deleted === true;
  if (entry.kind === "group") {
    return (
      <span className="flex flex-col gap-0.5">
        <span className={cx("font-semibold", deleted && "font-medium")}>{entry.label}</span>
        <MemberList members={entry.members} className="text-xs text-fg-muted" />
      </span>
    );
  }
  const { student } = entry;
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <span className={cx("font-semibold", deleted && "font-medium")}>{entry.label}</span>
      {student.enrollmentId === null ? (
        <Badge tone="zinc">{t("project.repo.leftRoster")}</Badge>
      ) : groupMode && entry.repo === null ? (
        <Badge tone="zinc">{t("project.repo.noGroup")}</Badge>
      ) : (
        <StudentAccount student={student} />
      )}
    </span>
  );
}

/** The repository's cell: its link, or why there is none yet. */
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
  return (
    <span className="flex flex-wrap items-center gap-2">
      {repo.fullName ? <RepoLink fullName={repo.fullName} icon /> : null}
      {repo.invitationStatus === "pending" ? <Badge tone="amber">{t("project.repo.invitationPending")}</Badge> : null}
    </span>
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
      {review ? <Badge tone={review.tone}>{t(review.key)}</Badge> : null}
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
 * deadline) are in the row's sheet, which a row with a repository opens.
 * A deleted repository stays, muted: it is a fact of the project.
 *
 * Nothing here waits for GitHub: `live` only adds counters when the cache
 * had them, and `liveStale` is said on the heading while the next refetch
 * fills it.
 */
export function ProjectRepos({
  project,
  onOpen,
  navigate,
}: {
  project: ProjectDetail;
  onOpen: (repoId: string) => void;
  navigate: Navigate;
}) {
  const t = useT();
  const entries = repoEntries(project);
  const { sorted, sort, toggle } = useSortableTable<RepoEntry, SortKey>(
    entries,
    (entry, key) =>
      key === "student"
        ? entry.label
        : key === "score"
          ? (entry.repo?.scores.final?.points ?? -1)
          : (entry.repo?.effectiveDeadlineAt ?? ""),
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
          >
            {t("project.repos.empty.body")}
          </EmptyState>
        </Card>
      </section>
    );
  }

  const columns: Column<SortKey>[] = [
    { key: "student", label: t(project.groupMode ? "project.col.group" : "results.col.student") },
    { key: "repo", label: t("project.col.repo"), sortable: false, className: T.colMid },
    { key: "commit", label: t("project.col.commit"), sortable: false, className: T.colLow },
    { key: "ci", label: t("project.col.ci"), sortable: false, className: T.colMid },
    { key: "score", label: t("project.col.score"), right: true },
    { key: "deadline", label: t("project.deadline"), className: T.colHigh },
    { key: "state", label: t("project.col.state"), sortable: false },
  ];
  const noneAccepted = project.state === "published" && entries.every((e) => e.repo === null);

  return (
    <section aria-labelledby="project-repos" className="space-y-3">
      {heading}
      {noneAccepted ? <p className="text-sm text-fg-muted">{t("project.repos.none")}</p> : null}
      <Card className={`${T.container} overflow-x-auto`}>
        <table className={T.table}>
          <TableHead columns={columns} sort={sort} onToggle={toggle} />
          <tbody>
            {sorted.map((entry) => {
              const { repo } = entry;
              const opens = repo ? () => onOpen(repo.id) : undefined;
              const own = repo !== null && repo.deadlineAt !== null;
              return (
                <tr
                  key={entry.key}
                  className={cx(
                    T.row,
                    opens && `${T.rowHover} cursor-pointer`,
                    repo?.flags.deleted && "text-fg-faint",
                  )}
                  onClick={opens}
                  {...(opens ? pressable(opens, "row") : {})}
                >
                  <td className={T.td}>
                    <IdentityCell entry={entry} groupMode={project.groupMode} />
                  </td>
                  <td className={`${T.td} ${T.colMid}`}>
                    <RepoCell repo={repo} />
                  </td>
                  <td className={`${T.td} ${T.colLow} text-fg-muted`}>
                    {repo?.lastCommit ? (
                      <span className="inline-flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-xs">{shortSha(repo.lastCommit.sha)}</span>
                        {repo.lastCommit.at ? <RelativeTime iso={repo.lastCommit.at} className="text-xs" /> : null}
                        {repo.live ? (
                          <span className="text-xs text-fg-faint">
                            {t("project.repo.commits", { n: repo.live.commitCount })}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`${T.td} ${T.colMid}`}>
                    <CiBadge status={repo?.ciStatus ?? "none"} />
                  </td>
                  <td className={`${T.td} text-right`}>
                    <Score score={repo?.scores.final ?? null} />
                  </td>
                  <td className={`${T.td} ${T.colHigh} tabular-nums text-fg-muted`}>
                    {repo ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {isoDateTime(repo.effectiveDeadlineAt)}
                        {own ? <Badge tone="amber">{t("project.deadline.own")}</Badge> : null}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={T.td}>{repo ? <StateCell repo={repo} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
