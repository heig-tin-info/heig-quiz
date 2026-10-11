import { Flag, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

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
  type Tone,
} from "../ui";
import { useCheckpoints } from "./ProjectCheckpoints";
import { railSteps, type CheckpointStatus, type RailStep } from "./projectPage";

const STATUS_TONE: Record<CheckpointStatus, Tone> = { dispatched: "green", void: "zinc", scheduled: "amber" };

/** One step of the rail: a marker on the line, a title, its date and the lines that qualify it. */
function Step({
  title,
  done,
  muted,
  children,
  action,
}: {
  title: ReactNode;
  done: boolean;
  muted?: boolean;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className={cx("group relative min-w-0 flex-1 pb-5 pl-7 last:pb-0 md:pb-0 md:pl-0 md:pr-4 md:pt-7", muted && "opacity-60")}>
      {/* The line, vertical on a phone and horizontal beside the next step; the marker sits on it. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-[6px] top-3 w-px bg-line group-last:hidden md:bottom-auto md:left-0 md:right-0 md:top-[6px] md:h-px md:w-auto"
      />
      <span
        aria-hidden
        className={cx(
          "absolute left-0 top-1 size-3.5 rounded-full border-2 md:top-0",
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
  const auto = project.gradingMode === "auto";
  const archived = project.archivedAt !== null;
  // A draft takes checkpoints too (F-PROJ-01); a locked project's deadline is behind them.
  const canAdd = auto && project.state !== "locked" && !archived;

  const stepOf = (step: RailStep, key: string): ReactNode => {
    switch (step.kind) {
      case "published":
        return (
          <Step key={key} title={t("project.rail.published")} done={step.done}>
            <p className="tabular-nums">{step.at ? isoDateTime(step.at) : t("project.rail.atPublication")}</p>
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
            <p className="tabular-nums">
              {dated ? isoDateTime(c.dueAt) : null}
              {dated && c.offsetDays !== null ? " · " : null}
              {c.offsetDays !== null ? t("project.checkpoint.offsetLabel", { n: -c.offsetDays }) : null}
            </p>
            <p>
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
            <p className="tabular-nums">
              {"at" in step
                ? isoDateTime(step.at)
                : step.afterDays === 1
                  ? t("project.rail.afterPublication.one")
                  : t("project.rail.afterPublication", { n: step.afterDays })}
            </p>
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
            <p className="tabular-nums">{step.at ? isoDateTime(step.at) : t("project.rail.toCome")}</p>
          </Step>
        );
    }
  };

  const checkpoints: ReviewCheckpoint[] = list.data ?? [];
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
          <ol className="flex flex-col md:flex-row">
            {railSteps(project, checkpoints).map((step, i) => stepOf(step, `${step.kind}-${i}`))}
          </ol>
          {auto && checkpoints.length === 0 ? (
            <p className="mt-4 text-[13px] text-fg-muted">{t("project.checkpoints.empty")}</p>
          ) : null}
        </Card>
      )}
      {dialog}
    </section>
  );
}
