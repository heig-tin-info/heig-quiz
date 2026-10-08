import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Pool, PoolColor } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { poolKey, poolsKey } from "../queryKeys";
import { Field, FormDialog, FormError } from "../ui";
import { IconField } from "./IconField";
import { PoolIcon } from "./PoolIcon";
import { PoolIconPicker } from "./PoolIconPicker";

/**
 * Creating a pool, and editing the two things that make it recognizable: its
 * name and its icon.
 *
 * The icon picker is the SAME dialog, one step further in — the tile in the
 * form opens it, picking one comes back. Not a second window over the first:
 * choosing an icon is part of naming a pool, not a decision of its own.
 */
export function PoolFormModal({
  pool,
  startAt = "form",
  onClose,
}: {
  /** Absent: create. Present: edit. */
  pool?: Pool;
  /** "icon" opens straight on the picker (the Settings tab's icon tile). */
  startAt?: "form" | "icon";
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(pool?.name ?? "");
  const [icon, setIcon] = useState<string | null>(pool?.icon ?? null);
  const [color, setColor] = useState<PoolColor | null>(pool?.color ?? null);
  const [step, setStep] = useState<"form" | "icon">(startAt);

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({ name: name.trim(), icon, color });
      return pool
        ? api<Pool>(`/app/api/pools/${pool.id}`, { method: "PATCH", body })
        : api<Pool>("/app/api/pools", { method: "POST", body });
    },
    onSuccess: async () => {
      // The prefix of every list of pools, and the pool's own page.
      await Promise.all([
        qc.invalidateQueries({ queryKey: poolsKey }),
        ...(pool ? [qc.invalidateQueries({ queryKey: poolKey(pool.id) })] : []),
      ]);
      onClose();
    },
  });

  if (step === "icon") {
    return (
      <PoolIconPicker
        value={icon}
        color={color}
        onColor={setColor}
        onPick={(picked) => {
          setIcon(picked);
          setStep("form");
        }}
        // Opened straight on the picker: there is no form step to go back to
        // that the teacher asked for, so the way out is out — unless a colour
        // was picked on the way, which the form then holds, ready to save.
        onClose={() =>
          startAt === "icon" && pool && color === pool.color ? onClose() : setStep("form")
        }
      />
    );
  }

  return (
    <FormDialog
      title={pool ? t("pools.rename") : t("pools.new")}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitLabel={pool ? t("common.save") : t("pools.newAction")}
      submitting={save.isPending}
      canSubmit={name.trim() !== ""}
      dense
      error={<FormError error={save.error} fallback={t("pools.createFailed")} />}
    >
      <IconField onPick={() => setStep("icon")} icon={<PoolIcon icon={icon} color={color} className="size-4.5" />}>
        <Field
          label={t("pools.name")}
          className="min-w-0"
          width="min-w-0 flex-1"
          autoFocus
          placeholder={t("pools.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </IconField>
    </FormDialog>
  );
}
