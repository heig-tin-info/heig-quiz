/*
 * The launch step's pre-flight checklist (#152), as data: one row per thing
 * the teacher should have seen before the class can enter, computed from the
 * `EvaluationDetail` the page already holds — no extra request.
 *
 * Four levels, and the line between them is the triage's, not taste:
 *   - `blocker`: exactly what the API refuses (`guardTransition`): no
 *     question, an incomplete timing. Nothing else may disable the launch —
 *     a client-side refusal the server does not share is a lie in one
 *     direction or the other.
 *   - `warning`: legal, but probably not meant, and each one has a fix: stale
 *     question versions, an empty roster, roster conflicts, a common end
 *     already past.
 *   - `ok`: a check that passed, said as a summary line.
 *   - `info`: a rule of the session that is never wrong in itself (feedback,
 *     navigation, access). Unlinked accounts are info too: before the first
 *     class nobody has signed in, and a warning there would be noise.
 */
import {
  negativeMarkingOf,
  retakesOf,
  safeExamBrowserOf,
  type EvaluationDetail,
} from "@quiz/contracts";
import { retakesOn } from "@quiz/domain";

import type { Dict, TFunction } from "../i18n";
import { typeLabel } from "../questionTypes";
import { timingFragment } from "./presetSummary";
import { missingTiming, missingTimingKey } from "./timing";

export type CheckLevel = "blocker" | "warning" | "ok" | "info";

/** What a row offers to fix or to look at. */
export type CheckFix =
  | { kind: "step"; step: "questions" | "timing" }
  | { kind: "roster" }
  | { kind: "updateVersions" };

export interface LaunchCheck {
  id: "items" | "stale" | "roster" | "conflicts" | "timing" | "feedback" | "rules" | "access";
  level: CheckLevel;
  title: string;
  detail: string;
  fix?: CheckFix;
}

const capitalize = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** "3 × Multiple choice · 1 × Short answer", in the order the items first use each type. */
function typeMix(detail: EvaluationDetail, t: TFunction): string {
  const counts = new Map<string, number>();
  for (const item of detail.items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
  return [...counts]
    .map(([type, n]) => t("launch.items.mix", { n, type: typeLabel(t, type) }))
    .join(" · ");
}

function itemsCheck(detail: EvaluationDetail, t: TFunction): LaunchCheck {
  const n = detail.items.length;
  if (n === 0) {
    return {
      id: "items",
      level: "blocker",
      title: t("launch.items.none"),
      detail: t("launch.items.none.detail"),
      fix: { kind: "step", step: "questions" },
    };
  }
  return {
    id: "items",
    level: "ok",
    title:
      n === 1
        ? t("launch.items.one", { points: detail.totalPoints })
        : t("launch.items", { n, points: detail.totalPoints }),
    detail: typeMix(detail, t),
    fix: { kind: "step", step: "questions" },
  };
}

function rosterChecks(detail: EvaluationDetail, t: TFunction): LaunchCheck[] {
  const roster = detail.roster;
  if (roster === null) return [];
  if (roster.enrolled === 0) {
    return [
      {
        id: "roster",
        level: "warning",
        title: t("launch.roster.empty"),
        detail: t("launch.roster.empty.detail"),
        fix: { kind: "roster" },
      },
    ];
  }
  const rows: LaunchCheck[] = [];
  if (roster.conflicts > 0) {
    rows.push({
      id: "conflicts",
      level: "warning",
      title:
        roster.conflicts === 1
          ? t("launch.roster.conflictsOne")
          : t("launch.roster.conflicts", { n: roster.conflicts }),
      detail: t("launch.roster.conflicts.detail"),
      fix: { kind: "roster" },
    });
  }
  rows.push({
    id: "roster",
    level: "ok",
    title:
      roster.enrolled === 1
        ? t("launch.roster.one")
        : t("launch.roster", { n: roster.enrolled }),
    detail:
      roster.unlinked === 0
        ? t("launch.roster.allLinked")
        : roster.unlinked === 1
          ? t("launch.roster.unlinkedOne")
          : t("launch.roster.unlinked", { n: roster.unlinked }),
    fix: { kind: "roster" },
  });
  return rows;
}

function timingCheck(
  detail: EvaluationDetail,
  t: TFunction,
  now: number,
  formatDate: (iso: string) => string,
): LaunchCheck {
  const { evaluation } = detail;
  const fix = { kind: "step", step: "timing" } as const;
  const missing = missingTiming(evaluation);
  if (missing.length > 0) {
    return {
      id: "timing",
      level: "blocker",
      title: t("launch.timing.incomplete"),
      detail: missing.map((field) => t(missingTimingKey(field))).join(" "),
      fix,
    };
  }
  if (
    evaluation.settings.timing === "deadline" &&
    evaluation.closesAt !== null &&
    Date.parse(evaluation.closesAt) <= now
  ) {
    return {
      id: "timing",
      level: "warning",
      title: t("launch.timing.past"),
      detail: t("launch.timing.past.detail", { date: formatDate(evaluation.closesAt) }),
      fix,
    };
  }
  return {
    id: "timing",
    level: "ok",
    title: capitalize(timingFragment(evaluation, t, formatDate)),
    detail: t(`launch.start.${evaluation.settings.lobby}` as keyof Dict),
    fix,
  };
}

function rulesCheck(detail: EvaluationDetail, t: TFunction): LaunchCheck {
  const { settings, mode } = detail.evaluation;
  const retakes = retakesOf(settings);
  const attempts = !retakesOn(mode, retakes)
    ? t("launch.rules.oneAttempt")
    : retakes.maxAttempts === null
      ? t(`launch.rules.unlimited.${retakes.keep}` as keyof Dict)
      : t(`launch.rules.upTo.${retakes.keep}` as keyof Dict, { n: retakes.maxAttempts });
  return {
    id: "rules",
    level: "info",
    title: capitalize(
      [
        t(`eval.summary.navigation.${settings.navigation}` as keyof Dict),
        settings.shuffleItems ? t("launch.rules.shuffled") : t("launch.rules.fixedOrder"),
      ].join(", "),
    ),
    detail: [attempts, ...(negativeMarkingOf(settings) ? [t("launch.rules.negative")] : [])].join(
      " · ",
    ),
    fix: { kind: "step", step: "timing" },
  };
}

function accessCheck(detail: EvaluationDetail, t: TFunction): LaunchCheck {
  const { evaluation } = detail;
  const parts = [
    ...(evaluation.accessCode !== null ? [t("launch.access.code")] : []),
    ...(evaluation.ipAllowlist.length > 0 ? [t("launch.access.ip")] : []),
    ...(safeExamBrowserOf(evaluation.settings) ? [t("eval.seb")] : []),
  ];
  return {
    id: "access",
    level: "info",
    title: parts.length === 0 ? t("launch.access.open") : capitalize(parts.join(" · ")),
    detail: parts.length === 0 ? t("launch.access.open.detail") : t("launch.access.detail"),
    fix: { kind: "step", step: "timing" },
  };
}

/**
 * Every row, the ones that need the teacher first: blockers, then warnings,
 * then the rest in reading order (content, people, time, rules).
 */
export function launchChecks(
  detail: EvaluationDetail,
  t: TFunction,
  now: number,
  formatDate: (iso: string) => string,
): LaunchCheck[] {
  const { evaluation } = detail;
  const rows: LaunchCheck[] = [
    itemsCheck(detail, t),
    ...(detail.staleItems.length > 0 && detail.editable
      ? [
          {
            id: "stale",
            level: "warning",
            title:
              detail.staleItems.length === 1
                ? t("launch.stale.one")
                : t("launch.stale", { n: detail.staleItems.length }),
            detail: t("launch.stale.detail"),
            fix: { kind: "updateVersions" },
          } satisfies LaunchCheck,
        ]
      : []),
    ...rosterChecks(detail, t),
    timingCheck(detail, t, now, formatDate),
    {
      id: "feedback",
      level: "info",
      title: t("launch.feedback", {
        when: t(`eval.feedback.${evaluation.feedbackPolicy.when}` as keyof Dict),
      }),
      detail: t(`eval.feedback.desc.${evaluation.feedbackPolicy.when}` as keyof Dict),
      fix: { kind: "step", step: "timing" },
    },
    rulesCheck(detail, t),
    accessCheck(detail, t),
  ];
  const rank: Record<CheckLevel, number> = { blocker: 0, warning: 1, ok: 2, info: 2 };
  // `sort` is stable: rows of one rank keep their reading order.
  return rows.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** How many rows stop the launch, and how many deserve a look. */
export function readiness(checks: readonly LaunchCheck[]): { blockers: number; warnings: number } {
  return {
    blockers: checks.filter((c) => c.level === "blocker").length,
    warnings: checks.filter((c) => c.level === "warning").length,
  };
}
