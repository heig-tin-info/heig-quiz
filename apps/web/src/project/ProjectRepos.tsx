import { FolderGit2, Loader2, Lock, LockOpen, Snowflake, Users } from "lucide-react";

import type { ProjectDetail, ProjectDetailRow, ProjectRepoView } from "@quiz/contracts";

import { Grade } from "../Grade";
import { useT, type Dict } from "../i18n";
import type { Navigate } from "../router";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  GithubIcon,
  isoDateTime,
  pressable,
  RelativeTime,
  SectionHeading,
  T,
  TableHead,
  Tip,
  useSortableTable,
  type Column,
  type Tone,
} from "../ui";
import { repoFlags, repoHref, repoShortName, shortSha } from "./projectPage";

type SortKey = "student" | "score" | "deadline";

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

/** A final score as the table writes it: points out of their maximum, and the grade. */
export function Score({ score }: { score: ProjectRepoView["scores"]["final"] }) {
  const t = useT();
  if (!score) return <span className="text-fg-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
      <span className="tabular-nums">
        {score.points}
        {score.max !== null ? `/${score.max}` : ""}
      </span>
      {score.grade ? (
        <span className="font-semibold tabular-nums">
          <Grade value={score.grade.grade} />
        </span>
      ) : null}
      <span className="text-xs text-fg-faint">{t(`project.score.source.${score.source}`)}</span>
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
      {repo.fullName ? (
        <a
          href={repoHref(repo.fullName)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[13px] hover:underline"
        >
          <GithubIcon className="size-3.5 text-fg-faint" />
          {repoShortName(repo.fullName)}
        </a>
      ) : null}
      {repo.invitationStatus === "pending" ? <Badge tone="amber">{t("project.repo.invitationPending")}</Badge> : null}
    </span>
  );
}

/** The lock, the freeze and the flags of a repository, as tags; on a narrow table the flags fold into one count. */
function StateCell({ repo }: { repo: ProjectRepoView }) {
  const t = useT();
  const flags = repoFlags(repo);
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
 * roster — as the server orders them, until a column is sorted. Seven
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
  const { sorted, sort, toggle } = useSortableTable<ProjectDetailRow, SortKey>(
    project.rows,
    (row, key) =>
      key === "student"
        ? `${row.student.nom} ${row.student.prenom}`
        : key === "score"
          ? row.repo?.scores.final?.points ?? -1
          : row.repo?.effectiveDeadlineAt ?? "",
    null,
  );

  const heading = (
    <SectionHeading
      icon={FolderGit2}
      title={<span id="project-repos">{t("project.repos")}</span>}
      count={project.rows.length}
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
    { key: "student", label: t("project.col.student") },
    { key: "repo", label: t("project.col.repo"), sortable: false, className: T.colMid },
    { key: "commit", label: t("project.col.commit"), sortable: false, className: T.colLow },
    { key: "ci", label: t("project.col.ci"), sortable: false, className: T.colMid },
    { key: "score", label: t("project.col.score"), right: true },
    { key: "deadline", label: t("project.col.deadline"), className: T.colHigh },
    { key: "state", label: t("project.col.state"), sortable: false },
  ];
  const noneAccepted = project.state === "published" && project.rows.every((r) => r.repo === null);

  return (
    <section aria-labelledby="project-repos" className="space-y-3">
      {heading}
      {noneAccepted ? <p className="text-sm text-fg-muted">{t("project.repos.noneAccepted")}</p> : null}
      <Card className={`${T.container} overflow-x-auto`}>
        <table className={T.table}>
          <TableHead columns={columns} sort={sort} onToggle={toggle} />
          <tbody>
            {sorted.map(({ student, repo }) => {
              const key = repo?.id ?? student.enrollmentId ?? student.email;
              const opens = repo ? () => onOpen(repo.id) : undefined;
              const own = repo !== null && repo.deadlineAt !== null;
              return (
                <tr
                  key={key}
                  className={cx(
                    T.row,
                    opens && `${T.rowHover} cursor-pointer`,
                    repo?.flags.deleted && "text-fg-faint",
                  )}
                  onClick={opens}
                  {...(opens ? pressable(opens, "row") : {})}
                >
                  <td className={T.td}>
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span className={cx("font-semibold", repo?.flags.deleted && "font-medium")}>
                        {student.nom} {student.prenom}
                      </span>
                      {student.enrollmentId === null ? (
                        <Badge tone="zinc">{t("project.repo.leftRoster")}</Badge>
                      ) : !student.claimed ? (
                        <span className="text-xs text-fg-faint">{t("project.repo.notClaimed")}</span>
                      ) : student.githubLogin ? (
                        <span className="font-mono text-xs text-fg-faint">{student.githubLogin}</span>
                      ) : null}
                    </span>
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
