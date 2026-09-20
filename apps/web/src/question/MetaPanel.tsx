import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";

import type { CategoryNode, QuestionMeta, QuestionPatch } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Card, Field, SectionHeading, Segmented, Select, SettingRow, Switch } from "../ui";

/**
 * What a question IS, next to what it says: name, category, difficulty, tags
 * and the shuffle switch (mockup `01-editeur-qcm.html`, "Propriétés").
 *
 * These are metadata, not content: each one is a `PATCH /questions/:id` of
 * its own, applied when the control is left, and none of them touches the
 * draft the type's editor owns.
 */

function flatten(nodes: CategoryNode[], prefix = ""): { id: string; label: string }[] {
  return nodes.flatMap((node) => {
    const label = prefix ? `${prefix} / ${node.name}` : node.name;
    return [{ id: node.id, label }, ...flatten(node.children, label)];
  });
}

export function MetaPanel({
  meta,
  categories,
  poolName,
  disabled,
}: {
  meta: QuestionMeta;
  categories: CategoryNode[];
  poolName: string;
  disabled?: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(meta.internalName);
  const [tag, setTag] = useState("");

  const patch = useMutation({
    mutationFn: (body: QuestionPatch) =>
      api(`/app/api/questions/${meta.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["question", meta.id] });
      await qc.invalidateQueries({ queryKey: ["pool", meta.poolId] });
    },
    onError: (error) => toast(apiErrorMessage(error, t("question.meta.saveFailed")), "error"),
  });

  const addTag = () => {
    const value = tag.trim().replace(/^#/, "");
    if (!value || meta.tags.includes(value)) {
      setTag("");
      return;
    }
    setTag("");
    patch.mutate({ tags: [...meta.tags, value] });
  };

  return (
    <Card className="space-y-4 p-4">
      <SectionHeading title={t("question.meta")} />

      <Field
        label={t("question.meta.name")}
        fullWidth
        disabled={disabled}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const trimmed = name.trim();
          if (trimmed && trimmed !== meta.internalName) patch.mutate({ internalName: trimmed });
          else setName(meta.internalName);
        }}
      />

      <Select
        label={t("question.meta.category")}
        disabled={disabled}
        value={meta.categoryId ?? ""}
        onChange={(e) => patch.mutate({ categoryId: e.target.value === "" ? null : e.target.value })}
      >
        <option value="">{t("question.meta.noCategory")}</option>
        {flatten(categories).map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>

      <div className="space-y-1.5">
        <span className="text-[13px] font-medium">{t("question.meta.difficulty")}</span>
        <div>
          <Segmented
            name="difficulty"
            size="sm"
            disabled={disabled}
            value={String(meta.difficulty)}
            options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => patch.mutate({ difficulty: Number(v) })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-[13px] font-medium">{t("question.meta.tags")}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {meta.tags.length === 0 ? <span className="text-sm text-fg-faint">—</span> : null}
          {meta.tags.map((existing) => (
            <span
              key={existing}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-3 pl-2.5 pr-1 text-xs font-medium text-fg-muted"
            >
              #{existing}
              <button
                type="button"
                disabled={disabled}
                aria-label={t("question.meta.tagRemove", { name: existing })}
                onClick={() => patch.mutate({ tags: meta.tags.filter((x) => x !== existing) })}
                className="rounded-full p-0.5 text-fg-faint transition-colors hover:bg-line-strong hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Field
            label={t("question.meta.tagAdd")}
            size="sm"
            fullWidth
            disabled={disabled}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <button
            type="button"
            aria-label={t("question.meta.tagAdd")}
            disabled={disabled}
            onClick={addTag}
            className="mb-0.5 rounded-full p-1.5 text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      <SettingRow
        title={t("question.meta.shuffleable")}
        desc={t("question.meta.shuffleableHint")}
        className="border-t border-line pt-3"
      >
        <Switch
          label={t("question.meta.shuffleable")}
          disabled={disabled}
          checked={meta.shuffleable}
          onChange={(v) => patch.mutate({ shuffleable: v })}
        />
      </SettingRow>

      <div className="flex items-baseline justify-between border-t border-line pt-3 text-[13px]">
        <span className="text-fg-muted">{t("question.meta.pool")}</span>
        <span className="font-medium">{poolName}</span>
      </div>
    </Card>
  );
}
