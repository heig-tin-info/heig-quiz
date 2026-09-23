import { Copy, Eye, Save, Trash2 } from "lucide-react";

import type { QuestionDetail } from "@quiz/contracts";

import { useT } from "../i18n";
import { typeIcon, typeLabel } from "../questionTypes";
import { routeToPath } from "../router";
import { Badge, Button, LinkButton, Menu, PageHeader, ParentLink, SyncBadge } from "../ui";
import type { Autosave } from "./autosave";

/**
 * The editor's header: the pool it lives in, the question's internal name,
 * where it stands (type, published version, unpublished changes, the save
 * badge) and its actions — the preview, and "Publish", the ONE primary action,
 * with the overflow menu beside it.
 */
export function QuestionHeader({
  id,
  data,
  poolName,
  readOnly,
  autosave,
  onBack,
  onPublish,
  onDuplicate,
  onDelete,
}: {
  id: string;
  data: QuestionDetail;
  /** `undefined` while the pool is loading. */
  poolName: string | undefined;
  readOnly: boolean;
  autosave: Autosave;
  onBack: () => void;
  onPublish: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const latest = data.latestPublished;
  // "Unpublished changes" is about the STORED draft, not about the request in
  // flight: a draft saved yesterday and never published is still ahead.
  const draftAhead =
    latest !== null &&
    (autosave.dirty || new Date(data.draft.updatedAt) > new Date(latest.publishedAt));
  const Icon = typeIcon(data.meta.type);

  return (
    <PageHeader
      help="question-editor"
      eyebrow={
        <ParentLink onClick={onBack}>{poolName ?? t("pools.title")}</ParentLink>
      }
      title={<span className="font-mono">{data.meta.internalName}</span>}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="zinc" icon={Icon}>
            {typeLabel(t, data.meta.type)}
          </Badge>
          {latest ? (
            <Badge tone="green">{t("question.published", { n: latest.number })}</Badge>
          ) : (
            <Badge tone="amber">{t("question.draft")}</Badge>
          )}
          {draftAhead ? (
            <Badge tone="amber">{t("question.unpublished")}</Badge>
          ) : null}
          {readOnly ? (
            <Badge tone="zinc" icon={Eye}>
              {t("question.readOnly")}
            </Badge>
          ) : (
            <SyncBadge state={autosave.state} />
          )}
        </span>
      }
      actions={
        <>
          {/* It opens a TAB, so it is an anchor: middle-click, Ctrl-click
              and "open in a new window" all have to work, and a <button>
              offers none of them. `noopener` on both halves. */}
          <LinkButton
            variant="secondary"
            href={routeToPath({ view: "questionPreview", id })}
            target="_blank"
            rel="noopener"
            onClick={() => autosave.flush()}
          >
            <Eye /> {t("question.preview")}
          </LinkButton>
          {/*
           * A reader keeps the preview and loses the rest. Publish, save and
           * delete would each be refused by the server, and "duplicate"
           * writes into THIS pool, which a reader may not do either — so the
           * overflow menu has nothing left to hold and goes with them, rather
           * than staying as a row of actions that answer with an error.
           */}
          {readOnly ? null : (
            <>
              <Button onClick={onPublish}>{t("question.publish")}</Button>
              <Menu
                label={t("common.actions")}
                items={[
                  { label: t("question.saveNow"), icon: Save, onSelect: () => autosave.flush() },
                  {
                    label: t("question.duplicate"),
                    icon: Copy,
                    onSelect: onDuplicate,
                  },
                  {
                    label: t("question.delete"),
                    icon: Trash2,
                    danger: true,
                    separator: true,
                    onSelect: onDelete,
                  },
                ]}
              />
            </>
          )}
        </>
      }
    />
  );
}
