import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";

import { COMMIT_GRAPH_MAX_PER_BRANCH, ProjectCommitGraph, type ProjectCommit } from "@quiz/contracts";

import { api } from "../../api";
import { useT } from "../../i18n";
import { projectCommitsKey } from "../../queryKeys";
import { Badge, cx, Disclosure, isoDateTime, QueryError, Skeleton, Tip } from "../../ui";
import { shortSha } from "../projectPage";
import { graphLayout, type GraphRow } from "./commitGraph";

/** A member's colour: the categorical slots of the charts, in the members' order; anyone else neutral. */
const memberColour = (member: number | null) => (member === null ? "var(--fg-faint)" : `var(--chart-${(member % 8) + 1})`);

const ROW = 44;
const LANE = 14;
const x = (lane: number) => LANE / 2 + lane * LANE;
const MID = ROW / 2;

/**
 * The selected repository's history on the grading screen (ADR-119 §8):
 * what a teacher reads to grade a git criterion, beside the criteria and
 * below them, folded — it is no action, and the screen's one is Validate.
 * Unfolded, it reads the graph through the App (cached by the server as
 * the live state, never stored): the handed-out branches' commits with
 * their parents, newest first, each commit's message, its DECLARED author
 * (git's field, which anyone writes) in its member's colour when GitHub
 * matched it to a linked account, its date, the platform's receipt time,
 * the handed-out and the App's commits marked. Staff only.
 */
export function CommitGraphPanel({
  projectId,
  repoId,
  open,
  onOpenChange,
}: {
  projectId: string;
  repoId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Disclosure
      title={
        <>
          <GitBranch aria-hidden className="size-4 text-fg-faint" />
          {t("project.commits.title")}
        </>
      }
      desc={t("project.commits.desc")}
      open={open}
      onOpenChange={onOpenChange}
    >
      <GraphBody projectId={projectId} repoId={repoId} />
    </Disclosure>
  );
}

function GraphBody({ projectId, repoId }: { projectId: string; repoId: string }) {
  const t = useT();
  const graph = useQuery<ProjectCommitGraph>({
    queryKey: projectCommitsKey(projectId, repoId),
    queryFn: async () => ProjectCommitGraph.parse(await api(`/app/api/projects/${projectId}/repos/${repoId}/commits`)),
  });
  if (graph.isLoading) {
    return (
      <div className="space-y-2 py-4" role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  }
  if (graph.isError) {
    return (
      <div className="py-4">
        <QueryError title={t("project.commits.loadFailed")} query={graph} />
      </div>
    );
  }
  const data = graph.data!;
  if (data.status === "unavailable") return <p className="py-4 text-[13px] text-fg-muted">{t(`project.commits.unavailable.${data.reason}`)}</p>;
  if (data.commits.length === 0) return <p className="py-4 text-[13px] text-fg-muted">{t("project.commits.empty")}</p>;
  return (
    <>
      <Legend members={data.members} />
      <Graph commits={data.commits} branches={data.branches} />
      {data.truncated ? <p className="py-3 text-xs text-fg-faint">{t("project.commits.truncated", { n: COMMIT_GRAPH_MAX_PER_BRANCH })}</p> : null}
    </>
  );
}

/** Who wears which colour: each linked member, then everyone else; the declared author explained once. */
function Legend({ members }: { members: Extract<ProjectCommitGraph, { status: "ok" }>["members"] }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3 text-xs text-fg-muted" data-testid="commit-legend">
      <Tip label={t("project.commits.declaredAuthor.help")}>
        <span className="font-medium text-fg underline decoration-dotted underline-offset-2">{t("project.commits.declaredAuthor")}</span>
      </Tip>
      {members.map((m, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <Dot colour={memberColour(i)} />
          {m.name}
          {m.login ? <span className="font-mono text-fg-faint">@{m.login}</span> : null}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <Dot colour={memberColour(null)} />
        {t("project.commits.others")}
      </span>
    </div>
  );
}

const Dot = ({ colour }: { colour: string }) => (
  <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
);

function Graph({ commits, branches }: { commits: ProjectCommit[]; branches: { name: string; head: string | null }[] }) {
  const { rows, lanes } = graphLayout(commits);
  const heads = new Map<string, string[]>();
  for (const b of branches) if (b.head) heads.set(b.head, [...(heads.get(b.head) ?? []), b.name]);
  const width = Math.max(1, lanes) * LANE;
  return (
    <ol className="py-2" data-testid="commit-graph">
      {rows.map((row) => (
        <li key={row.commit.sha} className="flex items-stretch gap-2" style={{ height: ROW }} data-testid="commit-row">
          <Lanes row={row} width={width} />
          <CommitText commit={row.commit} branches={heads.get(row.commit.sha) ?? []} />
        </li>
      ))}
    </ol>
  );
}

/** One row's slice of the graph: the lanes passing by, those ending on the commit, those its parents continue in. */
function Lanes({ row, width }: { row: GraphRow; width: number }) {
  const { col, commit } = row;
  const merge = commit.parents.length > 1;
  const curve = (from: number, y0: number, to: number, y1: number) => {
    const half = (y1 - y0) / 2;
    return `M ${x(from)} ${y0} C ${x(from)} ${y0 + half}, ${x(to)} ${y0 + half}, ${x(to)} ${y1}`;
  };
  return (
    <svg aria-hidden width={width} height={ROW} className="shrink-0 overflow-visible" data-merge={merge || undefined}>
      <g fill="none" stroke="var(--fg-faint)" strokeOpacity={0.55} strokeWidth={1.5}>
        {row.through.map((i) => (
          <line key={`t${i}`} x1={x(i)} y1={0} x2={x(i)} y2={ROW} />
        ))}
        {row.incoming.map((i) => (
          <path key={`i${i}`} d={curve(i, 0, col, MID)} />
        ))}
        {row.outgoing.map((i) => (
          <path key={`o${i}`} d={curve(col, MID, i, ROW)} />
        ))}
      </g>
      {merge ? (
        <circle cx={x(col)} cy={MID} r={4.5} fill="var(--surface)" stroke={memberColour(commit.member)} strokeWidth={2} />
      ) : (
        <circle cx={x(col)} cy={MID} r={4.5} fill={memberColour(commit.member)} />
      )}
    </svg>
  );
}

/** The message's first line, then the declared author in their colour, the date, the receipt, the sha; the marks as badges. */
function CommitText({ commit, branches }: { commit: ProjectCommit; branches: string[] }) {
  const t = useT();
  const subject = commit.message.split("\n", 1)[0] ?? "";
  return (
    <span className="flex min-w-0 flex-1 flex-col justify-center">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[13px] text-fg" title={commit.message}>
          {subject}
        </span>
        {branches.map((b) => (
          <Badge key={b} tone="blue" className="shrink-0 font-mono">
            {b}
          </Badge>
        ))}
        {commit.parents.length > 1 ? (
          <Badge tone="zinc" className="shrink-0">
            {t("project.commits.merge")}
          </Badge>
        ) : null}
        {commit.mark ? (
          <Badge tone={commit.mark === "app" ? "amber" : "zinc"} className="shrink-0">
            {t(`project.commits.mark.${commit.mark}`)}
          </Badge>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-x-1.5 truncate text-xs text-fg-muted">
        <span className={cx("inline-flex min-w-0 items-center gap-1", commit.member !== null && "font-medium text-fg")}>
          <Dot colour={memberColour(commit.member)} />
          <span className="truncate">{commit.authorName || "—"}</span>
        </span>
        {commit.authoredAt ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{isoDateTime(commit.authoredAt)}</span>
          </>
        ) : null}
        {commit.receivedAt ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{t("project.commits.received", { date: isoDateTime(commit.receivedAt) })}</span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <span className="shrink-0 font-mono text-fg-faint">{shortSha(commit.sha)}</span>
      </span>
    </span>
  );
}
