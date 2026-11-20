import { useMutation } from "@tanstack/react-query";
import { Bot, Check, CheckCheck, Eye, PencilLine, TriangleAlert, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import {
  ContestationResolveBody,
  type ContestationConfirmBody,
  type ContestationProposalView,
  type ContestationState,
} from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api, refusalCodeOf, wordedRefusal } from "../api";
import { useT, type Dict, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { Alert, Button, cx, FormError, HeldButton, isoDateTime, Modal, NotePanel } from "../ui";
import { ContestationReply, contestationStateId, type ReplyPoints, type ReplySeed, type ResolveSchema } from "./Contestation";

/**
 * An AI assistant's proposal on an open contestation (ADR-139 §14): what a
 * model wrote over MCP, stored on the contestation, applied only once the
 * course owner confirms it. Shared by an exam's question and a project's
 * criterion: the criterion's rationale and the exam's accepted answer are
 * optional parts of the same block.
 *
 * The block stands ABOVE the owner's answer, a dashed edge on a soft
 * surface: a draft, never the teacher's word. Every text in it is the
 * model's and is drawn escaped, line breaks kept, never Markdown. Its acts
 * are all secondary — the screen keeps its one primary: Confirm (the
 * owner), Edit (the owner: the reply form restarts from the proposal, the
 * verdict left to the owner's click) and Discard (any member of the staff).
 *
 * A confirmation names the proposal the owner READ (`proposedAt`, kept when
 * the block mounts): a refetch may bring another one an assistant wrote
 * meanwhile, which is then shown with an alert, and Confirm waits until the
 * owner says they read it. The server refuses `409 proposal_stale` on its
 * own clock too; the reads are then refreshed into the same state.
 */

/** The contestation as the proposal's acts read it: its id (paths, focus), state, proposal and whether it counts. */
export interface ProposedContestation {
  id: string;
  state: ContestationState;
  counted: boolean;
  proposal: ContestationProposalView | null;
}

/** A model's text: as written, line breaks kept, never interpreted. */
function ModelText({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap break-words text-sm text-fg">{text}</p>;
}

/** The refusals a confirmation words, over the unit's (a project's `points_out_of_range`, `criterion_removed`). */
const PROPOSAL_REFUSAL: Partial<Record<string, keyof Dict>> = {
  proposal_stale: "contest.proposal.refusal.stale",
  no_proposal: "contest.proposal.refusal.gone",
  not_open: "contest.answer.refusal.not_open",
  points_out_of_range: "contest.answer.refusal.points",
  acceptance_not_frozen: "grading.accept.notFrozen",
  acceptance_unavailable: "grading.accept.refused",
  acceptance_scope: "grading.accept.refused",
  acceptance_invalid: "grading.accept.refused",
};

/** Codes after which the screen reads again: the proposal or the contestation moved. */
const REFRESHING = new Set(["proposal_stale", "no_proposal", "not_open"]);

const confirmPathOf = (path: string) => `${path}/proposal/confirm`;

/** The sign of an open contestation an assistant prepared: the robot, its meaning for a screen reader. */
export function ProposalSign({ className = "size-3" }: { className?: string }) {
  const t = useT();
  return (
    <>
      <Bot aria-hidden className={className} data-testid="proposal-mark" />
      <span className="sr-only">{t("contest.proposal.ready.short")}</span>
    </>
  );
}

function ProposalBlock({
  contestationId,
  proposal,
  path,
  isOwner,
  outOf,
  refusals,
  onChanged,
  onEdit,
  read,
  onRead,
  onRegradeFailed,
}: {
  contestationId: string;
  proposal: ContestationProposalView;
  /** The contestation's base path. */
  path: string;
  /** Confirm and Edit are offered on `true` only (null: the role is not known yet). */
  isOwner: boolean | null;
  /** The maximum the proposed points read against ("3", "2 (+1)"). */
  outOf: string;
  refusals?: Partial<Record<string, keyof Dict>> | undefined;
  onChanged: () => void;
  /** Copies the proposal into the owner's form. */
  onEdit: () => void;
  /** The instant of the proposal the owner read on this screen (null: none yet): what a confirmation names. */
  read: string | null;
  /** The owner read the proposal shown. */
  onRead: () => void;
  /** An accepted answer's confirmation answered the student, but re-grading the other copies failed (`500 regrade_failed`). */
  onRegradeFailed: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const headingId = useId();
  const changed = proposal.proposedAt !== read;
  const table = { ...PROPOSAL_REFUSAL, ...refusals };
  /** Confirm and discard alike: the reads again, the toast, the focus on the contestation's state; a refusal that says it moved, the reads again. */
  const settled = (done: keyof Dict) => ({
    onSuccess: () => {
      onChanged();
      toast(t(done), "success");
      requestAnimationFrame(() => document.getElementById(contestationStateId(contestationId))?.focus());
    },
    onError: (error: unknown) => {
      const code = refusalCodeOf(error) ?? "";
      if (code === "regrade_failed") {
        // Answered and told: what remains is the re-grade, said where the answer now stands.
        onChanged();
        onRegradeFailed();
      } else if (REFRESHING.has(code)) onChanged();
    },
  });

  const accepted = proposal.verdict === "accepted";
  const confirm = useMutation<unknown, unknown, ContestationConfirmBody>({
    mutationFn: (body) => api(confirmPathOf(path), { method: "POST", body: JSON.stringify(body) }),
    ...settled(accepted ? "contest.answer.done.accepted" : "contest.answer.done.refused"),
  });
  const discard = useMutation<unknown, unknown, void>({
    mutationFn: () => api(`${path}/proposal`, { method: "DELETE" }),
    ...settled("contest.proposal.discarded"),
  });
  const busy = confirm.isPending || discard.isPending;
  const VerdictIcon = accepted ? Check : X;
  const held = proposal.stale ? t("contest.proposal.staleHeld") : changed ? t("contest.proposal.changedHeld") : null;

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-card border border-dashed border-line-strong bg-surface-2 p-4"
      data-testid="contestation-proposal"
    >
      <div>
        <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span id={headingId} className="inline-flex items-center gap-1.5 text-sm font-semibold">
            <Bot aria-hidden className="size-4 self-center text-fg-muted" />
            {t("contest.proposal.title")}
          </span>
          <span className="text-xs tabular-nums text-fg-muted">{isoDateTime(proposal.proposedAt)}</span>
        </p>
        <p className="text-xs text-fg-muted">{t("contest.proposal.desc")}</p>
      </div>
      {changed ? (
        <Alert
          tone="warning"
          icon={TriangleAlert}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onRead();
                confirm.reset();
              }}
            >
              <Eye /> {t("contest.proposal.acknowledge")}
            </Button>
          }
        >
          {t("contest.proposal.changed")}
        </Alert>
      ) : null}
      <p className={cx("inline-flex items-center gap-1.5 text-sm font-semibold", accepted ? "text-success" : "text-fg-muted")}>
        <VerdictIcon aria-hidden className="size-4" />
        {t(accepted ? "contest.proposal.verdict.accepted" : "contest.proposal.verdict.refused")}
      </p>
      {proposal.accepted ? (
        <div className="space-y-1 text-[13px]">
          <p className="font-medium text-fg">
            {t("grading.accept.what", { answer: proposal.accepted.label ?? proposal.accepted.answer })}
          </p>
          <p className="text-fg-muted">
            {t("contest.proposal.scope", {
              scope: t(proposal.accepted.scope === "everyone" ? "grading.accept.scope.everyone" : "grading.accept.scope.student"),
            })}
          </p>
          {proposal.accepted.label === null ? <p className="text-fg-muted">{t("contest.proposal.labelGone")}</p> : null}
          {proposal.affected !== null && proposal.affected > 0 ? (
            <p className="font-medium text-warning">{affectedWords(t, proposal.affected)}</p>
          ) : null}
        </div>
      ) : null}
      {proposal.points !== null ? (
        <p className="text-[13px] tabular-nums text-fg">
          {t("contest.proposal.points", { points: formatPoints(proposal.points), max: outOf })}
        </p>
      ) : null}
      {proposal.reply ? (
        <NotePanel tone="outlined" eyebrow={t("contest.proposal.reply")}>
          <ModelText text={proposal.reply} />
        </NotePanel>
      ) : null}
      {proposal.rationale ? (
        <NotePanel tone="outlined" eyebrow={t("contest.proposal.rationale")}>
          <ModelText text={proposal.rationale} />
        </NotePanel>
      ) : null}
      {proposal.stale ? (
        <Alert tone="warning" icon={TriangleAlert}>
          {t("contest.proposal.stale")}
        </Alert>
      ) : null}
      <FormError
        error={refusalCodeOf(confirm.error) === "regrade_failed" ? null : (confirm.error ?? discard.error)}
        describe={(e) => wordedRefusal(e, table, t)}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" loading={discard.isPending} disabled={busy} onClick={() => discard.mutate()}>
          <X /> {t("contest.proposal.discard")}
        </Button>
        {/* An accepted answer is a rule the reply form cannot carry: it is confirmed or discarded as proposed. */}
        {isOwner === true && !proposal.accepted ? (
          <Button variant="secondary" disabled={busy} onClick={onEdit}>
            <PencilLine /> {t("contest.proposal.edit")}
          </Button>
        ) : null}
        {isOwner === true ? (
          <HeldButton
            variant="secondary"
            disabledReason={held}
            loading={confirm.isPending}
            disabled={busy}
            onClick={() => read !== null && confirm.mutate({ proposedAt: read })}
          >
            <CheckCheck /> {t("contest.proposal.confirm")}
          </HeldButton>
        ) : null}
      </div>
    </section>
  );
}

/** "Also changes n other students": an accepted answer's reach. */
const affectedWords = (t: TFunction, n: number) => (n === 1 ? t("contest.proposal.affected.one") : t("contest.proposal.affected", { n }));

/**
 * What stands under an OPEN contestation for the staff: the assistant's
 * proposal when there is one, then — for the owner — the one answer. Edit
 * restarts that answer from the proposal (a remount): its reply, and its
 * points switched on with their value (a criterion's rationale too) when
 * it gives points the unit can take — otherwise the switch starts off.
 * Nothing once answered (the record says it), unless re-grading the other
 * copies after a confirmed accepted answer failed: that is said here.
 *
 * What the owner READ is kept here, per contestation, not in the block a
 * proposal mounts: a proposal shown when the contestation first shows
 * counts as read; any other one — a rewrite, or one written after a
 * discard — is shown with a warning, and Confirm waits for "I have read it".
 */
export function ContestationResponse({
  contestation,
  isOwner,
  path,
  onChanged,
  points,
  schema = ContestationResolveBody,
  acceptable = true,
  refusals,
  outOf,
}: {
  contestation: Pick<ProposedContestation, "id" | "state" | "proposal">;
  /** The owner answers and confirms; anyone else reads and may discard. Null: the role is not known yet. */
  isOwner: boolean | null;
  /** The contestation's base path: `/resolve`, `/proposal` and `/proposal/confirm` under it. */
  path: string;
  onChanged: () => void;
  points?: ReplyPoints | undefined;
  schema?: ResolveSchema;
  acceptable?: boolean;
  refusals?: Partial<Record<string, keyof Dict>>;
  outOf: string;
}) {
  const t = useT();
  const [seed, setSeed] = useState<ReplySeed | null>(null);
  const [read, setRead] = useState<string | null>(contestation.proposal?.proposedAt ?? null);
  const [regradeFailed, setRegradeFailed] = useState(false);
  const failure = regradeFailed ? (
    <Alert tone="warning" icon={TriangleAlert}>
      {t("contest.proposal.regradeFailed")}
    </Alert>
  ) : null;
  if (contestation.state !== "open") return failure;
  const proposal = contestation.proposal;
  const edit = (p: ContestationProposalView) => () => {
    const fill = p.points === null ? undefined : points?.fill;
    if (fill && p.points !== null) fill(p.points, p.rationale);
    setSeed((was) => ({ n: (was?.n ?? 0) + 1, reply: p.reply, givePoints: fill !== undefined }));
  };
  return (
    <>
      {proposal ? (
        <ProposalBlock
          contestationId={contestation.id}
          proposal={proposal}
          path={path}
          isOwner={isOwner}
          outOf={outOf}
          refusals={refusals}
          onChanged={onChanged}
          onEdit={edit(proposal)}
          read={read}
          onRead={() => setRead(proposal.proposedAt)}
          onRegradeFailed={() => setRegradeFailed(true)}
        />
      ) : null}
      {isOwner === true ? (
        <ContestationReply
          key={seed?.n ?? 0}
          initial={seed}
          resolvePath={`${path}/resolve`}
          onChanged={onChanged}
          points={points}
          schema={schema}
          acceptable={acceptable}
          refusals={refusals}
        />
      ) : null}
    </>
  );
}

// --- The batch -----------------------------------------------------------------

/** One proposal the batch confirms, as the dialog read it when it opened. */
interface Snapshot {
  id: string;
  proposal: ContestationProposalView;
  path: string;
  label: string;
}

/** A proposal confirmed, confirmed but its accepted answer's re-grade failed (`regrade_failed`), or refused with its words. */
type Outcome = { id: string; confirmed: true; line: string | null } | { id: string; confirmed: false; line: string };

/** "n accepted", "1 accepted": a plural key pair. */
const counted = (t: TFunction, n: number, one: keyof Dict, many: keyof Dict) => (n === 1 ? t(one) : t(many, { n }));

/** The batch's one rule: an open contestation that counts, with a proposal (a stale one is counted apart). */
const eligible = (c: ProposedContestation | null): c is ProposedContestation & { proposal: ContestationProposalView } =>
  c !== null && c.state === "open" && c.counted && c.proposal !== null;

/**
 * "Confirm the proposals (n)" (ADR-139 §14), the owner's, in the Contested
 * filter: one secondary button while at least one open contestation of the
 * scope that counts carries a proposal that is not stale (a contestation
 * that no longer counts is answered by hand). Its dialog states, from what
 * it read when it opened, what will happen in numbers and to whom, then
 * confirms each proposal on its own, one after the other, through the
 * single confirmation with the `proposedAt` it read — so a proposal an
 * assistant rewrote meanwhile is refused, never confirmed unread. A refusal
 * never stops the others; the summary says how many were confirmed, and
 * why each other one was not, and the reads are refreshed.
 */
export function ProposalBatch<T>({
  items,
  contestationOf,
  pathOf,
  labelOf,
  scope,
  refusals,
  onChanged,
}: {
  /** The rows of the scope: a question's answers, a project's contestations. */
  items: readonly T[];
  contestationOf: (item: T) => ProposedContestation | null;
  /** The contestation's base path. */
  pathOf: (contestation: ProposedContestation) => string;
  /** Who or what it is, for a refusal's line in the summary. */
  labelOf: (item: T) => string;
  /** What the batch covers, said in the dialog. */
  scope: string;
  refusals?: Partial<Record<string, keyof Dict>>;
  onChanged: () => void;
}) {
  const t = useT();
  const [opened, setOpened] = useState<{ list: Snapshot[]; stale: number } | null>(null);
  const proposed = items.flatMap((item) => {
    const c = contestationOf(item);
    return eligible(c) ? [{ item, c }] : [];
  });
  const ready = proposed.filter(({ c }) => !c.proposal.stale);
  if (ready.length === 0 && opened === null) return null;
  const open = () =>
    setOpened({
      list: ready.map(({ item, c }) => ({ id: c.id, proposal: c.proposal, path: pathOf(c), label: labelOf(item) })),
      stale: proposed.length - ready.length,
    });
  return (
    <>
      {ready.length > 0 ? (
        <Button size="sm" variant="secondary" onClick={open} data-testid="proposal-batch">
          <CheckCheck /> {t("contest.batch.action", { n: ready.length })}
        </Button>
      ) : null}
      {opened ? (
        <BatchDialog {...opened} scope={scope} refusals={refusals} onChanged={onChanged} onClose={() => setOpened(null)} />
      ) : null}
    </>
  );
}

function BatchDialog({
  list,
  stale,
  scope,
  refusals,
  onChanged,
  onClose,
}: {
  list: readonly Snapshot[];
  stale: number;
  scope: string;
  refusals?: Partial<Record<string, keyof Dict>> | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const finished = !running && outcomes.length === list.length;
  const table = { ...PROPOSAL_REFUSAL, ...refusals };
  const accepted = list.filter((p) => p.proposal.verdict === "accepted").length;
  const withPoints = list.filter((p) => p.proposal.points !== null).length;
  const others = list.reduce((sum, p) => sum + (p.proposal.accepted ? (p.proposal.affected ?? 0) : 0), 0);

  const run = async () => {
    setRunning(true);
    const done: Outcome[] = [];
    for (const item of list) {
      try {
        await api(confirmPathOf(item.path), {
          method: "POST",
          body: JSON.stringify({ proposedAt: item.proposal.proposedAt } satisfies ContestationConfirmBody),
        });
        done.push({ id: item.id, confirmed: true, line: null });
      } catch (error) {
        const line = (reason: string) => t("contest.batch.line", { who: item.label, reason });
        done.push(
          refusalCodeOf(error) === "regrade_failed"
            ? { id: item.id, confirmed: true, line: line(t("contest.proposal.regradeFailed")) }
            : { id: item.id, confirmed: false, line: line(wordedRefusal(error, table, t)) },
        );
      }
      setOutcomes([...done]);
    }
    setRunning(false);
    onChanged();
  };

  const failed = outcomes.flatMap((o) => (o.confirmed ? [] : [o]));
  const regrade = outcomes.flatMap((o) => (o.confirmed && o.line !== null ? [o] : []));
  const confirmed = outcomes.length - failed.length;

  return (
    <Modal
      title={t("contest.batch.title")}
      onClose={running ? () => undefined : onClose}
      footer={
        finished ? (
          <Button onClick={onClose}>{t("common.done")}</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={running} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button loading={running} onClick={() => void run()}>
              <CheckCheck /> {t("contest.batch.confirm", { n: list.length })}
            </Button>
          </>
        )
      }
    >
      {finished ? (
        <div className="space-y-3" role="status" data-testid="proposal-batch-summary">
          <p className="text-sm font-semibold text-success">{counted(t, confirmed, "contest.batch.done.one", "contest.batch.done")}</p>
          {regrade.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-warning">{counted(t, regrade.length, "contest.batch.regrade.one", "contest.batch.regrade")}</p>
              <ul className="space-y-1 text-[13px] text-fg-muted">
                {regrade.map((o) => (
                  <li key={o.id}>{o.line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {failed.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-danger">{counted(t, failed.length, "contest.batch.failed.one", "contest.batch.failed")}</p>
              <ul className="space-y-1 text-[13px] text-fg-muted">
                {failed.map((o) => (
                  <li key={o.id}>{o.line}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-fg-muted">{scope}</p>
          <ul className="space-y-1 tabular-nums">
            <BatchLine show={accepted > 0}>{counted(t, accepted, "contest.batch.accepted.one", "contest.batch.accepted")}</BatchLine>
            <BatchLine show={list.length - accepted > 0}>
              {counted(t, list.length - accepted, "contest.batch.refused.one", "contest.batch.refused")}
            </BatchLine>
            <BatchLine show={withPoints > 0}>{counted(t, withPoints, "contest.batch.points.one", "contest.batch.points")}</BatchLine>
            <BatchLine show={others > 0}>{affectedWords(t, others)}</BatchLine>
          </ul>
          {stale > 0 ? <p className="text-fg-muted">{counted(t, stale, "contest.batch.stale.one", "contest.batch.stale")}</p> : null}
          <p className="text-fg-muted">{t("contest.batch.told")}</p>
          {running ? (
            <p role="status" className="text-[13px] tabular-nums text-fg-muted">
              {t("contest.batch.progress", { done: outcomes.length, total: list.length })}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function BatchLine({ show, children }: { show: boolean; children: ReactNode }) {
  if (!show) return null;
  return <li className="font-medium text-fg">{children}</li>;
}
