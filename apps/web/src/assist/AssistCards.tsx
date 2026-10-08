/**
 * The teacher assistant's proposals (ADR-080, P3 amendment), one card each
 * under the answer that made them. Nothing acts before the teacher does:
 *
 * - an editor proposal (`edit_question`) shows each field before and after;
 *   Apply merges it into the open draft as ONE edit, only while the draft is
 *   still the one it was computed against (else it is dropped and says so),
 *   with an Undo until the draft changes again; the autosave stores it,
 *   nothing publishes it;
 * - a write command of the screen (`confirm_command`) names the command; it
 *   runs on Confirm only, while the screen still offers it — its own
 *   confirmation dialog, if it has one, still asks;
 * - a prepared write (`pending_write`) shows what the SERVER read back from
 *   its frozen arguments; Confirm runs exactly those, once, and links to the
 *   result; Cancel forgets it.
 *
 * Confirm and Apply are the card's own primary, in the ink of the dock —
 * never the accent, which stays the screen's (ADR-069); Cancel is secondary.
 */
import { useMutation } from "@tanstack/react-query";
import { CircleAlert, CornerDownRight, FilePenLine, Play, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { AssistAction, AssistWriteDecision, AssistWriteDone } from "@quiz/contracts";
import { EXPLANATION_FIELD } from "@quiz/domain";
import { buttonClass } from "@quiz/ui";

import { api, ApiError, refusedWith } from "../api";
import { useI18n, type TFunction } from "../i18n";
import { typeLabel } from "../questionTypes";
import { parsePath, type Navigate } from "../router";
import { Button, cx } from "../ui";
import { runConfirmedCommand } from "./actions";
import { assistEditor } from "./editor";
import type { Draft } from "../question/useQuestionDraft";

type Edit = Extract<AssistAction, { kind: "edit_question" }>;
type Command = Extract<AssistAction, { kind: "confirm_command" }>;
type Write = Extract<AssistAction, { kind: "pending_write" }>;

/** Why a confirmed write was not done, as the route's code says it (`write_failed`'s `reason`). */
function failureOf(error: unknown): "not_found" | "refused" | "invalid" | "failed" {
  const reason = error instanceof ApiError ? (error.body as { reason?: unknown } | null)?.reason : undefined;
  return reason === "not_found" || reason === "refused" || reason === "invalid" ? reason : "failed";
}

/** The card's primary: ink on the neutral dock, never the accent. */
const inkClass = buttonClass("secondary", "sm", "!border-transparent !bg-fg !text-surface hover:!opacity-90");

/** A field of the draft, named as the editor names it. */
export function fieldLabel(path: string, t: TFunction): string {
  if (path === "prompt" || path === "text") return t("assist.edit.statement");
  if (path === EXPLANATION_FIELD) return t("assist.edit.explanation");
  const item = /^(choices|columns|cards)\.(\d+)\./.exec(path);
  if (item) {
    const key = { choices: "assist.edit.choice", columns: "assist.edit.column", cards: "assist.edit.card" } as const;
    return t(key[item[1] as keyof typeof key], { n: Number(item[2]) + 1 });
  }
  return path;
}

function Shell({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 rounded-card border border-line bg-surface p-3" aria-label={title}>
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
        {icon}
        {title}
      </p>
      {children}
    </section>
  );
}

/** What a card says once acted on: a muted line, or a danger one. */
function Outcome({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p role="status" className={cx("flex items-center gap-1.5 text-[12px]", ok ? "text-fg-muted" : "text-danger")}>
      {ok ? <CornerDownRight className="size-3.5 shrink-0" aria-hidden /> : <CircleAlert className="size-3.5 shrink-0" aria-hidden />}
      <span>{children}</span>
    </p>
  );
}

function Decide({
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
        {t("assist.cancel")}
      </Button>
      <button type="button" className={inkClass} onClick={onConfirm} disabled={busy}>
        {confirmLabel}
      </button>
    </div>
  );
}

function EditCard({ edit }: { edit: Edit }) {
  const { t } = useI18n();
  const [state, setState] = useState<
    { s: "open" } | { s: "applied"; before: Draft } | { s: "undone" } | { s: "stale" } | { s: "away" } | { s: "cancelled" }
  >({ s: "open" });
  const next = { config: edit.config, explanation: edit.explanation };
  const apply = () => {
    const editor = assistEditor(edit.questionId);
    if (!editor) return setState({ s: "away" });
    const before = editor.apply(edit.base, next);
    setState(before ? { s: "applied", before } : { s: "stale" });
  };
  const undo = (before: Draft) => {
    const editor = assistEditor(edit.questionId);
    setState(editor?.restore(before, next) ? { s: "undone" } : { s: "stale" });
  };
  return (
    <Shell icon={<FilePenLine className="size-4 text-fg-muted" aria-hidden />} title={t("assist.edit.title")}>
      <ul className="space-y-2.5">
        {edit.fields.map((f) => (
          <li key={f.path} className="space-y-1 text-[13px]">
            <p className="text-[12px] font-semibold text-fg-muted">{fieldLabel(f.path, t)}</p>
            {f.before === null ? null : (
              <p className="rounded-field bg-danger-soft/60 px-2 py-1 whitespace-pre-wrap text-fg-muted line-through decoration-danger/40">
                <span className="sr-only">{t("assist.edit.before")}: </span>
                {f.before}
              </p>
            )}
            <p className="rounded-field bg-success-soft/60 px-2 py-1 whitespace-pre-wrap text-fg">
              <span className="sr-only">{f.before === null ? t("assist.edit.added") : t("assist.edit.after")}: </span>
              {f.after}
            </p>
          </li>
        ))}
      </ul>
      {state.s === "open" ? (
        <Decide confirmLabel={t("assist.edit.apply")} onConfirm={apply} onCancel={() => setState({ s: "cancelled" })} />
      ) : state.s === "applied" ? (
        <div className="flex items-center justify-between gap-2">
          <Outcome ok>{t("assist.edit.applied")}</Outcome>
          <Button variant="ghost" size="sm" onClick={() => undo(state.before)}>
            {t("assist.edit.undo")}
          </Button>
        </div>
      ) : state.s === "undone" ? (
        <Outcome ok>{t("assist.edit.undone")}</Outcome>
      ) : state.s === "cancelled" ? (
        <Outcome ok>{t("assist.cancelled")}</Outcome>
      ) : (
        <Outcome ok={false}>{t(state.s === "stale" ? "assist.edit.stale" : "assist.edit.away")}</Outcome>
      )}
    </Shell>
  );
}

function CommandCard({ command }: { command: Command }) {
  const { t } = useI18n();
  const [state, setState] = useState<"open" | "done" | "gone" | "cancelled">("open");
  return (
    <Shell icon={<Play className="size-4 text-fg-muted" aria-hidden />} title={t("assist.command.title")}>
      <p className="text-sm font-semibold text-fg">{command.label}</p>
      <p className="text-[12px] text-fg-muted">{t("assist.command.body")}</p>
      {state === "open" ? (
        <Decide
          confirmLabel={t("assist.confirm")}
          onConfirm={() => setState(runConfirmedCommand(command.id) ? "done" : "gone")}
          onCancel={() => setState("cancelled")}
        />
      ) : state === "done" ? (
        <Outcome ok>{t("assist.ran", { command: command.label })}</Outcome>
      ) : state === "cancelled" ? (
        <Outcome ok>{t("assist.cancelled")}</Outcome>
      ) : (
        <Outcome ok={false}>{t("assist.runFailed")}</Outcome>
      )}
    </Shell>
  );
}

/** A value of a card line in the UI language where the platform has a label for it. */
function lineValue(field: Write["lines"][number]["field"], value: string, t: TFunction): string {
  if (field === "type") return typeLabel(t, value);
  if (field === "mode" && (value === "exam" || value === "exercise")) return t(`eval.mode.${value}`);
  return value;
}

function WriteCard({ write, conversationId, navigate }: { write: Write; conversationId: string; navigate: Navigate | undefined }) {
  const { t } = useI18n();
  const [cancelled, setCancelled] = useState(false);
  const confirm = useMutation({
    mutationFn: () =>
      api<AssistWriteDone>(`/app/api/assist/writes/${write.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ conversationId } satisfies AssistWriteDecision),
      }),
  });
  const cancel = () => {
    setCancelled(true);
    void api(`/app/api/assist/writes/${write.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ conversationId } satisfies AssistWriteDecision),
    }).catch(
      () => undefined,
    );
  };
  return (
    <Shell icon={<ShieldCheck className="size-4 text-fg-muted" aria-hidden />} title={t(`assist.write.${write.tool}`)}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        {write.lines.map((l) => (
          <div key={l.field} className="contents">
            <dt className="text-fg-muted">{t(`assist.write.field.${l.field}`)}</dt>
            <dd className="min-w-0 break-words text-fg">
              {l.values.length > 1 ? (
                <ul className="list-disc pl-4">
                  {l.values.map((v, i) => (
                    <li key={i}>{lineValue(l.field, v, t)}</li>
                  ))}
                </ul>
              ) : (
                lineValue(l.field, l.values[0] ?? "", t)
              )}
            </dd>
          </div>
        ))}
      </dl>
      {write.tool === "create_question" ? <p className="text-[12px] text-fg-muted">{t("assist.write.draftNote")}</p> : null}
      {write.tool === "link_pool_to_course" ? <p className="text-[12px] text-fg-muted">{t("assist.write.accessNote")}</p> : null}
      {confirm.isSuccess ? (
        <div className="flex items-center justify-between gap-2">
          <Outcome ok>{t("assist.write.done")}</Outcome>
          {navigate ? (
            <Button variant="ghost" size="sm" onClick={() => navigate(parsePath(confirm.data.path))}>
              {t("assist.write.open")}
            </Button>
          ) : null}
        </div>
      ) : confirm.isError ? (
        <Outcome ok={false}>
          {refusedWith(confirm.error, "write_not_found")
            ? t("assist.write.gone")
            : t(`assist.write.failed.${failureOf(confirm.error)}`)}
        </Outcome>
      ) : cancelled ? (
        <Outcome ok>{t("assist.cancelled")}</Outcome>
      ) : (
        <>
          <p className="text-[12px] text-fg-faint">{t("assist.write.notice")}</p>
          <Decide confirmLabel={t("assist.confirm")} onConfirm={() => confirm.mutate()} onCancel={cancel} busy={confirm.isPending} />
        </>
      )}
    </Shell>
  );
}

/** The proposals of one answer, a card each. */
export function AssistCards({
  actions,
  conversationId,
  navigate,
}: {
  actions: readonly AssistAction[];
  conversationId: string;
  navigate: Navigate | undefined;
}) {
  return (
    <div className="space-y-2">
      {actions.map((action, i) =>
        action.kind === "edit_question" ? (
          <EditCard key={i} edit={action} />
        ) : action.kind === "confirm_command" ? (
          <CommandCard key={i} command={action} />
        ) : action.kind === "pending_write" ? (
          <WriteCard key={action.id} write={action} conversationId={conversationId} navigate={navigate} />
        ) : null,
      )}
    </div>
  );
}
