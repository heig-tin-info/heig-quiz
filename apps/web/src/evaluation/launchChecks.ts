/*
 * The launch step's pre-flight checklist (#152), as data: one row per thing
 * the teacher should have seen before the class can enter, computed from the
 * `EvaluationDetail` the page already holds — no extra request.
 *
 * Four levels, and the line between them is the triage's, not taste:
 *   - `blocker`: exactly what the API refuses (`guardTransition`): no
 *     question, nothing that counts towards the total (every question a
 *     bonus, ADR-052), an incomplete timing, a common end already past (#178).
 *     Nothing else may disable the launch —
 *     a client-side refusal the server does not share is a lie in one
 *     direction or the other.
 *   - `warning`: legal, but probably not meant, and each one has a fix: stale
 *     question versions, a template that moved since (F-EVAL-26), an empty
 *     roster, roster conflicts.
 *   - `ok`: a check that passed, said as a summary line.
 *   - `info`: a rule of the session that is never wrong in itself (feedback,
 *     navigation, access). Unlinked accounts are info too: before the first
 *     class nobody has signed in, and a warning there would be noise.
 */
import {
  retakesOf,
  type EvaluationDetail,
} from "@quiz/contracts";
import {
  announcedConditionsOn,
  imposedConditions,
  lacksGradedPoints,
  retakesOn,
  templatePullable,
  type ImposedCondition,
  type TrustedClient,
  trustedClientsOf,
} from "@quiz/domain";

import type { Dict, TFunction } from "../i18n";
import type { CheckLevel } from "../ui";
import { typeLabel } from "../questionTypes";
import { imposedText } from "../student/ConditionsList";
import { timingFragment } from "./presetSummary";
import { missingTiming, missingTimingKey } from "./timing";

/** The shared check levels (`ui`), less `unknown`, plus the rules of the session. */
export type LaunchLevel = Exclude<CheckLevel, "unknown"> | "info";

/** What a row offers to fix or to look at. */
export type CheckFix =
  | { kind: "step"; step: "questions" | "timing" }
  | { kind: "roster" }
  | { kind: "updateVersions" }
  | { kind: "pullTemplate" };

export interface LaunchCheck {
  id: "items" | "stale" | "template" | "roster" | "conflicts" | "timing" | "feedback" | "rules" | "access" | "kiosk";
  level: LaunchLevel;
  title: string;
  detail: string;
  /** A blocker's reason for the action bar's status line, when it differs from `detail`. */
  status?: string;
  fix?: CheckFix;
}

/** What opening does, per waiting-room setting; the status line and the dialog prefix it. */
export const lobbyKey = (lobby: "manual" | "auto" | "skip"): keyof Dict => `launch.lobby.${lobby}`;

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
      detail: t("eval.launch.needQuestions"),
      fix: { kind: "step", step: "questions" },
    };
  }
  // `totalPoints` leaves the bonus items out: the server's own rule.
  if (lacksGradedPoints(detail.evaluation.mode, detail.totalPoints)) {
    return {
      id: "items",
      level: "blocker",
      title: t("launch.items.noGradedPoints"),
      detail: t("eval.launch.needGradedPoints"),
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

/**
 * The template moved since this evaluation's questions were copied from it
 * (F-EVAL-26): a warning whose fix is the pull, offered exactly where the
 * server accepts one — the item list still editable, the template still the
 * course's.
 */
function templateChecks(detail: EvaluationDetail, t: TFunction): LaunchCheck[] {
  const { evaluation } = detail;
  const standing = {
    originRevision: evaluation.originRevision,
    templateRevision: detail.templateRevision,
    state: evaluation.state,
    attemptCount: detail.attemptCount,
  };
  if (!templatePullable(standing)) return [];
  return [
    {
      id: "template",
      level: "warning",
      title: t("launch.template", { from: standing.originRevision!, to: standing.templateRevision! }),
      detail: t("launch.template.detail"),
      fix: { kind: "pullTemplate" },
    },
  ];
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
      status: t("eval.launch.needTiming"),
      detail: missing.map((field) => t(missingTimingKey(field))).join(" "),
      fix,
    };
  }
  if (
    evaluation.settings.timing === "deadline" &&
    evaluation.closesAt !== null &&
    Date.parse(evaluation.closesAt) <= now
  ) {
    // The server refuses to open it (#178). Scheduled, its opening has passed
    // too and the server refuses a patch that leaves it there: the way out is
    // the action bar's "Back to draft", not the timing step.
    const date = formatDate(evaluation.closesAt);
    return evaluation.state === "scheduled"
      ? {
          id: "timing",
          level: "blocker",
          title: t("launch.timing.past"),
          detail: t("launch.timing.past.scheduled", { date }),
        }
      : {
          id: "timing",
          level: "blocker",
          title: t("launch.timing.past"),
          detail: t("launch.timing.past.detail", { date }),
          fix,
        };
  }
  return {
    id: "timing",
    level: "ok",
    title: capitalize(timingFragment(evaluation, t, formatDate)),
    detail: t(lobbyKey(evaluation.settings.lobby)),
    fix,
  };
}

function rulesCheck(detail: EvaluationDetail, t: TFunction): LaunchCheck {
  const { evaluation } = detail;
  const { settings, mode } = evaluation;
  // ADR-079: the attempts and the negative marking as the students read them.
  const imposed = imposedConditions({ ...evaluation, timeBonusPercent: 0 });
  const line = <K extends ImposedCondition["key"]>(key: K) => imposed.find((c) => c.key === key);
  const attemptsLine = line("attempts");
  const attempts = attemptsLine
    ? [
        imposedText(attemptsLine, t).title,
        ...(retakesOn(mode, retakesOf(settings)) ? [t(`launch.rules.keep.${retakesOf(settings).keep}`)] : []),
      ].join(", ")
    : null;
  const announced = announcedConditionsOn(mode, settings.conditions);
  return {
    id: "rules",
    level: "info",
    title: capitalize(
      [
        t(`eval.summary.navigation.${settings.navigation}` as keyof Dict),
        settings.shuffleItems ? t("launch.rules.shuffled") : t("launch.rules.fixedOrder"),
      ].join(", "),
    ),
    detail: [
      ...(attempts === null ? [] : [attempts]),
      ...(line("negative_marking") ? [t("launch.rules.negative")] : []),
      // ADR-079: said, never warned about — an evaluation without any is fine.
      ...(announced.length === 0
        ? []
        : [
            announced.length === 1
              ? t("launch.rules.conditions.one")
              : t("launch.rules.conditions.many", { n: announced.length }),
          ]),
    ].join(" · "),
    fix: { kind: "step", step: "timing" },
  };
}

const TRUSTED_CLIENT_KEY: Record<TrustedClient, keyof Dict> = { seb: "eval.seb", kiosk: "eval.kiosk" };

function accessCheck(detail: EvaluationDetail, t: TFunction): LaunchCheck {
  const { evaluation } = detail;
  const parts = [
    ...(evaluation.ipAllowlist.length > 0 ? [t("launch.access.ip")] : []),
    // ADR-051 §2: the trusted clients it is sat through, SEB then kiosk.
    ...trustedClientsOf(evaluation.mode, evaluation.settings).map((client) => t(TRUSTED_CLIENT_KEY[client])),
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
 * ADR-051 §2: an exam switched to kiosk stations on a platform that no longer
 * has the kiosk path (the server refuses the switch without it, so only a
 * platform that turned it off afterwards gets here). No station can pair, so
 * the exam can only be sat through SEB, or not at all.
 */
function kioskChecks(detail: EvaluationDetail, t: TFunction, kioskAvailable: boolean): LaunchCheck[] {
  const { evaluation } = detail;
  if (kioskAvailable || !trustedClientsOf(evaluation.mode, evaluation.settings).includes("kiosk")) return [];
  return [
    {
      id: "kiosk",
      level: "warning",
      title: t("launch.kiosk.unavailable"),
      detail: t("launch.kiosk.unavailable.detail"),
      fix: { kind: "step", step: "timing" },
    },
  ];
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
  /** The platform's kiosk path (`PublicConfig.kiosk`); true while unknown. */
  kioskAvailable: boolean,
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
    ...templateChecks(detail, t),
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
    ...kioskChecks(detail, t, kioskAvailable),
  ];
  const rank: Record<LaunchLevel, number> = { blocker: 0, warning: 1, ok: 2, info: 2 };
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
