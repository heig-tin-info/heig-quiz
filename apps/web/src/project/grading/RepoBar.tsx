import { Check, Users } from "lucide-react";

import type { ProjectGradingRepo } from "@quiz/contracts";

import { StepBar } from "../../grading/StepBar";
import { openContestationsWords } from "../../contestation/ContestationLine";
import { useT, type TFunction } from "../../i18n";
import { Badge } from "../../ui";

/** Where a repository stands, in words: validated, not frozen, criteria without points, or how many to validate. */
export function standingWords(repo: ProjectGradingRepo, t: TFunction): string {
  const { validation } = repo;
  if (validation.validated) return t("project.grading.validated");
  if (!repo.frozen) return t("project.grading.notFrozen");
  if (validation.missing.length > 0) {
    return validation.missing.length === 1
      ? t("project.grading.withoutPoints.one")
      : t("project.grading.withoutPoints", { n: validation.missing.length });
  }
  return validation.proposed.length === 1
    ? t("project.grading.toValidate.one")
    : t("project.grading.toValidate", { n: validation.proposed.length });
}

/**
 * Which repository is being graded, and where every one stands (ADR-106
 * §8), on the evaluation grading screen's `StepBar`: a validated
 * repository is "done"; its name after the counter, the count validated
 * and its standing before the last chevron.
 */
export function RepoBar({
  repos,
  index,
  onJump,
  openByRepo = {},
}: {
  repos: ProjectGradingRepo[];
  index: number;
  onJump: (index: number) => void;
  /** ADR-139 §13: the open contestations per repository, flagged on the rail. */
  openByRepo?: Readonly<Record<string, number>>;
}) {
  const t = useT();
  const flagOf = (r: ProjectGradingRepo): string | undefined => {
    const open = openByRepo[r.id] ?? 0;
    const words = [
      // Its latest pass left earlier rows standing for lack of a result (ADR-132 §5).
      r.pass && r.pass.kept.length > 0 ? t("project.grading.pass.keptFlag") : null,
      open > 0 ? openContestationsWords(open, t) : null,
    ].filter((w) => w !== null);
    return words.length > 0 ? words.join(" · ") : undefined;
  };
  const repo = repos[index];
  if (!repo) return null;
  return (
    <StepBar
      label={t("project.grading.repos")}
      position={t("project.grading.position", { n: index + 1, total: repos.length })}
      prevLabel={t("project.grading.prevRepo")}
      nextLabel={t("project.grading.nextRepo")}
      index={index}
      onJump={onJump}
      steps={repos.map((r) => ({
        id: r.id,
        label: r.label,
        description: standingWords(r, t),
        done: r.validation.validated,
        flag: flagOf(r),
      }))}
      lead={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">{repo.label}</span>
          {repo.group ? (
            <Badge tone="zinc" icon={Users}>
              {t("project.grading.group")}
            </Badge>
          ) : null}
        </span>
      }
      status={
        <>
          <span className="text-[13px] text-fg-muted tabular-nums">
            {t("project.grading.progress", { n: repos.filter((r) => r.validation.validated).length, total: repos.length })}
          </span>
          <Badge tone={repo.validation.validated ? "green" : repo.frozen ? "amber" : "zinc"} icon={repo.validation.validated ? Check : undefined}>
            {standingWords(repo, t)}
          </Badge>
        </>
      }
    />
  );
}
