import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Tags } from "lucide-react";
import { useEffect, useState } from "react";

import { ConceptSuggestions, type NewConceptName, type QuestionMeta, type SuggestConceptsRequest } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { poolKey, questionKey } from "../queryKeys";
import { Button, Checkbox, ErrorText, Modal } from "../ui";
import { refName } from "./names";

/**
 * "Suggest concepts" (ADR-081 sixth addendum §6, in the editor's AI card,
 * ADR-082 §5): the model reads the draft and the vocabulary and proposes up to
 * five existing concepts and two new labels. Nothing is stored by the call.
 * The teacher ticks the existing ones and adds them (the question's own concept
 * write, like the picker); a new label opens the picker's create form,
 * prefilled, because a concept is never created silently.
 *
 * The card draws this only with a model, for a writer and a loaded draft. The
 * request starts when the dialog opens.
 */
export function SuggestConcepts({
  meta,
  config,
  onCreate,
}: {
  meta: QuestionMeta;
  /** The editor's draft config, saved or not. */
  config: unknown;
  /** A new label chosen: the editor hands it to the picker's create form. */
  onCreate: (name: NewConceptName) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const [open, setOpen] = useState(false);
  const add = useMutation({
    mutationFn: (ids: string[]) =>
      api(`/app/api/questions/${meta.id}`, {
        method: "PATCH",
        body: JSON.stringify({ concepts: [...new Set([...meta.concepts.map((c) => c.id), ...ids])] }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: questionKey(meta.id) });
      await qc.invalidateQueries({ queryKey: poolKey(meta.poolId) });
    },
    onError: toastError("question.meta.saveFailed"),
  });

  return (
    <>
      <Button variant="secondary" className="w-full" loading={add.isPending} onClick={() => setOpen(true)}>
        {add.isPending ? null : <Tags />} {t("concepts.suggest.button")}
      </Button>
      {open ? (
        <SuggestDialog
          questionId={meta.id}
          config={config}
          onClose={() => setOpen(false)}
          onAdd={(ids) => {
            setOpen(false);
            add.mutate(ids);
          }}
          onCreate={(name) => {
            setOpen(false);
            onCreate(name);
          }}
        />
      ) : null}
    </>
  );
}

function SuggestDialog({
  questionId,
  config,
  onClose,
  onAdd,
  onCreate,
}: {
  questionId: string;
  config: unknown;
  onClose: () => void;
  onAdd: (ids: string[]) => void;
  onCreate: (name: NewConceptName) => void;
}) {
  const t = useT();
  // The draft as it was when the dialog opened: the answer is about that one.
  const [asked] = useState(config);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const suggestions = useMutation({
    mutationFn: async () => {
      const body: SuggestConceptsRequest = { config: asked };
      return ConceptSuggestions.parse(
        await api(`/app/api/questions/${questionId}/suggest-concepts`, { method: "POST", body: JSON.stringify(body) }),
      );
    },
  });
  // Once on mount, while idle (React's development double mount asks twice, which the mutation tolerates); Retry asks again.
  const { isIdle, mutate } = suggestions;
  useEffect(() => {
    if (isIdle) mutate();
  }, [isIdle, mutate]);
  const data = suggestions.data;
  const empty = data !== undefined && data.existing.length === 0 && data.created.length === 0;
  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Modal
      title={t("concepts.suggest.title")}
      subtitle={t("concepts.suggest.hint")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={ticked.size === 0} onClick={() => onAdd([...ticked])}>
            {t("concepts.suggest.add", { n: ticked.size })}
          </Button>
        </>
      }
    >
      <div className="space-y-4" aria-busy={suggestions.isPending}>
        {suggestions.isPending ? (
          <p role="status" className="text-sm text-fg-muted">
            {t("concepts.suggest.loading")}
          </p>
        ) : suggestions.isError ? (
          <div className="space-y-2">
            <ErrorText role="alert">{apiErrorMessage(suggestions.error, t("concepts.suggest.failed"))}</ErrorText>
            <Button variant="secondary" size="sm" onClick={() => suggestions.mutate()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : empty ? (
          <p className="text-sm text-fg-muted">{t("concepts.suggest.empty")}</p>
        ) : null}

        {data && data.existing.length > 0 ? (
          <fieldset className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            <legend className="sr-only">{t("concepts.suggest.existing")}</legend>
            {data.existing.map(({ concept, reason, asked: typed }) => (
              <div key={concept.id} className="px-3 py-2.5">
                <Checkbox
                  checked={ticked.has(concept.id)}
                  onChange={() => toggle(concept.id)}
                  label={
                    <span className="font-semibold">
                      {refName(concept)}
                      {concept.status === "proposed" ? (
                        <span className="ml-2 text-xs font-normal text-fg-faint">{t("concepts.picker.proposed")}</span>
                      ) : null}
                    </span>
                  }
                />
                <p className="pl-[26px] text-xs text-fg-muted">
                  {typed !== undefined ? `${t("concepts.suggest.didYouMean", { name: refName(typed) })} ` : ""}
                  {reason}
                </p>
              </div>
            ))}
          </fieldset>
        ) : null}

        {data && data.created.length > 0 ? (
          <section aria-labelledby="suggest-new" className="space-y-2">
            <h3 id="suggest-new" className="text-[13px] font-semibold text-fg">
              {t("concepts.suggest.new")}
            </h3>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {data.created.map(({ label, qualifier, reason }) => (
                <li key={refName({ label, qualifier })} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{refName({ label, qualifier })}</p>
                    <p className="text-xs text-fg-muted">{reason}</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => onCreate({ label, qualifier })}>
                    <Plus aria-hidden />
                    {t("concepts.suggest.create")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
