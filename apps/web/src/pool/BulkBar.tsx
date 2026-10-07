import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInput, FolderSymlink, Star, StarOff, Tag, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { Category, CategoryNode, PoolDetail, PoolSummary, QuestionRow } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { categoryPaths } from "./categories";
import { useMoveQuestions } from "./move";
import { useErrorToast, useToast } from "../notify";
import { Button, Field, FormDialog, IconButton, Select, Spinner, Z } from "../ui";
import { anyPoolKey, poolKey, poolsKey } from "../queryKeys";

/**
 * What to do with the ticked questions, on the pool screen: a floating
 * bar that only exists while a selection does. It is the one place in the
 * screen allowed a shadow — it genuinely sits above the table.
 *
 * Three of the four operations are sequential calls to the ordinary routes
 * (`PATCH /questions/:id`, `DELETE /questions/:id`): the API has no bulk
 * endpoint for them, and a teacher tagging twenty questions is not a reason to
 * invent one. What the bar owes the reader is a single report at the end,
 * which is what `runAll` produces.
 *
 * "Move to another pool" is the exception and is ONE call
 * (`POST /questions/move`, ADR-017): a move can be refused for the whole
 * selection at once — a classroom plays one of the questions, a name is
 * already taken there — and twenty separate calls would mean twenty separate
 * confirmations for one intention. It is also the keyboard's way to do what
 * the sidebar does with a drag.
 *
 * "Star" is one call too (`PUT /questions/star`, F-POOL-10), and ONE button
 * rather than a pair: it reads "Unstar" when every ticked question is
 * already starred and "Star" otherwise, so it always offers the one gesture
 * that changes something — and the bar, already five actions wide, does not
 * grow a sixth. It keeps the selection: the rows flip in place, and the
 * teacher may go on to tag or move what they just starred.
 */

/** The `<option>` value that opens the "name it" field instead of picking. */
const NEW_CATEGORY = "__new__";

export function BulkBar({
  poolId,
  ids,
  rows,
  categories,
  onStar,
  onClear,
}: {
  poolId: string;
  ids: string[];
  /** The loaded rows, so "add a tag" can keep the tags a question already has. */
  rows: QuestionRow[];
  categories: CategoryNode[];
  /** Stars or unstars the selection, optimistically (`useSetStars`). */
  onStar: (ids: string[], starred: boolean) => Promise<boolean>;
  onClear: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const moveQuestions = useMoveQuestions();
  const [dialog, setDialog] = useState<"tag" | "move" | "pool" | null>(null);
  const [tag, setTag] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * The move has a busy flag of its OWN: `busy` is the bar's, and the Delete
   * button reads it, so sharing it would spin a destructive button while
   * something else is running.
   */
  const [moving, setMoving] = useState(false);
  const starredIds = new Set(rows.filter((r) => r.starred).map((r) => r.id));
  const allStarred = ids.every((id) => starredIds.has(id));
  /** The chosen target pool of the "another pool" dialog, and its category. */
  const [targetPoolId, setTargetPoolId] = useState("");
  const [targetCategoryId, setTargetCategoryId] = useState("");

  // The pools the teacher may WRITE to, this one excluded: a move to the pool
  // the questions are already in is what the category dialog above is for.
  const pools = useQuery<PoolSummary[]>({
    queryKey: poolsKey,
    queryFn: () => api("/app/api/pools"),
    enabled: dialog === "pool",
  });
  const targets = (pools.data ?? []).filter((p) => p.id !== poolId && p.role !== "reader");
  // The chosen pool's folders, on the key its own screen uses.
  const target = useQuery<PoolDetail>({
    queryKey: poolKey(targetPoolId),
    queryFn: () => api(`/app/api/pools/${targetPoolId}`),
    enabled: dialog === "pool" && targetPoolId !== "",
  });

  /** Runs one call per question, counts the failures, reports once. */
  const runAll = async (step: (id: string) => Promise<unknown>) => {
    setBusy(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await step(id);
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setDialog(null);
    await qc.invalidateQueries({ queryKey: anyPoolKey });
    if (failed > 0) toast(t("pool.bulk.failed", { n: failed }), "error");
    else toast(t("pool.bulk.done", { n: ids.length }), "success");
    onClear();
  };

  const addTag = () => {
    const value = tag.trim();
    if (!value) return;
    void runAll((id) => {
      const row = rows.find((r) => r.id === id);
      const tags = row ? [...new Set([...row.tags, value])] : [value];
      return api(`/app/api/questions/${id}`, { method: "PATCH", body: JSON.stringify({ tags }) });
    });
  };

  /**
   * Moves the selection, creating the destination first when the teacher
   * asked for one. Filing twenty questions under a category that does not
   * exist yet is the ordinary case — coming here, leaving for the sidebar to
   * create it and coming back is three screens for one intention — so the
   * dialog does both in the click that says "Move".
   *
   * The category is created through the SAME route the tree uses, and the
   * pool query is invalidated so the sidebar shows it immediately.
   */
  const move = async () => {
    let target = categoryId === "" ? null : categoryId;
    if (categoryId === NEW_CATEGORY) {
      const name = newName.trim();
      if (!name) return;
      setBusy(true);
      try {
        const created = await api<Category>(`/app/api/pools/${poolId}/categories`, {
          method: "POST",
          body: JSON.stringify({ name, parentId: null }),
        });
        target = created.id;
      } catch (error) {
        setBusy(false);
        toastError("pool.categoryFailed")(error);
        return;
      }
      await qc.invalidateQueries({ queryKey: poolKey(poolId) });
    }
    await runAll((id) =>
      api(`/app/api/questions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId: target }),
      }),
    );
  };

  /**
   * The selection into another pool, in one call. The dialog closes on a
   * success and STAYS on a refusal, because every refusal the server has
   * (a taken name, a course that is not the caller's) is answered by picking
   * another pool — which is the very control the dialog holds.
   */
  const moveToPool = async () => {
    const pool = targets.find((p) => p.id === targetPoolId);
    if (!pool) return;
    setMoving(true);
    const done = await moveQuestions({
      questionIds: ids,
      targetPoolId: pool.id,
      targetPoolName: pool.name,
      categoryId: targetCategoryId === "" ? null : targetCategoryId,
      label: ids.length === 1 ? (rows.find((r) => r.id === ids[0])?.internalName ?? "") : "",
    });
    setMoving(false);
    if (!done) return;
    setDialog(null);
    setTargetPoolId("");
    setTargetCategoryId("");
    onClear();
  };

  const remove = async () => {
    const ok = await confirm({
      title: t("pool.bulk.delete"),
      message: t("pool.bulk.deleteConfirm", { n: ids.length }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) await runAll((id) => api(`/app/api/questions/${id}`, { method: "DELETE" }));
  };

  return (
    <>
      <div
        role="region"
        aria-label={t("pool.bulk.selected", { n: ids.length })}
        // 54 rem: 40 held three actions, 48 the fourth ("another pool"), and the
        // fifth ("Star") pushed the close button onto a second line — a pill bar that
        // wraps reads as two bars. The radius is 28 px rather than `full`:
        // on one line the browser clamps it to half the height, so the pill is
        // unchanged, and on a phone — where five actions really do wrap — the
        // bar stays a rounded rectangle instead of becoming a lens.
        data-bulk-bar
        className={`fixed inset-x-0 bottom-4 mx-auto flex w-[min(54rem,calc(100%-2rem))] flex-wrap items-center gap-2 rounded-[28px] border border-line bg-surface px-4 py-2 shadow-overlay ${Z.popover}`}
      >
        <span className="text-[13px] font-medium tabular-nums">
          {t("pool.bulk.selected", { n: ids.length })}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void onStar(ids, !allStarred)}>
          {allStarred ? <StarOff /> : <Star />} {t(allStarred ? "pool.bulk.unstar" : "pool.bulk.star")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog("tag")}>
          <Tag /> {t("pool.bulk.tag")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog("move")}>
          <FolderInput /> {t("pool.bulk.move")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog("pool")}>
          <FolderSymlink /> {t("pool.bulk.movePool")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void remove()} loading={busy}>
          <Trash2 /> {t("pool.bulk.delete")}
        </Button>
        <span className="ml-auto">
          <IconButton label={t("pool.bulk.clear")} onClick={onClear}>
            <X />
          </IconButton>
        </span>
      </div>

      {dialog === "tag" ? (
        <FormDialog
          title={t(ids.length === 1 ? "pool.bulk.tagTitle.one" : "pool.bulk.tagTitle", { n: ids.length })}
          onClose={() => setDialog(null)}
          onSubmit={addTag}
          submitLabel={t("pool.bulk.tag")}
          submitting={busy}
          canSubmit={tag.trim() !== ""}
        >
          <Field
            label={t("question.meta.tagAdd")}
            fullWidth
            autoFocus
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
        </FormDialog>
      ) : null}

      {dialog === "move" ? (
        <FormDialog
          title={t(ids.length === 1 ? "pool.bulk.moveTitle.one" : "pool.bulk.moveTitle", { n: ids.length })}
          onClose={() => setDialog(null)}
          onSubmit={() => void move()}
          submitLabel={t("pool.bulk.move")}
          submitting={busy}
          canSubmit={categoryId !== NEW_CATEGORY || newName.trim() !== ""}
        >
          <Select
            label={t("question.meta.category")}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">{t("pool.bulk.root")}</option>
            {categoryPaths(categories).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            {/* Last, and named with an ellipsis: it is the one entry that
                asks a question instead of answering one. */}
            <option value={NEW_CATEGORY}>{t("pool.bulk.newCategory")}</option>
          </Select>
          {categoryId === NEW_CATEGORY ? (
            <Field
              label={t("pool.categoryName")}
              fullWidth
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          ) : null}
        </FormDialog>
      ) : null}

      {/* Two fields, so a dialog and not a Sheet (DESIGN.md › layers). The
          category select only appears once a pool is chosen AND that pool has
          folders: an empty select is a question with no answers. */}
      {dialog === "pool" ? (
        <FormDialog
          title={t(ids.length === 1 ? "pool.move.title.one" : "pool.move.title", {
            n: ids.length,
          })}
          onClose={() => setDialog(null)}
          onSubmit={() => void moveToPool()}
          submitLabel={t("pool.move.action")}
          submitting={moving}
          canSubmit={targetPoolId !== ""}
        >
          {pools.isLoading ? (
            <Spinner className="py-4" />
          ) : targets.length === 0 ? (
            <p className="text-[13px] text-fg-muted">{t("pool.move.noTarget")}</p>
          ) : (
            <Select
              label={t("pool.move.pool")}
              value={targetPoolId}
              onChange={(e) => {
                setTargetPoolId(e.target.value);
                setTargetCategoryId("");
              }}
            >
              <option value="">{t("pool.move.choosePool")}</option>
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          {targetPoolId !== "" && (target.data?.categories.length ?? 0) > 0 ? (
            <Select
              label={t("question.meta.category")}
              value={targetCategoryId}
              onChange={(e) => setTargetCategoryId(e.target.value)}
            >
              <option value="">{t("pool.bulk.root")}</option>
              {categoryPaths(target.data!.categories).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          ) : null}
        </FormDialog>
      ) : null}
    </>
  );
}
