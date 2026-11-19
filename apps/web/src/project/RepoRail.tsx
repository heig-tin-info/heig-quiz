import { Lock, LockOpen } from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectDetail, ProjectRepoView } from "@quiz/contracts";

import { refusedWith } from "../api";
import { DateField } from "../evaluation/TimingStep";
import { useI18n, useT } from "../i18n";
import { Button, Card, Dash, Fact, FieldError, fieldErrorProps, isoDateTime, percent, RelativeTime } from "../ui";
import { CollectionFacts, SyncBadge } from "./parts";
import { classPosition, teacherScoreBlock, type RepoEntry, type RepoPrimary } from "./projectPage";
import { ScoreFacts, TeacherScoreButton } from "./TeacherScoreForm";
import type { RepoWrites } from "./useRepoWrites";

const OWN_DEADLINE_ID = "project-repo-deadline";

/** One card of the rail: a 14 px heading over its content, the cards parted by hairlines. */
function RailSection({ title, children, testId }: { title: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-3 p-5" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The repository's deadline and lock (F-PROJ-09, M3-05a): the effective
 * deadline, the freeze, the lock; its own deadline set or followed back to
 * the project's, and a lock or an unlock by hand — the page's one place for
 * them. Withheld, with its reason, on a repository that cannot be acted on.
 */
function DeadlineSection({ repo, writes, can }: { repo: ProjectRepoView; writes: RepoWrites; can: boolean }) {
  const t = useT();
  const { deadline, lock } = writes;
  const busy = deadline.isPending || lock.isPending;
  const refused = refusedWith(deadline.error, "deadline_past") ? t("project.refusal.deadlinePast") : undefined;
  return (
    <RailSection title={t("project.sheet.deadline")} testId="repo-deadline">
      {!can ? <p className="text-[13px] text-fg-muted">{t("project.sheet.unavailable")}</p> : null}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        <Fact label={t("project.sheet.effective")}>
          <span className="tabular-nums">{isoDateTime(repo.effectiveDeadlineAt)}</span>
        </Fact>
        <Fact label={t("project.score.frozen")}>
          {repo.frozenAt ? (
            <span className="tabular-nums">{isoDateTime(repo.frozenAt)}</span>
          ) : repo.deadlineAppliedAt ? (
            t("project.frozen.provisional")
          ) : (
            <Dash />
          )}
        </Fact>
        <Fact label={t("project.col.state")}>
          {repo.locked ? t("project.lock.locked") : t("project.lock.open")}
          {repo.staffLock !== null ? ` · ${t("project.lock.byStaff")}` : ""}
        </Fact>
      </dl>
      {repo.degraded ? <p className="text-[13px] text-fg-muted">{t("project.sheet.degraded")}</p> : null}
      <div className="flex flex-col gap-1">
        <DateField
          key={repo.deadlineAt ?? ""}
          id={OWN_DEADLINE_ID}
          label={t("project.sheet.ownDeadline")}
          endOfWeek
          disabled={!can || busy}
          value={repo.deadlineAt}
          onCommit={(deadlineAt, reset) => {
            if (deadlineAt === null) {
              reset();
              return;
            }
            deadline.mutate({ deadlineAt }, { onError: reset });
          }}
          {...fieldErrorProps(OWN_DEADLINE_ID, refused)}
        />
        <FieldError id={OWN_DEADLINE_ID}>{refused}</FieldError>
      </div>
      <p className="text-[13px] text-fg-muted">{t("project.sheet.ownDeadline.desc")}</p>
      <div className="flex flex-wrap gap-2">
        {repo.deadlineAt !== null ? (
          <Button variant="secondary" size="sm" disabled={!can} loading={deadline.isPending} onClick={() => deadline.mutate({ deadlineAt: null })}>
            {t("project.sheet.clearDeadline")}
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" disabled={!can} loading={lock.isPending} onClick={() => lock.mutate(!repo.locked)}>
          {repo.locked ? <LockOpen /> : <Lock />} {t(repo.locked ? "project.sheet.unlock" : "project.sheet.lock")}
        </Button>
      </div>
    </RailSection>
  );
}

/**
 * The scores (F-PROJ-13, F-PROJ-14): the slots and their sources, the final
 * review, the adjustment. The teacher's score opens its dialog from here
 * where it is not the page's primary (graded by criteria); before the
 * freeze, or on a project graded `none`, a line says why there is none.
 */
function ScoresSection({
  project,
  repo,
  primary,
  onScore,
}: {
  project: ProjectDetail;
  repo: ProjectRepoView;
  primary: RepoPrimary;
  onScore: () => void;
}) {
  const t = useT();
  const block = teacherScoreBlock(repo, project);
  return (
    <RailSection title={t("project.sheet.scores")} testId="repo-scores">
      {block === "grading_none" ? (
        <p className="text-[13px] text-fg-muted">{t("project.refusal.gradingNone")}</p>
      ) : (
        <>
          <ScoreFacts project={project} repo={repo} />
          {block === "not_frozen" ? (
            <p className="text-[13px] text-fg-muted">{t("project.teacherScore.waitsFreeze")}</p>
          ) : primary !== "teacherScore" ? (
            <TeacherScoreButton repo={repo} onClick={onScore} secondary />
          ) : null}
        </>
      )}
    </RailSection>
  );
}

/**
 * Where the repository's final score sits in the class (`classPosition`):
 * its rank, the median, and a strip of every final score as a share of its
 * maximum, this one's tick taller and in ink. Nothing while it has no final
 * score or fewer than three repositories have one.
 */
function ClassSection({ project, repo }: { project: ProjectDetail; repo: ProjectRepoView }) {
  const t = useT();
  const { locale } = useI18n();
  const place = classPosition(project, repo.id);
  if (!place) return null;
  const at = (rate: number) => ({ left: `calc(${Math.min(1, Math.max(0, rate)) * 100}% - 1px)` });
  return (
    <RailSection title={t("project.repoPage.class")} testId="repo-class">
      <p className="text-base font-semibold tabular-nums">{t("project.repoPage.class.rank", { n: place.rank, total: place.total })}</p>
      <div
        role="img"
        aria-label={t("project.repoPage.class.strip", { rate: percent(place.rate, locale), median: percent(place.median, locale) })}
        className="relative h-6 rounded-full bg-surface-2"
      >
        {place.rates.map((rate, i) => (
          <span key={i} aria-hidden className="absolute top-1.5 h-3 w-0.5 rounded-full bg-fg-faint/60" style={at(rate)} />
        ))}
        <span aria-hidden className="absolute top-0 h-6 w-0.5 rounded-full bg-fg" style={at(place.rate)} />
      </div>
      <p className="flex justify-between text-xs text-fg-muted tabular-nums">
        <span>{t("project.repoPage.class.own", { rate: percent(place.rate, locale) })}</span>
        <span>{t("project.repoPage.class.median", { rate: percent(place.median, locale) })}</span>
      </p>
    </RailSection>
  );
}

/** What else the sheet said of the repository: the group set it follows, the sync, the collection, a malformed score's text. */
function FactsSection({ entry }: { entry: RepoEntry }) {
  const t = useT();
  const { repo } = entry;
  const synced = repo !== null && (repo.sync.outcome !== null || repo.sync.pr !== null);
  const malformed = repo?.flags.malformed ?? null;
  if (entry.kind !== "group" && !synced && repo?.collection == null && malformed === null) return null;
  return (
    <RailSection title={t("project.col.repo")} testId="repo-facts">
      <dl className="grid gap-y-3">
        {entry.kind === "group" ? (
          <Fact label={t("project.groupSet")}>{t(entry.group.stopped ? "project.sheet.stopped" : "project.sheet.follows")}</Fact>
        ) : null}
        {synced ? (
          <Fact label={t("project.sheet.sync")}>
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <SyncBadge repo={repo} />
              {repo.sync.at ? <RelativeTime iso={repo.sync.at} className="text-xs text-fg-muted" /> : null}
            </span>
          </Fact>
        ) : null}
      </dl>
      {repo ? <CollectionFacts repo={repo} /> : null}
      {malformed !== null ? <p className="break-words font-mono text-xs text-fg-muted">{malformed}</p> : null}
    </RailSection>
  );
}

/**
 * The right rail of a repository's page (ADR-137), under the main column
 * below `lg`: the deadline and the lock, the scores, the place in the
 * class, the repository's facts. A row not accepted yet has only its
 * group set to say.
 */
export function RepoRail({
  project,
  entry,
  writes,
  can,
  primary,
  onScore,
}: {
  project: ProjectDetail;
  entry: RepoEntry;
  writes: RepoWrites;
  can: boolean;
  primary: RepoPrimary;
  onScore: () => void;
}) {
  const t = useT();
  const { repo } = entry;
  return (
    <aside aria-label={t("project.repoPage.rail")}>
      <Card className="divide-y divide-line">
        {repo ? <DeadlineSection repo={repo} writes={writes} can={can} /> : null}
        {repo ? <ScoresSection project={project} repo={repo} primary={primary} onScore={onScore} /> : null}
        {repo ? <ClassSection project={project} repo={repo} /> : null}
        <FactsSection entry={entry} />
      </Card>
    </aside>
  );
}
