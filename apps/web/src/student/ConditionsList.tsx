/**
 * The conditions of an evaluation (ADR-079, F-EVAL-33): THE renderer, used by
 * the waiting room, the ready screen, the player's "Show the conditions"
 * dialog and the teacher's previews of them.
 *
 * Two blocks, never mixed: what the teacher ANNOUNCES first, in their order,
 * then what the platform IMPOSES, in its fixed order. Every line carries its
 * kind twice — an icon and a word (Allowed, Forbidden, Provided, Good to
 * know) — so the kind never rests on a colour, and no colour is used: the
 * waiting room has no accent (its decisions, `Lobby.tsx`), and a red
 * "Forbidden" would read as the thing to click.
 *
 * The announced text is the teacher's snapshot, drawn as plain text: React
 * escapes it, and nothing here parses markdown or HTML. The imposed lines are
 * keys the server derived (`imposedConditions`, `@quiz/domain`), translated
 * here.
 */
import { Ban, Check, Info, PackageCheck, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ConditionKind, EvaluationConditions, ImposedCondition } from "@quiz/contracts";
import type { ImposedConditionKey } from "@quiz/domain";

import { useT, type TFunction } from "../i18n";
import { Card, cx } from "../ui";
import { isoDateTime } from "../ui/dates";

const KIND_ICON: Record<ConditionKind, LucideIcon> = {
  allowed: Check,
  forbidden: Ban,
  provided: PackageCheck,
  info: Info,
};

/** The minutes a student has once their extra time (`timeBonusPercent` of the duration) is added. */
export function minutesWithBonus(durationS: number, timeBonusPercent: number): number {
  return Math.round((durationS + Math.round((durationS * timeBonusPercent) / 100)) / 60);
}

/** What an imposed line says: a sentence, and a second one when it needs it. */
export function imposedText(line: ImposedCondition, t: TFunction): { title: string; body?: string } {
  switch (line.key) {
    case "trusted_client": {
      const which = line.clients.length > 1 ? "both" : line.clients[0]!;
      return { title: t(`conditions.trusted.${which}`), body: t("conditions.trusted.body") };
    }
    case "calculator":
      return { title: t(`conditions.calculator.${line.calculator}`), body: t("conditions.calculator.body") };
    case "duration":
      return {
        title: t("conditions.duration", { n: minutesWithBonus(line.durationS, line.bonusPercent) }),
        ...(line.bonusPercent > 0 ? { body: t("conditions.duration.bonus", { pct: line.bonusPercent }) } : {}),
      };
    case "deadline":
      return {
        title: t("conditions.deadline", { when: isoDateTime(line.closesAt) }),
        ...(line.bonusPercent > 0 ? { body: t("conditions.deadline.bonus", { pct: line.bonusPercent }) } : {}),
      };
    case "attempts":
      return line.maxAttempts === 1
        ? { title: t("conditions.attempts.one"), body: t("conditions.attempts.one.body") }
        : line.maxAttempts === null
          ? { title: t("conditions.attempts.unlimited") }
          : { title: t("conditions.attempts.upTo", { n: line.maxAttempts }) };
    case "navigation":
      return line.navigation === "forward_only"
        ? { title: t("conditions.navigation.forward_only"), body: t("conditions.navigation.forward_only.body") }
        : { title: t("conditions.navigation.milestones"), body: t("lobby.nav.milestones.body") };
    case "negative_marking":
      return { title: t("conditions.negative"), body: t("conditions.negative.body") };
    case "visibility_logged":
      return { title: t("conditions.visibility"), body: t("conditions.visibility.body") };
    case "autosave":
      return { title: t("conditions.autosave"), body: t("conditions.autosave.body") };
  }
}

/** One line of the list: the kind's icon and word, the text, and a detail. */
export function ConditionLine({ kind, title, body, compact }: { kind: ConditionKind; title: string; body?: string; compact: boolean }) {
  const t = useT();
  const Icon = KIND_ICON[kind];
  return (
    <li className={cx("flex items-start gap-3", compact ? "px-4 py-2.5" : "px-5 py-3")}>
      <Icon className="mt-0.5 size-4 shrink-0 text-fg-faint" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg-faint">{t(`conditions.kind.${kind}`)}</p>
        <p className="text-sm font-semibold [overflow-wrap:anywhere]">{title}</p>
        {body ? <p className="mt-0.5 text-[13px] leading-relaxed text-fg-muted">{body}</p> : null}
      </div>
    </li>
  );
}

function Block({ heading, compact, children }: { heading: string; compact: boolean; children: ReactNode }) {
  return (
    <section>
      <h2
        className={cx(
          "border-b border-line bg-surface-2 text-xs font-semibold uppercase tracking-wide text-fg-muted",
          compact ? "px-4 py-1.5" : "px-5 py-2",
        )}
      >
        {heading}
      </h2>
      <ul className="divide-y divide-line">{children}</ul>
    </section>
  );
}

export function ConditionsList({
  conditions,
  omit = [],
  compact = false,
  className,
}: {
  conditions: EvaluationConditions;
  /** Imposed keys another part of the screen already states (the ready screen's clock sentence). */
  omit?: readonly ImposedConditionKey[];
  /** The size of a side column (the teacher's previews). */
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const imposed = conditions.imposed.filter((line) => !omit.includes(line.key));
  if (conditions.announced.length === 0 && imposed.length === 0) return null;
  return (
    <Card className={cx("w-full divide-y divide-line overflow-hidden text-left", className)}>
      {conditions.announced.length > 0 ? (
        <Block heading={t("conditions.announced")} compact={compact}>
          {conditions.announced.map((line, i) => (
            <ConditionLine key={i} kind={line.kind} title={line.text} compact={compact} />
          ))}
        </Block>
      ) : null}
      {imposed.length > 0 ? (
        <Block heading={t("conditions.imposed")} compact={compact}>
          {imposed.map((line) => (
            <ConditionLine
              key={line.key}
              kind={line.kind}
              // The side column's miniature keeps the titles: the details are the page's.
              {...(compact ? { title: imposedText(line, t).title } : imposedText(line, t))}
              compact={compact}
            />
          ))}
        </Block>
      ) : null}
    </Card>
  );
}
