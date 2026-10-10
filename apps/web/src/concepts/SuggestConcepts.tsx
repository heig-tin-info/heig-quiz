import { useQuery } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import { useState } from "react";

import { ConceptSuggestions } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useLlmAvailability } from "../llmAvailability";
import { Button, Checkbox, ErrorText, Modal } from "../ui";
import { refName } from "./names";

/**
 * "Suggest concepts" (ADR-081 sixth addendum §6): the model reads the draft
 * and the vocabulary and proposes up to five existing concepts and two new
 * labels. Nothing is stored by the call. The teacher ticks the existing
 * ones and adds them (the question's own concept write, like the picker); a
 * new label opens the picker's create form, prefilled, because a concept is
 * never created silently.
 *
 * A secondary action next to the picker, absent (not disabled) while the
 * platform has no model or the draft is not loaded. The request starts when
 * the dialog opens.
 */
export function SuggestConcepts({
  questionId,
  config,
  disabled,
  onAdd,
  onCreate,
}: {
  questionId: string;
  /** The editor's draft config, saved or not; undefined until it is loaded. */
  config: unknown;
  disabled?: boolean | undefined;
  /** The concepts ticked: the caller adds them to the question. */
  onAdd: (ids: string[]) => void;
  /** A new label chosen: the caller opens the picker's create form with it. */
  onCreate: (label: string) => void;
}) {
  const t = useT();
  const availability = useLlmAvailability();
  const [open, setOpen] = useState(false);
  if (availability.data?.available !== true || config === undefined) return null;

  return (
    <>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <Sparkles aria-hidden />
        {t("concepts.suggest.button")}
      </Button>
      {open ? (
        <SuggestDialog
          questionId={questionId}
          config={config}
          onClose={() => setOpen(false)}
          onAdd={(ids) => {
            setOpen(false);
            onAdd(ids);
          }}
          onCreate={(label) => {
            setOpen(false);
            onCreate(label);
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
  onCreate: (label: string) => void;
}) {
  const t = useT();
  // The draft as it was when the dialog opened: the answer is about that one.
  const [asked] = useState(config);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const suggestions = useQuery({
    queryKey: ["suggest-concepts", questionId],
    queryFn: async () =>
      ConceptSuggestions.parse(
        await api(`/app/api/questions/${questionId}/suggest-concepts`, {
          method: "POST",
          body: JSON.stringify({ config: asked }),
        }),
      ),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
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
      <div className="space-y-4" aria-busy={suggestions.isFetching}>
        {suggestions.isFetching ? (
          <p role="status" className="text-sm text-fg-muted">
            {t("concepts.suggest.loading")}
          </p>
        ) : suggestions.isError ? (
          <div className="space-y-2">
            <ErrorText role="alert">{apiErrorMessage(suggestions.error, t("concepts.suggest.failed"))}</ErrorText>
            <Button variant="secondary" size="sm" onClick={() => void suggestions.refetch()}>
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
                  {typed !== undefined ? `${t("concepts.suggest.didYouMean", { name: typed })} ` : ""}
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
              {data.created.map(({ label, reason }) => (
                <li key={label} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{label}</p>
                    <p className="text-xs text-fg-muted">{reason}</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => onCreate(label)}>
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
