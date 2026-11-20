import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCheck, ChevronRight, Lock, RefreshCw, Send, Snowflake } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import {
  CriteriaIncomplete,
  PointsOutOfRange,
  type CriterionGradeWrite,
  type ProjectGradingPass,
  type ProjectGradingRepo,
  type ProjectGradingView,
  type ProjectRegradeAccepted,
  type ProjectRegradeRequest,
  type ProjectValidated,
} from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api, ApiError, refusedWith } from "../../api";
import { useConfirm } from "../../confirm";
import { useT } from "../../i18n";
import { useToast } from "../../notify";
import { activitiesKey, projectGradingKey, projectKey } from "../../queryKeys";
import { useSearchParam, type Navigate } from "../../router";
import { Trail, useClassroomCrumbs } from "../../Trail";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  HeldButton,
  isoDateTime,
  isTyping,
  Menu,
  PageError,
  PageHeader,
  QueryError,
  RelativeTime,
  Skeleton,
  type MenuItem,
} from "../../ui";
import { refusalMessage, releasedWriteHeld, shortSha } from "../projectPage";
import { CommitGraphPanel } from "./CommitGraphPanel";
import { useClassroomOwner } from "../../course/parts";
import { useProjectContestations, RepoContestations } from "./Contestations";
import { CriteriaTable, type GradeWrite } from "./CriteriaTable";
import { gradingPrimary, toValidate, type GradingPrimary } from "./gradingModel";
import { RationaleFold } from "./RationaleFold";
import { RepoBar } from "./RepoBar";

/**
 * The teacher's grading screen of a project graded by criteria (ADR-106 §8,
 * F-PROJ-25, F-PROJ-26), `/projects/:id/grading`, modelled on the
 * evaluation grading screen (`grading/GradingPanel`): ONE REPOSITORY AT A
 * TIME. On top, which repository and where each stands (`RepoBar`, ‹ › and
 * ← / →); under it the last evidence's line and the screen's ONE primary
 * action — Validate this repository, then Next, then Release once every one
 * is validated (`gradingPrimary`); then its criteria (`CriteriaTable`),
 * each one's points editable in place — a teacher's row, never a validation.
 * An automatic criterion of a v3 project folds its CI log under it; below
 * the table, folded, the repository's history (`CommitGraphPanel`, ADR-119
 * §8), what a git criterion is graded from: no action of its own.
 *
 * A criterion with no points (a teacher-only one) holds Validate back: the
 * screen names it above the table, never defaults it to 0. *Validate the
 * rest as proposed* and a Regrade of the repository (one model call, said
 * by its confirmation) are in the overflow menu. On a schema-3 project the
 * confirmation says what a Regrade redoes (ADR-132 §5) and, once released,
 * what the release keeps; it then carries the acknowledgement the server
 * asks. Under the evidence, the latest CI pass's trace (`PassLine`). The
 * release itself is the project page's (its confirmation, its refusals):
 * Release leads there.
 *
 * ADR-139 §13: once released, every criterion write — the points, Validate,
 * *Validate the rest*, a Regrade — is the course owner's: anyone else reads
 * the screen with those controls held, saying why. Under the table, the
 * repository's contestations (`RepoContestations`), a second read joined on
 * (repository, criterion): the reason, and the owner's one answer; a mark
 * on each contested criterion's row, and on the rail a repository holding
 * an open one.
 *
 * The repository on screen lives in `?repo=`, so a reload lands on it.
 */
export function ProjectGradingPage({ id, navigate }: { id: string; navigate: Navigate }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [repoParam, setRepoParam] = useSearchParam("repo", "");
  /** The repositories and criteria a refused *Validate the rest* named. */
  const [incomplete, setIncomplete] = useState<CriteriaIncomplete["repos"] | null>(null);
  /** The history panel stays unfolded from one repository to the next, as the teacher walks them for a git criterion. */
  const [graphOpen, setGraphOpen] = useState(false);

  const view = useQuery<ProjectGradingView>({
    queryKey: projectGradingKey(id),
    queryFn: () => api(`/app/api/projects/${id}/grading`),
  });
  const crumbs = useClassroomCrumbs(view.data?.project.classroomId);
  const contestations = useProjectContestations(id);
  const owner = useClassroomOwner(view.data?.project.classroomId);
  const repos = view.data?.repos ?? [];
  const found = repos.findIndex((r) => r.id === repoParam);
  // Unnamed (or gone): the first repository still to validate, else the first.
  const index = found >= 0 ? found : Math.max(0, repos.findIndex(toValidate));
  const repo: ProjectGradingRepo | undefined = repos[index];
  // The default, once drawn, is pinned in the address: validating it must not move the screen to another one.
  useEffect(() => {
    if (found < 0 && repo) setRepoParam(repo.id);
  }, [found, repo, setRepoParam]);

  /** A repository as a write answered it, in place; the project page (its primary action, its scores) re-reads. */
  const settle = async (entry: ProjectGradingRepo) => {
    qc.setQueryData<ProjectGradingView>(projectGradingKey(id), (v) =>
      v ? { ...v, repos: v.repos.map((r) => (r.id === entry.id ? entry : r)) } : v,
    );
    await qc.invalidateQueries({ queryKey: projectKey(id), refetchType: "none" });
  };
  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: projectKey(id) }), qc.invalidateQueries({ queryKey: activitiesKey })]);
  const failed = (error: unknown) => toast(refusalMessage(error, t), "error");

  const grade = useMutation({
    mutationFn: (v: { repoId: string; criterionId: string; body: CriterionGradeWrite }) =>
      api<ProjectGradingRepo>(`/app/api/projects/${id}/repos/${v.repoId}/criteria/${encodeURIComponent(v.criterionId)}`, {
        method: "PUT",
        body: JSON.stringify(v.body satisfies CriterionGradeWrite),
      }),
    onSuccess: settle,
    // Out of range (the field already says it): the toast names the range the server holds.
    onError: (error) => {
      const range = error instanceof ApiError ? PointsOutOfRange.safeParse(error.body) : null;
      if (range?.success) toast(`${refusalMessage(error, t)} ${t("ui.points.range", { min: range.data.min, max: range.data.max })}`, "error");
      else failed(error);
    },
  });
  const validate = useMutation({
    mutationFn: (repoId: string) => api<ProjectGradingRepo>(`/app/api/projects/${id}/repos/${repoId}/validate`, { method: "POST" }),
    onSuccess: async (entry) => {
      await settle(entry);
      toast(t("project.grading.validated.toast", { name: entry.label }), "success");
    },
    // Refused, the screen was stale: it re-reads, and names what is missing above the table.
    onError: async (error) => {
      if (refusedWith(error, "criteria_incomplete")) await refresh();
      failed(error);
    },
  });
  const validateRest = useMutation({
    mutationFn: () => api<ProjectValidated>(`/app/api/projects/${id}/validate`, { method: "POST" }),
    onSuccess: async (result) => {
      setIncomplete(null);
      await refresh();
      toast(t("project.grading.validateRest.done", { n: result.validated }), "success");
    },
    onError: (error) => {
      const body = error instanceof ApiError ? CriteriaIncomplete.safeParse(error.body) : null;
      if (body?.success) setIncomplete(body.data.repos);
      else failed(error);
    },
  });
  const regrade = useMutation({
    // One repository's regrade, or the whole project's (`repoId` undefined).
    mutationFn: (v: { repoId?: string; body: ProjectRegradeRequest }) =>
      api<ProjectRegradeAccepted>(`/app/api/projects/${id}${v.repoId ? `/repos/${v.repoId}` : ""}/regrade`, {
        method: "POST",
        body: JSON.stringify(v.body satisfies ProjectRegradeRequest),
      }),
    onSuccess: async () => {
      await refresh();
      toast(t("project.grading.regrade.done"), "success");
    },
    // Released meanwhile (another tab): the screen re-reads, so the next confirmation says it and carries the acknowledgement.
    onError: async (error) => {
      if (refusedWith(error, "regrade_released")) await qc.invalidateQueries({ queryKey: projectGradingKey(id) });
      failed(error);
    },
  });

  const jump = (i: number) => {
    const target = repos[i];
    if (target) setRepoParam(target.id);
  };
  // ← / → walk the repositories, as on the evaluation's grading screen (`useGradingKeys`):
  // never while typing, never under a layer (a confirmation, a menu's dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (isTyping(document.activeElement) || document.querySelector('[role="dialog"]')) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = index + (e.key === "ArrowLeft" ? -1 : 1);
      if (i < 0 || i >= repos.length) return;
      e.preventDefault();
      setRepoParam(repos[i]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, repos, setRepoParam]);

  if (view.isLoading) return <GradingSkeleton />;
  if (view.isError) return <PageError title={t("project.grading.loadFailed")} query={view} />;
  const data = view.data!;

  const left = repos.filter(toValidate).length;
  // ADR-139 §13: a released project's criterion writes are the owner's; anyone else reads why.
  const ownerOnly = releasedWriteHeld(data.project.released, owner);
  const heldWhy = t("project.refusal.gradeOwnerRequired");
  const held = ownerOnly ? { disabled: true, description: heldWhy } : {};
  const onValidateRest = async () => {
    if (
      await confirm({
        title: t("project.grading.validateRest.title"),
        message: t("project.grading.validateRest.body", { n: left }),
        confirmLabel: t("project.grading.validateRest.confirm"),
      })
    ) {
      validateRest.mutate();
    }
  };
  // A schema-3 Regrade redoes the machine's correction (ADR-132 §5): its copy, and once released what the students read.
  // The acknowledgement goes with every Regrade of a released project; the server asks it of a schema-3 one only.
  const ci = data.project.schemaVersion === 3;
  const regradeBody: ProjectRegradeRequest = data.project.released ? { releasedAcknowledged: true } : {};
  const regradeMessage = (body: string) => (ci && data.project.released ? `${body} ${t("project.grading.regradeReleased.body")}` : body);
  const onRegradeAll = async () => {
    const frozen = repos.filter((r) => r.frozen).length;
    if (
      await confirm({
        title: t("project.grading.regradeAll.title"),
        message: regradeMessage(t(ci ? "project.grading.regradeAllCi.body" : "project.grading.regradeAll.body", { n: frozen })),
        confirmLabel: t("project.grading.regrade.confirm"),
      })
    ) {
      regrade.mutate({ body: regradeBody });
    }
  };
  const onRegrade = async (target: ProjectGradingRepo) => {
    if (
      await confirm({
        title: t("project.grading.regrade.title", { name: target.label }),
        message: regradeMessage(t(ci ? "project.grading.regradeCi.body" : "project.grading.regrade.body")),
        confirmLabel: t("project.grading.regrade.confirm"),
      })
    ) {
      regrade.mutate({ repoId: target.id, body: regradeBody });
    }
  };
  const menuItems: MenuItem[] = [
    { label: t("project.grading.validateRest"), icon: CheckCheck, onSelect: () => void onValidateRest(), disabled: left === 0, ...held },
    ...(repo?.frozen ? [{ label: t("project.grading.regrade"), icon: RefreshCw, onSelect: () => void onRegrade(repo), ...held }] : []),
    ...(repos.some((r) => r.frozen) ? [{ label: t("project.grading.regradeAll"), icon: RefreshCw, onSelect: () => void onRegradeAll(), ...held }] : []),
  ];

  const header = (
    <PageHeader
      eyebrow={
        <Trail
          navigate={navigate}
          items={[...crumbs, { label: data.project.name, route: { view: "project", id } }, { label: t("project.grading.title") }]}
        />
      }
      title={t("project.grading.title")}
      menu={repos.some((r) => r.frozen) ? <Menu items={menuItems} /> : undefined}
    />
  );

  // Nothing to grade yet — no repository, or none frozen for good: ONE empty state, the deadline saying when.
  if (!repo || !repos.some((r) => r.frozen)) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState
            icon={Snowflake}
            title={t("project.grading.empty.title")}
            action={
              <Button variant="secondary" onClick={() => navigate({ view: "project", id })}>
                {t("project.grading.backToProject")}
              </Button>
            }
          >
            {t("project.grading.empty.body", { date: isoDateTime(data.project.deadlineAt) })}
          </EmptyState>
        </Card>
      </div>
    );
  }

  const primary = gradingPrimary(repos, index);
  // A criterion's words, from any repository's table: every one lists the snapshot's criteria.
  const describe = (criterionId: string) => repo.table.find((c) => c.criterionId === criterionId)?.description ?? criterionId;
  const onGrade: GradeWrite = (criterionId, body) => grade.mutate({ repoId: repo.id, criterionId, body });
  const contested = (contestations.data?.contestations ?? []).filter((c) => c.repoId === repo.id);
  const openByRepo = contestations.data?.openByRepo ?? {};

  return (
    <div className="space-y-5">
      {header}
      {ownerOnly ? <Alert icon={Lock} title={heldWhy} /> : null}
      {incomplete ? (
        <Alert tone="danger" icon={AlertTriangle} title={t("project.grading.validateRest.incomplete")}>
          <ul className="mt-1 space-y-0.5">
            {incomplete.map((r) => (
              <li key={r.repoId}>
                <span className="font-medium">{repos.find((x) => x.id === r.repoId)?.label ?? r.repoId}</span>
                {" — "}
                {r.missing.map(describe).join(", ")}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <RepoBar repos={repos} index={index} onJump={jump} openByRepo={openByRepo} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <EvidenceLine repo={repo} />
        <span className="flex-1" />
        <PrimaryButton
          action={primary}
          held={ownerOnly ? heldWhy : null}
          busy={validate.isPending}
          onValidate={() => validate.mutate(repo.id)}
          onNext={jump}
          onRelease={() => navigate({ view: "project", id })}
        />
      </div>
      <PassLine pass={repo.pass} describe={describe} />
      {repo.frozen && repo.validation.missing.length > 0 ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("project.grading.missing.title")}>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {repo.validation.missing.map((c) => (
              <li key={c}>{describe(c)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <Card className="overflow-hidden">
        <CriteriaTable
          rows={repo.table}
          label={t("project.grading.table", { name: repo.label })}
          writable={repo.frozen && !ownerOnly}
          onGrade={onGrade}
          repoPath={`/app/api/projects/${id}/repos/${repo.id}`}
          contestations={contested}
        />
      </Card>
      {contestations.isError ? (
        <QueryError title={t("project.contest.loadFailed")} query={contestations} />
      ) : (
        <RepoContestations projectId={id} repo={repo} contestations={contested} isOwner={owner} />
      )}
      <CommitGraphPanel projectId={id} repoId={repo.id} open={graphOpen} onOpenChange={setGraphOpen} />
      <p className="hidden text-xs text-fg-faint sm:block">{t("project.grading.keys")}</p>
    </div>
  );
}

/**
 * The repository's last evidence in one line (ADR-106 §3): the tests passed,
 * the commit graded and when — or why there is none —, and the total once
 * every criterion is validated.
 */
function EvidenceLine({ repo }: { repo: ProjectGradingRepo }) {
  const t = useT();
  const { evidence, total } = repo;
  const parts: ReactNode[] = [];
  if (!evidence) parts.push(<span key="none">{t("project.grading.evidence.none")}</span>);
  else {
    if (evidence.status === "ok") {
      parts.push(
        <span key="tests" className="tabular-nums">
          {t("project.grading.evidence.tests", { passed: evidence.casesPassed, total: evidence.casesTotal })}
        </span>,
      );
    } else {
      parts.push(
        <Badge key="status" tone="zinc" icon={AlertTriangle}>
          {t(`project.grading.reason.${evidence.status}`)}
        </Badge>,
      );
    }
    if (evidence.targetSha) {
      parts.push(
        <span key="sha" className="font-mono text-xs">
          {t("project.grading.evidence.commit", { sha: shortSha(evidence.targetSha) })}
        </span>,
      );
    }
    parts.push(<RelativeTime key="at" iso={evidence.createdAt} className="text-xs" />);
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-muted">
      <span className="font-semibold text-fg">{t("project.grading.evidence")}</span>
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-x-2">
          {i > 0 ? <span aria-hidden>·</span> : null}
          {part}
        </span>
      ))}
      <span aria-hidden>·</span>
      {total ? (
        <span className="font-semibold text-fg tabular-nums">{t("project.grading.total", { points: formatPoints(total.points), max: formatPoints(total.max) })}</span>
      ) : (
        <span>{t("project.grading.total.pending")}</span>
      )}
    </p>
  );
}

/**
 * The repository's latest CI pass, staff only (ADR-132 §5, §6): how many
 * files its graded commit holds in the distribution's version, their paths
 * folded under it; and the criteria that got no new result while their
 * earlier row stayed, named, with why. Nothing when it has neither.
 */
function PassLine({ pass, describe }: { pass: ProjectGradingPass | null; describe: (criterionId: string) => string }) {
  const t = useT();
  if (!pass || (pass.replaced.count === 0 && pass.kept.length === 0)) return null;
  const { count, paths } = pass.replaced;
  const reasons = [...new Set(pass.kept.map((k) => k.reason))].map((reason) => t(`project.grading.reason.${reason}`)).join(", ");
  return (
    <div className="flex flex-col items-start gap-1 text-[13px] text-fg-muted">
      {count > 0 ? (
        <RationaleFold label={t(count === 1 ? "project.grading.pass.replaced.one" : "project.grading.pass.replaced", { n: count })}>
          <ul className="space-y-0.5 font-mono text-xs">
            {paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {count > paths.length ? <span className="text-xs">{t("project.grading.pass.more", { n: count - paths.length })}</span> : null}
        </RationaleFold>
      ) : null}
      {pass.kept.length > 0 ? (
        <p className="inline-flex items-center gap-1.5">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
          {t(pass.kept.length === 1 ? "project.grading.pass.kept.one" : "project.grading.pass.kept", {
            criteria: pass.kept.map((k) => describe(k.criterionId)).join(", "),
            reasons,
          })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The screen's one accent button, in the state `gradingPrimary` decided:
 * Validate, then Next, then Release (on the project page); held
 * (`HeldButton`, the evaluation grading screen's too), saying why, while a
 * criterion has no points or a repository is not frozen.
 */
function PrimaryButton({
  action,
  held,
  busy,
  onValidate,
  onNext,
  onRelease,
}: {
  action: GradingPrimary;
  /** Why Validate is held for this reader (a released project's, the owner's: ADR-139 §13), or null. */
  held: string | null;
  busy: boolean;
  onValidate: () => void;
  onNext: (index: number) => void;
  onRelease: () => void;
}) {
  const t = useT();
  switch (action.kind) {
    case "validate":
      return held ? (
        <HeldButton disabledReason={held}>
          <CheckCheck /> {t("project.grading.validate")}
        </HeldButton>
      ) : (
        <Button loading={busy} onClick={onValidate}>
          <CheckCheck /> {t("project.grading.validate")}
        </Button>
      );
    case "blocked":
      return (
        <HeldButton disabledReason={t(action.reason === "missing" ? "project.grading.blocked.missing" : "project.grading.blocked.notFrozen")}>
          <CheckCheck /> {t("project.grading.validate")}
        </HeldButton>
      );
    case "next":
      return (
        <Button onClick={() => onNext(action.index)}>
          {t("project.grading.next")} <ChevronRight />
        </Button>
      );
    case "release":
      return (
        <Button onClick={onRelease}>
          <Send /> {t("project.release")}
        </Button>
      );
  }
}

/** The shape of what is coming: the header, the bar and a few rows. */
function GradingSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-20 w-full" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}
