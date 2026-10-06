import { Copy, Eye, Save, ScanSearch, Trash2 } from "lucide-react";

import type { QuestionDetail } from "@quiz/contracts";
import { reviewPill } from "@quiz/domain";

import { useT } from "../i18n";
import { typeIcon, typeLabel } from "../questionTypes";
import { routeToPath, type Route } from "../router";
import { Trail, usePoolsCrumb } from "../Trail";
import { Badge, Button, LinkButton, Menu, PageHeader, SyncBadge } from "../ui";
import { ParameterizedBadge } from "../pool/ParameterizedBadge";
import { ReviewBadge } from "../pool/ReviewBadge";
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
  origin,
  readOnly,
  autosave,
  navigate,
  onPublish,
  onDuplicate,
  onDelete,
  onReviewNow,
}: {
  id: string;
  data: QuestionDetail;
  /** `undefined` while the pool is loading. */
  poolName: string | undefined;
  /**
   * The page the editor was opened from — an evaluation (issue #127), a
   * template, the grading screen — named and routed: it stands in the trail
   * instead of the pool, so the way back leads there.
   */
  origin?: { label: string; back: Route } | undefined;
  readOnly: boolean;
  autosave: Autosave;
  navigate: (r: Route) => void;
  onPublish: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** "Review now" (ADR-060), in the menu; undefined when it is not offered. */
  onReviewNow?: (() => void) | undefined;
}) {
  const t = useT();
  const poolsRoot = usePoolsCrumb();
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
        <Trail
          navigate={navigate}
          items={
            origin
              ? // Opened from an evaluation, a template or the grading screen: the way
                // back to it is the ancestor (publishing from grading returns there).
                [{ label: origin.label, route: origin.back }, { label: data.meta.internalName }]
              : [
                  poolsRoot,
                  poolName === undefined ? null : { label: poolName, route: { view: "pool", id: data.meta.poolId } },
                  { label: data.meta.internalName },
                ]
          }
        />
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
          {/* ADR-056 §8: its published version draws values per attempt. */}
          {data.meta.randomizable ? <ParameterizedBadge /> : null}
          <ReviewBadge review={data.review ? reviewPill(data.review.state, data.review.findings) : null} />
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
            data-coach="question.preview"
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
            <Button data-coach="question.publish" onClick={onPublish}>
              {t("question.publish")}
            </Button>
          )}
        </>
      }
      menu={
        readOnly ? null : (
          <Menu
            label={t("common.actions")}
            items={[
              { label: t("question.saveNow"), icon: Save, onSelect: () => autosave.flush() },
              {
                label: t("question.duplicate"),
                icon: Copy,
                onSelect: onDuplicate,
              },
              ...(onReviewNow ? [{ label: t("review.now"), icon: ScanSearch, onSelect: onReviewNow }] : []),
              {
                label: t("question.delete"),
                icon: Trash2,
                danger: true,
                separator: true,
                onSelect: onDelete,
              },
            ]}
          />
        )
      }
    />
  );
}
