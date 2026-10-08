import { AlertTriangle, MessageCircleQuestion } from "lucide-react";
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { Asset, PoolDetail, QuestionDetail, ZodIssueLite } from "@quiz/contracts";
import { PARAMETERIZED_TYPES } from "@quiz/domain";

import { api } from "../api";
import { HelpIcon } from "../help";
import { useT } from "../i18n";
import { MarkdownField } from "../markdown/MarkdownField";
import { QuestionEditorHost, type TryOutcome } from "../questionTypes";
import type { Navigate } from "../router";
import { Alert, Card, Spinner } from "../ui";
import { AiCard } from "./AiCard";
import { useGenerate } from "./generate";
import { toConfigIssues } from "./issues";
import { MetaPanel } from "./MetaPanel";
import type { Draft } from "./useQuestionDraft";
import { isVariablesIssue, VariablesSection } from "./VariablesSection";

/**
 * The Edit tab: the type's own form, the variables of a type that takes
 * them (ADR-056) and the explanation on the left; on the right the AI card
 * (ADR-082), the question's properties and, under them, the slot a type may
 * portal its own settings into.
 */
export function QuestionEditTab({
  data,
  pool,
  draft,
  setDraft,
  issues,
  edited,
  readOnly,
  onTry,
  savedStamp,
  dirty,
  navigate,
}: {
  data: QuestionDetail;
  navigate: Navigate;
  /** `undefined` while the pool is loading. */
  pool: PoolDetail | undefined;
  draft: Draft | null;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  issues: readonly ZodIssueLite[];
  edited: boolean;
  readOnly: boolean;
  onTry: ((config: unknown) => Promise<TryOutcome>) | undefined;
  /** The stored draft's stamp, which the Variables section's draws are keyed on. */
  savedStamp: string | null;
  /** Something is typed and not yet stored. */
  dirty: boolean;
}) {
  const t = useT();
  const poolId = data.meta.poolId;
  /**
   * The slot of the right column a question type may portal its settings
   * into (`EditorProps.aside`): the mcq editor puts its "Scoring" card there,
   * under "Properties". STATE and not a ref, because the element does not
   * exist on the first render and a ref would never tell the editor it does.
   */
  const [scoringSlot, setScoringSlot] = useState<HTMLDivElement | null>(null);

  const uploadAsset = useCallback(
    async (file: File): Promise<string> => {
      const form = new FormData();
      form.append("file", file);
      const asset = await api<Asset>(`/app/api/pools/${poolId}/assets`, {
        method: "POST",
        body: form,
      });
      return `asset:${asset.id}`;
    },
    [poolId],
  );

  // The table's issues go to the Variables section, the rest to the type's form.
  const variablesIssues = useMemo(() => issues.filter(isVariablesIssue), [issues]);
  const configIssues = useMemo(
    () => toConfigIssues(t, issues.filter((issue) => !isVariablesIssue(issue))),
    [t, issues],
  );
  const parameterized = PARAMETERIZED_TYPES.has(data.meta.type);
  // Reported, not predicted: the alert appears once a save came back with
  // issues, or once the teacher has touched a draft the server already holds
  // as invalid. The Publish dialog reports the issues unconditionally — that
  // is the moment the draft has to be complete.
  const invalid = issues.length > 0 || (edited && data.draft.valid === false);
  const wand = useGenerate({ questionId: data.meta.id, type: data.meta.type, draft, setDraft, readOnly });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-5">
        {invalid ? (
          <Alert tone="warning" icon={AlertTriangle} title={t("question.invalidDraft")}>
            {t("question.invalidDraftBody")}
          </Alert>
        ) : null}
        {/* Kept after an opinion poll (ADR-014, addenda item 6): its published
            version has no key. Opening it asks for nothing; the strict gate
            applies only when a NEW version is published. One muted line,
            because nothing is wrong with the question as a poll. */}
        {data.keyless ? (
          <p className="flex items-start gap-2 text-[13px] text-fg-muted">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("question.keyless")}
          </p>
        ) : null}

        <Card className="p-5">
          {draft ? (
            <QuestionEditorHost
              t={t}
              type={data.meta.type}
              config={draft.config}
              onChange={(config) => setDraft({ ...draft, config })}
              issues={configIssues}
              disabled={readOnly}
              uploadAsset={uploadAsset}
              aside={scoringSlot}
              published={data.latestPublished !== null}
              {...(onTry === undefined ? {} : { onTry })}
              {...(wand.item === undefined ? {} : { onGenerateItem: wand.item })}
            />
          ) : (
            <Spinner />
          )}
        </Card>

        {parameterized && draft ? (
          <VariablesSection
            questionId={data.meta.id}
            type={data.meta.type}
            config={draft.config}
            explanation={draft.explanation}
            variables={draft.variables}
            onChange={(variables) => setDraft((current) => (current ? { ...current, variables } : current))}
            issues={variablesIssues}
            disabled={readOnly}
            savedStamp={savedStamp}
            dirty={dirty}
          />
        ) : null}

        <Card className="space-y-3 p-5">
          {/*
           * The caption is rendered HERE, and `MarkdownField`'s own is
           * left out (`labelHidden`): the "?" is a SIBLING of the label,
           * never inside it (DESIGN.md, "Field"), and `MarkdownField` has
           * no slot beside its caption. The prop is still passed, because
           * that is what names the editing surface — a contenteditable
           * takes its name from `aria-label`, not from a `<label for>`.
           */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium text-fg">{t("question.explanation")}</span>
            <HelpIcon topic="explanation" />
          </div>
          <MarkdownField
            labelHidden
            disabled={readOnly}
            label={t("question.explanation")}
            placeholder={t("question.explanation.placeholder")}
            value={draft?.explanation ?? ""}
            onChange={(explanation) =>
              setDraft((current) => (current ? { ...current, explanation } : current))
            }
            onUploadImage={async (file) => ({ id: (await uploadAsset(file)).slice("asset:".length) })}
          />
        </Card>
      </div>

      <aside aria-label={t("aside.questionMeta")} className="space-y-5">
        {/* Above "Properties": what the AI can do for this question. On a
            narrow screen the aside follows the explanation, and so does it. */}
        {draft ? <AiCard data={data} wand={wand} readOnly={readOnly} navigate={navigate} /> : null}
        <MetaPanel
          meta={data.meta}
          categories={pool?.categories ?? []}
          poolName={pool?.pool.name ?? "—"}
          disabled={readOnly}
        />
        {/* Where the type's own settings land, under "Properties". Empty
            for a type that portals nothing, and then it must not eat a
            row of the column's spacing. */}
        <div ref={setScoringSlot} className="empty:hidden" />
      </aside>
    </div>
  );
}
