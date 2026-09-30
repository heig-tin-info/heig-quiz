import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Monitor, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";

import type { KioskAttestation, KioskDevice, KioskDevicePatch } from "@quiz/contracts";

import { api, apiErrorMessage, usePublicConfig } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
import { useToast } from "./notify";
import { adminKioskKey } from "./queryKeys";
import {
  Actions,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  inputClass,
  inputSize,
  QueryError,
  RelativeTime,
  SectionHeading,
  Skeleton,
  T,
  type Tone,
} from "./ui";

const STATUS_TONE: Record<KioskDevice["status"], Tone> = {
  unnamed: "amber",
  active: "green",
  retired: "zinc",
};

const ATTESTATION_TONE: Record<KioskAttestation, Tone> = {
  ok: "green",
  unavailable: "amber",
  refused: "red",
};

/** The label field's bounds, those of `KioskDevicePatch`. */
const LABEL_MAX = 80;

/**
 * The kiosk stations (ADR-051 §5): the school's Chromebooks that attested
 * themselves, and the admin's one decision about each — name it (it becomes
 * a station students can pair with), or retire it.
 *
 * A station that attested for the first time comes first, with its name
 * field open: naming it is the section's primary action. Shown only where
 * the platform has the kiosk path (`KIOSK_ATTESTATION` not `off`).
 */
export function KioskSection() {
  const t = useT();
  const kiosk = usePublicConfig().data?.kiosk;
  const devices = useQuery<KioskDevice[]>({
    queryKey: adminKioskKey,
    queryFn: () => api("/app/api/admin/kiosk-devices"),
    enabled: kiosk != null,
  });
  if (kiosk == null) return null;

  const rows = devices.data ?? [];
  const waiting = rows.filter((d) => d.status === "unnamed").length;

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Monitor}
        title={t("admin.kiosk")}
        count={rows.length}
        description={t("admin.kiosk.hint")}
      />
      {devices.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : devices.isError ? (
        <QueryError
          title={t("admin.kiosk")}
          error={devices.error}
          onRetry={() => void devices.refetch()}
          retrying={devices.isFetching}
          fallback={t("error.server")}
        />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={Monitor} title={t("admin.kiosk.empty.title")}>
            {t("admin.kiosk.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <>
          {waiting > 0 ? (
            <p className="text-sm text-fg-muted">{t("admin.kiosk.waiting", { n: waiting })}</p>
          ) : null}
          <Card className={cx("overflow-x-auto", T.container)}>
            <table className={T.table}>
              <thead className={T.head}>
                <tr>
                  <th className={T.th}>{t("admin.kiosk.col.station")}</th>
                  <th className={T.th}>{t("admin.kiosk.col.status")}</th>
                  <th className={cx(T.th, T.colHigh)}>{t("admin.kiosk.col.checked")}</th>
                  <th className={cx(T.th, T.colMid)}>{t("admin.kiosk.col.attested")}</th>
                  <th className={T.th}>
                    <span className="sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <StationRow key={d.id} device={d} />
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </section>
  );
}

function StationRow({ device: d }: { device: KioskDevice }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  // An unnamed station opens with its name field: naming it is why the admin is here.
  const [editing, setEditing] = useState(d.status === "unnamed");

  const save = useMutation({
    mutationFn: (patch: KioskDevicePatch) =>
      api<KioskDevice>(`/app/api/admin/kiosk-devices/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: (next) => {
      setEditing(next.status === "unnamed");
      void qc.invalidateQueries({ queryKey: adminKioskKey });
    },
    onError: (err) => toast(apiErrorMessage(err, t("error.save")), "error"),
  });

  const retire = async () => {
    if (
      await confirm({
        title: t("admin.kiosk.retireConfirm", { label: d.label ?? t("admin.kiosk.unnamed") }),
        message: t("admin.kiosk.retireConfirm.body"),
        confirmLabel: t("admin.kiosk.retire"),
        cancelLabel: t("common.cancel"),
        danger: true,
      })
    ) {
      save.mutate({ status: "retired" });
    }
  };

  return (
    <tr className={cx(T.row, T.rowHover)}>
      <td className={T.td}>
        {editing ? (
          <NameForm
            initial={d.label ?? ""}
            primary={d.status === "unnamed"}
            saving={save.isPending}
            onSave={(label) => save.mutate({ label })}
            onCancel={d.status === "unnamed" ? null : () => setEditing(false)}
          />
        ) : (
          <span className="font-semibold">{d.label}</span>
        )}
        {/* The serial printed on the machine: which Chromebook this row is. */}
        <div className="mt-0.5 font-mono text-xs text-fg-muted">{d.googleDeviceId}</div>
      </td>
      <td className={`${T.td} whitespace-nowrap`}>
        <Badge tone={STATUS_TONE[d.status]}>{t(`admin.kiosk.status.${d.status}`)}</Badge>
      </td>
      <td className={cx(T.td, T.colHigh, "whitespace-nowrap")}>
        {d.attestation && d.checkedAt ? (
          <span className="inline-flex items-center gap-2">
            <Badge tone={ATTESTATION_TONE[d.attestation]}>
              {t(`admin.kiosk.attestation.${d.attestation}`)}
            </Badge>
            <span className="text-fg-muted">
              <RelativeTime iso={d.checkedAt} />
            </span>
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className={cx(T.td, T.colMid, "whitespace-nowrap text-fg-muted")}>
        {d.attestedAt ? <RelativeTime iso={d.attestedAt} /> : "—"}
      </td>
      <td className={cx(T.td, T.stickyEnd, "text-right")}>
        {editing ? null : (
          <Actions
            label={d.label ?? undefined}
            items={[
              { label: t("admin.kiosk.rename"), icon: Pencil, onSelect: () => setEditing(true) },
              d.status === "retired"
                ? {
                    label: t("admin.kiosk.reactivate"),
                    icon: RotateCcw,
                    onSelect: () => save.mutate({ status: "active" }),
                  }
                : { label: t("admin.kiosk.retire"), icon: Archive, danger: true, onSelect: () => void retire() },
            ]}
          />
        )}
      </td>
    </tr>
  );
}

/**
 * The name of a station, typed in its row. `primary` for a station waiting
 * for its first name (the section's one call to action); a rename is a
 * secondary edit that can be cancelled.
 */
function NameForm({
  initial,
  primary,
  saving,
  onSave,
  onCancel,
}: {
  initial: string;
  primary: boolean;
  saving: boolean;
  onSave: (label: string) => void;
  onCancel: (() => void) | null;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const label = draft.trim();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (label !== "") onSave(label);
      }}
    >
      <input
        className={cx(inputClass, inputSize.sm, "w-36 @2xl:w-56")}
        aria-label={t("admin.kiosk.name")}
        placeholder={t("admin.kiosk.namePlaceholder")}
        maxLength={LABEL_MAX}
        value={draft}
        autoFocus={!primary}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onCancel) onCancel();
        }}
      />
      <Button
        type="submit"
        size="sm"
        variant={primary ? "primary" : "secondary"}
        loading={saving}
        disabled={label === "" || label === initial}
      >
        {primary ? t("admin.kiosk.nameAction") : t("common.save")}
      </Button>
      {onCancel ? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      ) : null}
    </form>
  );
}
