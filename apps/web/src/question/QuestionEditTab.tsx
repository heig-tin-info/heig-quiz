import { AlertTriangle } from "lucide-react";
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { Asset, PoolDetail, QuestionDetail, ZodIssueLite } from "@quiz/contracts";

import { api } from "../api";
import { HelpIcon } from "../help";
import { useT } from "../i18n";
import { MarkdownField } from "../markdown/MarkdownField";
import { QuestionEditorHost, type TryOutcome } from "../questionTypes";
import { Alert, Card, Spinner } from "../ui";
import { toConfigIssues } from "./issues";
import { MetaPanel } from "./MetaPanel";
import type { Draft } from "./useQuestionDraft";

/**
 * The Edit tab: the type's own form and the explanation on the left, the
 * question's properties on the right — with, under them, the slot a type may
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
}: {
  data: QuestionDetail;
  /** `undefined` while the pool is loading. */
  pool: PoolDetail | undefined;
  draft: Draft | null;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  issues: readonly ZodIssueLite[];
  edited: boolean;
  readOnly: boolean;
  onTry: ((config: unknown) => Promise<TryOutcome>) | undefined;
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

  const configIssues = useMemo(() => toConfigIssues(t, issues), [t, issues]);
  // Reported, not predicted: the alert appears once a save came back with
  // issues, or once the teacher has touched a draft the server already holds
  // as invalid. The Publish dialog reports the issues unconditionally — that
  // is the moment the draft has to be complete.
  const invalid = issues.length > 0 || (edited && data.draft.valid === false);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-5">
        {invalid ? (
          <Alert tone="warning" icon={AlertTriangle} title={t("question.invalidDraft")}>
            {t("question.invalidDraftBody")}
          </Alert>
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
              {...(onTry === undefined ? {} : { onTry })}
            />
          ) : (
            <Spinner />
          )}
        </Card>

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
            value={draft?.explanation ?? ""}
            onChange={(explanation) =>
              setDraft((current) => (current ? { ...current, explanation } : current))
            }
            onUploadImage={async (file) => ({ id: (await uploadAsset(file)).slice("asset:".length) })}
          />
        </Card>
      </div>

      <aside aria-label={t("aside.questionMeta")} className="space-y-5">
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
