import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Monitor, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";

import { KIOSK_LABEL_MAX, KioskDevicePatch, type KioskDevice } from "@quiz/contracts";
import type { KioskAttestation } from "@quiz/domain";

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
  QueryError,
  RelativeTime,
  SectionHeading,
  Skeleton,
  T,
  TableHead,
  type Tone,
  TextInput,
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
        <QueryError title={t("admin.kiosk")} query={devices} />
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
              <TableHead
                columns={[
                  { key: "station", label: t("admin.kiosk.col.station") },
                  { key: "status", label: t("admin.kiosk.col.status") },
                  { key: "checked", label: t("admin.kiosk.col.checked"), className: T.colHigh },
                  { key: "attested", label: t("admin.kiosk.col.attested"), className: T.colMid },
                  { key: "actions", label: t("common.actions"), srOnly: true },
                ]}
              />
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
  /**
   * What the name field is open for: an unnamed station opens with it (naming
   * it is why the admin is here); `reactivate` is a station retired before it
   * was ever named, which goes back into service only with a name.
   */
  const [editing, setEditing] = useState<"name" | "reactivate" | null>(
    d.status === "unnamed" ? "name" : null,
  );

  const save = useMutation({
    // The schema the server validates with builds the body (invariant 7).
    mutationFn: (patch: KioskDevicePatch) =>
      api<KioskDevice>(`/app/api/admin/kiosk-devices/${d.id}`, {
        method: "PATCH",
        body: JSON.stringify(KioskDevicePatch.parse(patch)),
      }),
    onSuccess: (next) => {
      setEditing(next.status === "unnamed" ? "name" : null);
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
            primary={d.status === "unnamed" || editing === "reactivate"}
            submitLabel={
              editing === "reactivate"
                ? t("admin.kiosk.reactivate")
                : d.status === "unnamed"
                  ? t("admin.kiosk.nameAction")
                  : t("common.save")
            }
            saving={save.isPending}
            onSave={(label) =>
              save.mutate(editing === "reactivate" ? { label, status: "active" } : { label })
            }
            onCancel={d.status === "unnamed" ? null : () => setEditing(null)}
          />
        ) : d.label ? (
          <span className="font-semibold">{d.label}</span>
        ) : null}
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
              { label: t("admin.kiosk.rename"), icon: Pencil, onSelect: () => setEditing("name") },
              d.status === "retired"
                ? {
                    label: t("admin.kiosk.reactivate"),
                    icon: RotateCcw,
                    // Never active without a name: an unnamed one asks for it first.
                    onSelect: () =>
                      d.label === null ? setEditing("reactivate") : save.mutate({ status: "active" }),
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
 * for its first name (the section's one call to action) and for a nameless
 * station going back into service; a rename is a secondary edit that can be
 * cancelled.
 */
function NameForm({
  initial,
  primary,
  submitLabel,
  saving,
  onSave,
  onCancel,
}: {
  initial: string;
  primary: boolean;
  submitLabel: string;
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
      <TextInput
        size="sm"
        className="w-36 @2xl:w-56"
        aria-label={t("admin.kiosk.name")}
        placeholder={t("admin.kiosk.namePlaceholder")}
        maxLength={KIOSK_LABEL_MAX}
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
        {submitLabel}
      </Button>
      {onCancel ? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      ) : null}
    </form>
  );
}
