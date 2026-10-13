import { Flag, Plus, Trash2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import type { ProjectDetail, ReviewCheckpoint } from "@quiz/contracts";

import { useT } from "../i18n";
import {
  Actions,
  Badge,
  Button,
  Card,
  cx,
  isoDateTime,
  QueryError,
  RelativeTime,
  SectionHeading,
  Skeleton,
  TimeLeft,
  type Tone,
  useNow,
} from "../ui";
import { useCheckpoints } from "./ProjectCheckpoints";
import { railCountdown, railSteps, type CheckpointStatus, type RailStep } from "./projectPage";

const STATUS_TONE: Record<CheckpointStatus, Tone> = { dispatched: "green", void: "zinc", scheduled: "amber" };

/** A date: never broken, never cut. */
const When = ({ iso }: { iso: string }) => <span className="whitespace-nowrap tabular-nums">{isoDateTime(iso)}</span>;

/**
 * One step of the rail: a marker on the line, a title, its date and the lines
 * that qualify it. `fill` (0..1) is how much of the line leaving it the
 * countdown's accent bar covers, while the project is open.
 */
function Step({
  title,
  done,
  muted,
  fill = 0,
  children,
  action,
}: {
  title: ReactNode;
  done: boolean;
  muted?: boolean;
  fill?: number;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className={cx("group relative min-w-0 flex-1 pb-5 pl-7 last:pb-0 xl:pb-0 xl:pl-0 xl:pr-4 xl:pt-7", muted && "opacity-60")}>
      {/* The line, vertical on a phone and horizontal beside the next step; the marker sits on it. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-[6px] top-3 w-px bg-line group-last:hidden xl:bottom-auto xl:left-0 xl:right-0 xl:top-[6px] xl:h-px xl:w-auto"
      >
        {/* The countdown's bar: 3 px of accent over the hairline, growing down (a phone) or right (xl). */}
        {fill > 0 ? (
          <span
            data-testid="rail-fill"
            style={{ "--fill": `${(fill * 100).toFixed(2)}%` } as CSSProperties}
            className="absolute left-1/2 top-0 h-[var(--fill)] w-[3px] -translate-x-1/2 rounded-full bg-accent motion-safe:transition-[width,height] motion-safe:duration-200 xl:left-0 xl:top-1/2 xl:h-[3px] xl:w-[var(--fill)] xl:translate-x-0 xl:-translate-y-1/2"
          />
        ) : null}
      </span>
      <span
        aria-hidden
        className={cx(
          "absolute left-0 top-1 size-3.5 rounded-full border-2 xl:top-0",
          done ? "border-fg-muted bg-fg-muted" : "border-line-strong bg-surface",
        )}
      />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5 text-[13px] text-fg-muted">
          <p className="text-sm font-medium text-fg">{title}</p>
          {children}
        </div>
        {action}
      </div>
    </li>
  );
}

/**
 * The project's lifecycle as a rail (F-PROJ-09, F-PROJ-11): Published → each
 * review checkpoint → Deadline → Freeze → Release, left to right (top to
 * bottom on a phone). A checkpoint the deadline left void sits after the
 * freeze, greyed, "never fires", still deletable; a project graded `none`
 * has no checkpoints and no Release step. "Add a checkpoint" is offered on a
 * draft or a published project, never once locked or archived.
 */
export function ProjectRail({ project }: { project: ProjectDetail }) {
  const t = useT();
  const { list, onDelete, openAdd, dialog } = useCheckpoints(project);
  // The rail's own clock (ADR-104 §3, amendment of 2026-10-13): the shared minute timer, never a page tick.
  const now = useNow(60_000);
  const auto = project.gradingMode === "auto";
  const archived = project.archivedAt !== null;
  // A draft takes checkpoints too (F-PROJ-01); a locked project's deadline is behind them.
  const canAdd = auto && project.state !== "locked" && !archived;

  const checkpoints: ReviewCheckpoint[] = list.data ?? [];
  const steps = railSteps(project, checkpoints);
  const countdown = railCountdown(project, steps, now);

  const stepOf = (step: RailStep, i: number): ReactNode => {
    const key = `${step.kind}-${i}`;
    const fill = countdown?.fills[i];
    switch (step.kind) {
      case "published":
        return (
          <Step key={key} title={t("project.rail.published")} done={step.done} fill={fill}>
            <p>{step.at ? <When iso={step.at} /> : t("project.rail.atPublication")}</p>
          </Step>
        );
      case "checkpoint": {
        const { checkpoint: c, status, dated } = step;
        return (
          <Step
            key={c.id}
            title={<span className="font-mono text-[13px] font-semibold">{c.name}</span>}
            done={status === "dispatched"}
            muted={status === "void"}
            fill={fill}
            action={
              status !== "dispatched" && !archived ? (
                <Actions
                  size="sm"
                  items={[
                    {
                      label: t("project.checkpoint.delete", { name: c.name }),
                      icon: Trash2,
                      danger: true,
                      onSelect: () => void onDelete(c),
                    },
                  ]}
                />
              ) : null
            }
          >
            {/* A checkpoint counted from a deadline not set yet has no date: only its D-n. */}
            {dated ? <p><When iso={c.dueAt} /></p> : null}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {c.offsetDays !== null ? (
                <span className="whitespace-nowrap tabular-nums">{t("project.checkpoint.offsetLabel", { n: -c.offsetDays })}</span>
              ) : null}
              <Badge tone={STATUS_TONE[status]}>
                {t(`project.checkpoint.status.${status}`)}
                {status === "dispatched" ? (
                  <>
                    {" "}
                    <RelativeTime iso={c.dispatchedAt!} />
                  </>
                ) : null}
              </Badge>
            </p>
            {status === "void" ? <p className="text-xs text-fg-faint">{t("project.rail.neverFires")}</p> : null}
          </Step>
        );
      }
      case "deadline":
        return (
          <Step key={key} title={t("project.deadline")} done={step.done}>
            <p>
              {"at" in step
                ? <When iso={step.at} />
                : step.afterDays === 1
                  ? t("project.rail.afterPublication.one")
                  : t("project.rail.afterPublication", { n: step.afterDays })}
            </p>
            {countdown ? (
              <p className="pt-0.5 text-lg font-semibold leading-tight text-accent [&_svg]:size-4">
                <TimeLeft iso={countdown.deadline} />
              </p>
            ) : null}
          </Step>
        );
      case "freeze":
        return (
          <Step key={key} title={t("project.rail.freeze")} done={step.done}>
            <p>{t("project.rail.grace", { n: step.graceMinutes })}</p>
            {step.later > 0 && step.lastLater ? (
              <p>{t("project.rail.later", { n: step.later, date: isoDateTime(step.lastLater) })}</p>
            ) : null}
          </Step>
        );
      case "release":
        return (
          <Step key={key} title={t("project.rail.release")} done={step.at !== null}>
            <p>{step.at ? <When iso={step.at} /> : t("project.rail.toCome")}</p>
          </Step>
        );
    }
  };

  return (
    <section aria-labelledby="project-rail" className="space-y-3" data-coach="project.checkpoints">
      <SectionHeading
        icon={Flag}
        title={<span id="project-rail">{t("project.rail")}</span>}
        description={auto ? t("project.checkpoints.desc") : undefined}
        actions={
          canAdd ? (
            <Button variant="secondary" size="sm" onClick={openAdd}>
              <Plus /> {t("project.checkpoints.add")}
            </Button>
          ) : undefined
        }
      />
      {auto && list.isLoading ? (
        <Skeleton className="h-24" />
      ) : auto && list.isError ? (
        <QueryError title={t("project.checkpoints.failed")} query={list} />
      ) : (
        <Card className="px-4 py-4">
          <ol className="flex flex-col xl:flex-row">{steps.map(stepOf)}</ol>
          {countdown ? (
            // The bar is drawn in segments between the markers; this is its one value for a screen reader.
            <span
              role="progressbar"
              className="sr-only"
              aria-label={t("project.rail.progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(countdown.progress * 100)}
            />
          ) : null}
          {auto && checkpoints.length === 0 ? (
            <p className="mt-4 text-[13px] text-fg-muted">{t("project.checkpoints.empty")}</p>
          ) : null}
        </Card>
      )}
      {dialog}
    </section>
  );
}
