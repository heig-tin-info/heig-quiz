import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Library, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Pool, PoolSummary } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import type { Route } from "../router";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Menu,
  Modal,
  PageHeader,
  QueryError,
  Skeleton,
} from "../ui";

/**
 * The teacher's question pools.
 *
 * One primary action, "New pool"; a pool card carries its question count and
 * an overflow menu for the two things that are not "open it". A pool is
 * where questions live, so the card is a door, not a dashboard.
 */

function PoolFormModal({
  pool,
  onClose,
}: {
  /** Absent: create. Present: rename. */
  pool?: PoolSummary;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(pool?.name ?? "");
  const save = useMutation({
    mutationFn: () =>
      pool
        ? api<Pool>(`/app/api/pools/${pool.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: name.trim() }),
          })
        : api<Pool>("/app/api/pools", {
            method: "POST",
            body: JSON.stringify({ name: name.trim() }),
          }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["pools"] });
      onClose();
    },
  });
  return (
    <Modal
      title={pool ? t("pools.rename") : t("pools.new")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={name.trim() === ""}>
            {pool ? t("common.save") : t("pools.newAction")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label={t("pools.name")}
          fullWidth
          autoFocus
          placeholder={t("pools.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {save.isError ? (
          <p className="text-[13px] text-danger">
            {apiErrorMessage(save.error, t("pools.createFailed"))}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export function PoolsPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<PoolSummary | null>(null);

  const pools = useQuery<PoolSummary[]>({
    queryKey: ["pools"],
    queryFn: () => api("/app/api/pools"),
  });

  const remove = useMutation({
    mutationFn: (pool: PoolSummary) => api(`/app/api/pools/${pool.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pools"] }),
    onError: (error) => toast(apiErrorMessage(error, t("error.save")), "error"),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        help="pools"
        title={t("pools.title")}
        description={t("pools.subtitle")}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> {t("pools.new")}
          </Button>
        }
      />

      {pools.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : pools.isError ? (
        <QueryError
          title={t("pools.title")}
          error={pools.error}
          onRetry={() => void pools.refetch()}
          retrying={pools.isFetching}
          fallback={t("error.server")}
        />
      ) : (pools.data ?? []).length === 0 ? (
        <EmptyState
          icon={Library}
          title={t("pools.empty.title")}
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("pools.new")}
            </Button>
          }
        >
          {t("pools.empty.body")}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {pools.data!.map((pool) => (
            <Card key={pool.id} className="flex items-center gap-3 p-4">
              <button
                type="button"
                onClick={() => navigate({ view: "pool", id: pool.id })}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block text-sm font-bold">{pool.name}</span>
                <span className="block text-xs text-fg-muted">
                  {t(pool.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
                    n: pool.questionCount,
                  })}
                </span>
              </button>
              <Menu
                label={t("common.actions")}
                items={[
                  { label: t("pools.rename"), icon: Pencil, onSelect: () => setRenaming(pool) },
                  {
                    label: t("pools.delete"),
                    icon: Trash2,
                    danger: true,
                    separator: true,
                    onSelect: async () => {
                      const ok = await confirm({
                        title: t("pools.delete"),
                        message: t("pools.deleteConfirm", { name: pool.name }),
                        confirmLabel: t("common.delete"),
                        cancelLabel: t("common.cancel"),
                        danger: true,
                      });
                      if (ok) remove.mutate(pool);
                    },
                  },
                ]}
              />
            </Card>
          ))}
        </div>
      )}

      {creating ? <PoolFormModal onClose={() => setCreating(false)} /> : null}
      {renaming ? <PoolFormModal pool={renaming} onClose={() => setRenaming(null)} /> : null}
    </div>
  );
}
