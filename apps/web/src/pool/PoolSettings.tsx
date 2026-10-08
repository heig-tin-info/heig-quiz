/**
 * The pool page's Settings tab, in settings rows (DESIGN.md, "Settings row"),
 * the course's and the classroom's twin: what the pools list's card menu
 * held — the name, the icon, the sharing (F-POOL-05), leaving and deleting.
 *
 * Nothing here is accented: a settings tab has no primary. Delete and Leave
 * are `danger-quiet` buttons whose confirmations are the `danger` ones.
 *
 * The name, the icon, the sharing and the deletion are an owner's: anyone
 * else sees one line saying so, and the way out of a pool they hold a seat
 * on — no disabled buttons, as the pool's other read-only screens.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Library, LogOut, Trash2 } from "lucide-react";
import { useState } from "react";

import { PoolInUse, type PoolDetail } from "@quiz/contracts";

import { api, ApiError, useMe } from "../api";
import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { poolKey, poolsKey } from "../queryKeys";
import type { Route } from "../router";
import { Button, Card, SectionHeading, SettingRow, Tip } from "../ui";
import { PoolFormModal } from "./PoolFormModal";
import { PoolIcon } from "./PoolIcon";
import { PoolSharing } from "./PoolSharing";

/** The body of a `409 pool_in_use`, or null for any other failure. */
function poolInUse(error: unknown): PoolInUse | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = PoolInUse.safeParse(error.body);
  return parsed.success ? parsed.data : null;
}

/** What still holds the pool, by title, with the ones the caller cannot open counted. */
function poolInUseMessage(inUse: PoolInUse, t: TFunction): string {
  const titles = inUse.uses.map((u) => u.title).join(", ");
  const one = inUse.hidden === 1;
  if (titles === "") return t(one ? "pools.inUse.hidden.one" : "pools.inUse.hidden", { n: inUse.hidden });
  const names =
    inUse.hidden > 0
      ? t(one ? "pools.inUse.more.one" : "pools.inUse.more", { names: titles, n: inUse.hidden })
      : titles;
  return t("pools.inUse", { names });
}

export function PoolSettings({
  detail,
  navigate,
}: {
  detail: PoolDetail;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const me = useMe().data;
  const [edit, setEdit] = useState<"form" | "icon" | null>(null);
  const { pool } = detail;

  const owner = detail.role === "owner";
  /** The account the pool BELONGS to cannot leave it; a co-owner can. */
  const seat = me != null && pool.ownerId !== me.id;

  /** Out of a pool that is gone, or no longer the caller's: back to the shelf. */
  const away = async () => {
    qc.removeQueries({ queryKey: poolKey(pool.id) });
    await qc.invalidateQueries({ queryKey: poolsKey });
    navigate({ view: "pools" });
  };

  const remove = useMutation({
    mutationFn: () => api(`/app/api/pools/${pool.id}`, { method: "DELETE" }),
    onSuccess: away,
    // ADR-031: a pool an evaluation or a template still pins is refused, and
    // the refusal names them — translated here from its machine half.
    onError: (error) => {
      const inUse = poolInUse(error);
      if (inUse) toast(poolInUseMessage(inUse, t), "error");
      else toastError("error.save")(error);
    },
  });
  const leave = useMutation({
    mutationFn: () =>
      api(`/app/api/pools/${pool.id}/members/${me?.id ?? ""}`, { method: "DELETE" }),
    onSuccess: async () => {
      toast(t("pools.leaveDone", { name: pool.name }), "success");
      await away();
    },
    onError: toastError("error.save"),
  });

  const askLeave = async () => {
    const ok = await confirm({
      title: t("pools.leave"),
      message: t("pools.leaveConfirm", { name: pool.name }),
      confirmLabel: t("pools.leaveAction"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) leave.mutate();
  };
  const askDelete = async () => {
    const ok = await confirm({
      title: t("pools.delete"),
      message: t("pools.deleteConfirm", { name: pool.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) remove.mutate();
  };

  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <SectionHeading icon={Library} title={t("pools.settings.general")} />
        {owner ? (
          <Card className="divide-y divide-line px-5">
            <SettingRow title={t("pools.name")} desc={pool.name}>
              <Button variant="secondary" onClick={() => setEdit("form")}>
                {t("pools.settings.rename")}
              </Button>
            </SettingRow>
            <SettingRow title={t("pools.icon")} desc={t("pools.settings.iconDesc")}>
              {/* The tile IS the trigger, as in the form: the icon the pool
                  wears, one click from the shelf it comes off. */}
              <Tip label={t("pools.icon.change")}>
                <button
                  type="button"
                  onClick={() => setEdit("icon")}
                  aria-label={t("pools.icon.change")}
                  className="inline-flex size-10 items-center justify-center rounded-field border border-line-strong bg-surface text-fg-muted transition-colors hover:border-fg-faint hover:text-fg"
                >
                  <PoolIcon icon={pool.icon} color={pool.color} className="size-5" />
                </button>
              </Tip>
            </SettingRow>
          </Card>
        ) : (
          <p className="text-[13px] text-fg-muted">{t("pools.settings.ownerOnly")}</p>
        )}
      </section>

      {owner ? <PoolSharing pool={pool} /> : null}

      {seat || owner ? (
        <section className="space-y-3">
          <SectionHeading
            title={t(
              seat && owner ? "pools.settings.lifecycle" : owner ? "common.delete" : "pools.leaveAction",
            )}
          />
          <Card className="divide-y divide-line px-5">
            {seat ? (
              <SettingRow title={t("pools.leave")} desc={t("pools.settings.leaveDesc")}>
                <Button variant="danger-quiet" loading={leave.isPending} onClick={() => void askLeave()}>
                  <LogOut /> {t("pools.leaveAction")}
                </Button>
              </SettingRow>
            ) : null}
            {owner ? (
              <SettingRow title={t("pools.delete")} desc={t("pools.settings.deleteDesc")}>
                <Button variant="danger-quiet" loading={remove.isPending} onClick={() => void askDelete()}>
                  <Trash2 /> {t("pools.delete")}
                </Button>
              </SettingRow>
            ) : null}
          </Card>
        </section>
      ) : null}

      {edit ? <PoolFormModal pool={pool} startAt={edit} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}
