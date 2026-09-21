import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { CategoryNode, QuestionMeta, QuestionPatch } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Card, Field, SectionHeading, Segmented, Select, SettingRow, Switch } from "../ui";
import { TagInput } from "./TagInput";

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

  const patch = useMutation({
    mutationFn: (body: QuestionPatch) =>
      api(`/app/api/questions/${meta.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["question", meta.id] });
      // Prefix match: this also refreshes `["pool", id, "tags"]`, the
      // vocabulary the tag field suggests from, which a new tag just joined.
      await qc.invalidateQueries({ queryKey: ["pool", meta.poolId] });
    },
    onError: (error) => toast(apiErrorMessage(error, t("question.meta.saveFailed")), "error"),
  });

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

      <TagInput
        poolId={meta.poolId}
        tags={meta.tags}
        {...(disabled ? { disabled } : {})}
        onChange={(tags) => patch.mutate({ tags })}
      />

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
