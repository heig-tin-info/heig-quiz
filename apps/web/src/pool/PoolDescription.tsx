import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { PoolDescriptionProposal, type Pool, type PoolPatch } from "@quiz/contracts";
import { POOL_DESCRIPTION_MAX } from "@quiz/domain";

import { api, refusedWith } from "../api";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { poolKey, poolsKey } from "../queryKeys";
import { Button, Textarea } from "../ui";

/**
 * The pool's description, in its Settings tab (owner only): at most 280
 * characters, shown on the pool's card. "Suggest" asks the model for a
 * proposal and shows it BESIDE the text; nothing is written until the owner
 * presses "Use this description" — and a text the owner wrote is never
 * replaced by a proposal (the button is not offered over it; the API refuses
 * it too).
 */
export function PoolDescription({ pool }: { pool: Pool }) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const toast = useToast();
  const [draft, setDraft] = useState(pool.description);
  const [proposal, setProposal] = useState<string | null>(null);
  useEffect(() => setDraft(pool.description), [pool.description]);

  const saved = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: poolKey(pool.id) }),
      qc.invalidateQueries({ queryKey: poolsKey }),
    ]);
  };
  const save = useMutation({
    mutationFn: (body: PoolPatch) =>
      api(`/app/api/pools/${pool.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setProposal(null);
      await saved();
    },
    onError: toastError("error.save"),
  });
  const propose = useMutation({
    mutationFn: async () =>
      PoolDescriptionProposal.parse(
        await api(`/app/api/pools/${pool.id}/description/propose`, { method: "POST", body: "{}" }),
      ).description,
    onSuccess: setProposal,
    onError: (error) =>
      refusedWith(error, "pool_empty")
        ? toast(t("pools.description.empty"), "error")
        : toastError("pools.description.failed")(error),
  });

  // A text the owner wrote is theirs: the model only ever fills a blank or replaces its own words.
  const canSuggest = pool.description === "" || pool.descriptionSource === "ai";
  const unchanged = draft.trim() === pool.description;

  return (
    <div className="space-y-3 py-4">
      <Textarea
        label={t("pools.description")}
        value={draft}
        maxLength={POOL_DESCRIPTION_MAX}
        rows={3}
        placeholder={t("pools.description.placeholder")}
        onChange={(e) => setDraft(e.target.value)}
      />
      <p className="text-xs text-fg-faint">
        {t("pools.description.help", { n: draft.length, max: POOL_DESCRIPTION_MAX })}
        {pool.descriptionSource === "ai" && pool.description !== "" ? ` ${t("pools.description.byAi")}` : ""}
      </p>
      {proposal !== null ? (
        <div className="space-y-2 rounded-field border border-line bg-surface-2/50 p-3">
          <p className="text-xs font-medium text-fg-muted">{t("pools.description.proposal")}</p>
          <p className="text-sm">{proposal}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={save.isPending}
              onClick={() => save.mutate({ description: proposal, descriptionFromAi: true })}
            >
              {t("pools.description.use")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setProposal(null)}>
              {t("pools.description.dismiss")}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={save.isPending && proposal === null}
          disabled={unchanged}
          onClick={() => save.mutate({ description: draft.trim() })}
        >
          {t("common.save")}
        </Button>
        {canSuggest ? (
          <Button variant="ghost" loading={propose.isPending} onClick={() => propose.mutate()}>
            <Sparkles /> {t("pools.description.suggest")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
