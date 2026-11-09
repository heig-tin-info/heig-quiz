import { useMutation } from "@tanstack/react-query";
import { BadgeCheck } from "lucide-react";
import { useCallback, useState } from "react";

import type {
  AcceptablePart,
  AcceptanceScope,
  AnswerAcceptanceBody,
  AnswerAcceptanceResult,
  GradingEntry,
  GradingQueueItem,
  ItemAcceptance,
} from "@quiz/contracts";
import { acceptanceReach } from "@quiz/domain";
import { AcceptedChip } from "@quiz/ui";

import { api, wordedRefusal } from "../api";
import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import { Button, cx, ErrorText, IconButton, Popover, Segmented } from "../ui";
import { useGradingInvalidate } from "./useGradingInvalidate";

/**
 * What the grading screen hands the table and the panel about accepting an
 * answer at grading time (ADR-128): the item's scopes and rules in force,
 * every answer to the question (the counts read them), and the write.
 * Absent when the item takes no acceptance.
 */
export interface Acceptance {
  item: NonNullable<GradingQueueItem["acceptance"]>;
  entries: readonly GradingEntry[];
  /** The results are released: the card says who is told. */
  released: boolean;
  /**
   * Absent where the reader may not accept: an assistant once released
   * (ADR-068 §3), an item list not frozen yet. The accepted answers are
   * still shown.
   */
  change?: ((rule: AnswerAcceptanceBody, accept: boolean) => Promise<AnswerAcceptanceResult>) | undefined;
}

/** The scope's words in the card. */
const SCOPE_LABEL: Record<AcceptanceScope, keyof Dict> = {
  everyone: "grading.accept.scope.everyone",
  student: "grading.accept.scope.student",
};

/** The write (`PUT` accepts, `DELETE` stops), then the grading reads again. */
export function useAnswerAcceptance(evaluationId: string, itemId: string | undefined) {
  const t = useT();
  const toast = useToast();
  const invalidate = useGradingInvalidate(evaluationId);
  const mutation = useMutation<AnswerAcceptanceResult, unknown, { rule: AnswerAcceptanceBody; accept: boolean }>({
    mutationFn: ({ rule, accept }) =>
      api(`/app/api/evaluations/${evaluationId}/items/${itemId}/acceptances`, {
        method: accept ? "PUT" : "DELETE",
        body: JSON.stringify(rule satisfies AnswerAcceptanceBody),
      }),
    onSuccess: (result) => {
      invalidate();
      toast(t(result.accepted ? "grading.accept.done" : "grading.accept.stopped"), "success");
    },
  });
  const { mutateAsync } = mutation;
  return useCallback(
    (rule: AnswerAcceptanceBody, accept: boolean) => mutateAsync({ rule, accept }),
    [mutateAsync],
  );
}

/** The server's refusals, worded; anything else is the API's own message. */
const REFUSALS: Partial<Record<string, keyof Dict>> = {
  acceptance_not_frozen: "grading.accept.notFrozen",
  acceptance_unavailable: "grading.accept.refused",
  acceptance_scope: "grading.accept.refused",
  acceptance_invalid: "grading.accept.refused",
  owner_required: "grading.ownerOnly",
};

/**
 * What `entry` gave at `part` when there is something to do with it — an
 * answer the key counts wrong, or one accepted already — with the rule in
 * force on it (for everyone, else for this attempt); null otherwise.
 */
export function offeredPart(
  acceptance: Acceptance,
  entry: GradingEntry,
  part: string,
): { given: AcceptablePart; inForce: ItemAcceptance | undefined } | null {
  const given = entry.parts?.find((p) => p.part === part);
  if (!given) return null;
  const same = acceptance.item.accepted.filter((a) => a.part === given.part && a.answer === given.answer);
  const inForce = same.find((a) => a.attemptId === null) ?? same.find((a) => a.attemptId === entry.attemptId);
  return given.right && !inForce ? null : { given, inForce };
}

/**
 * The small corner control of an answer's part (ADR-128): a seal button
 * that opens the acceptance card. Drawn only where there is something to
 * do — an answer the key counts wrong, or one accepted already. A click on
 * it never reaches the row under it (the row opens the panel).
 */
export function AcceptControl({
  acceptance,
  entry,
  part,
  partLabel,
  className,
}: {
  acceptance: Acceptance;
  entry: GradingEntry;
  part: string;
  /** The part as the table names it ("Blank 2"). */
  partLabel: string;
  className?: string;
}) {
  const t = useT();
  const offered = offeredPart(acceptance, entry, part);
  const change = acceptance.change;
  if (!offered || !change) return null;
  const { given, inForce } = offered;
  return (
    // React carries a click in the portalled card up the tree to the row:
    // stopped here, so neither the button nor the card opens the panel.
    <span className={className} onClick={(e) => e.stopPropagation()}>
      <Popover
        label={t("grading.accept.dialog")}
        trigger={
          <IconButton
            size="xs"
            label={t(inForce ? "grading.accept.accepted" : "grading.accept.open")}
            className={cx("bg-surface", inForce ? "text-success" : "text-fg-muted")}
          >
            <BadgeCheck />
          </IconButton>
        }
      >
        {(close) => (
          <AcceptCard
            acceptance={acceptance}
            change={change}
            entry={entry}
            given={given}
            inForce={inForce}
            partLabel={partLabel}
            onDone={close}
          />
        )}
      </Popover>
    </span>
  );
}

/**
 * The card: what is accepted, how many answers it reaches and how many a
 * manual override keeps, the scope, and the one action — Accept, or Stop
 * accepting once it is. A refusal stays on the card, worded.
 */
function AcceptCard({
  acceptance,
  change,
  entry,
  given,
  inForce,
  partLabel,
  onDone,
}: {
  acceptance: Acceptance;
  change: NonNullable<Acceptance["change"]>;
  entry: GradingEntry;
  given: AcceptablePart;
  inForce: ItemAcceptance | undefined;
  partLabel: string;
  onDone: () => void;
}) {
  const t = useT();
  const scopes = acceptance.item.scopes;
  const [scope, setScope] = useState<AcceptanceScope>(
    inForce ? (inForce.attemptId === null ? "everyone" : "student") : (scopes[0] ?? "student"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rule = { part: given.part, answer: given.answer, attemptId: scope === "everyone" ? null : entry.attemptId };
  const { reached, unchanged } = acceptanceReach(
    acceptance.entries.map((e) => ({ attemptId: e.attemptId, given: e.parts ?? [], manual: e.grading?.source === "manual" })),
    rule,
  );
  const total = reached.length + unchanged.length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await change(rule, inForce === undefined);
      onDone();
    } catch (err) {
      setError(wordedRefusal(err, REFUSALS, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-72 space-y-3 text-[13px]">
      <div className="space-y-1">
        <p className="text-xs text-fg-muted">{partLabel}</p>
        <p className="break-words font-medium text-fg">{t("grading.accept.what", { answer: given.label })}</p>
        <p className="text-xs tabular-nums text-fg-muted">
          {t(total === 1 ? "grading.accept.reach.one" : "grading.accept.reach", { n: total })}
          {unchanged.length > 0
            ? ` · ${t(unchanged.length === 1 ? "grading.accept.manual.one" : "grading.accept.manual", { n: unchanged.length })}`
            : null}
        </p>
      </div>
      {inForce ? (
        <p className="text-xs text-success">
          {t(inForce.attemptId === null ? "grading.accept.inForce.everyone" : "grading.accept.inForce.student")}
        </p>
      ) : scopes.length > 1 ? (
        <Segmented
          name={`accept-${entry.attemptId}-${given.part}`}
          label={t("grading.accept.scope")}
          value={scope}
          onChange={setScope}
          wrap
          options={scopes.map((s) => ({ value: s, label: t(SCOPE_LABEL[s]) }))}
        />
      ) : null}
      {acceptance.released ? <p className="text-xs text-fg-muted">{t("grading.counting.confirm.released")}</p> : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button className="w-full" variant={inForce ? "secondary" : "primary"} loading={busy} onClick={() => void submit()}>
        {t(inForce ? "grading.accept.stop" : "grading.accept.do")}
      </Button>
    </div>
  );
}

/** The answers accepted for everyone at `part`, beside the key in the expected row and the key's panel. */
export function AcceptedAnswers({ acceptance, part }: { acceptance: Acceptance | undefined; part: string | undefined }) {
  const t = useT();
  if (!acceptance || part === undefined) return null;
  const accepted = acceptance.item.accepted.filter((a) => a.part === part && a.attemptId === null);
  if (accepted.length === 0) return null;
  return (
    <>
      {accepted.map((a) => (
        <AcceptedChip key={a.answer} label={t("grading.accept.accepted")} title={a.label}>
          {a.label}
        </AcceptedChip>
      ))}
    </>
  );
}
