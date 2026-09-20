import { useQueryClient } from "@tanstack/react-query";
import { FolderInput, Tag, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { CategoryNode, QuestionRow } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Button, Field, IconButton, Modal, Select, Z } from "../ui";

/**
 * What to do with the ticked questions (mockup `08-pool.html`): a floating
 * bar that only exists while a selection does. It is the one place in the
 * screen allowed a shadow — it genuinely sits above the table.
 *
 * The three operations are sequential calls to the ordinary routes
 * (`PATCH /questions/:id`, `DELETE /questions/:id`): the API has no bulk
 * endpoint, and a teacher moving twenty questions is not a reason to invent
 * one. What the bar owes the reader is a single report at the end, which is
 * what `runAll` produces.
 */

/** Flattens the tree into "Parent / Child" labels for the move select. */
function flatten(nodes: CategoryNode[], prefix = ""): { id: string; label: string }[] {
  return nodes.flatMap((node) => {
    const label = prefix ? `${prefix} / ${node.name}` : node.name;
    return [{ id: node.id, label }, ...flatten(node.children, label)];
  });
}

export function BulkBar({
  ids,
  rows,
  categories,
  onClear,
}: {
  ids: string[];
  /** The loaded rows, so "add a tag" can keep the tags a question already has. */
  rows: QuestionRow[];
  categories: CategoryNode[];
  onClear: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<"tag" | "move" | null>(null);
  const [tag, setTag] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);

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
    await qc.invalidateQueries({ queryKey: ["pool"] });
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

  const move = () =>
    void runAll((id) =>
      api(`/app/api/questions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId: categoryId === "" ? null : categoryId }),
      }),
    );

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
        className={`fixed inset-x-0 bottom-4 mx-auto flex w-[min(40rem,calc(100%-2rem))] flex-wrap items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 shadow-overlay ${Z.popover}`}
      >
        <span className="text-[13px] font-medium tabular-nums">
          {t("pool.bulk.selected", { n: ids.length })}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setDialog("tag")}>
          <Tag /> {t("pool.bulk.tag")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog("move")}>
          <FolderInput /> {t("pool.bulk.move")}
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
        <Modal
          title={t("pool.bulk.tagTitle", { n: ids.length })}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={addTag} loading={busy} disabled={tag.trim() === ""}>
                {t("pool.bulk.tag")}
              </Button>
            </>
          }
        >
          <Field
            label={t("question.meta.tagAdd")}
            fullWidth
            autoFocus
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
        </Modal>
      ) : null}

      {dialog === "move" ? (
        <Modal
          title={t("pool.bulk.moveTitle", { n: ids.length })}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={move} loading={busy}>
                {t("pool.bulk.move")}
              </Button>
            </>
          }
        >
          <Select
            label={t("question.meta.category")}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">{t("pool.bulk.root")}</option>
            {flatten(categories).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Modal>
      ) : null}
    </>
  );
}
