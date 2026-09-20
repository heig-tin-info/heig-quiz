import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BellRing, GraduationCap, School, ShieldCheck, SlidersHorizontal } from "lucide-react";

import { AvatarEditor } from "./AvatarEditor";
import { api, apiErrorMessage } from "./api";
import { useI18n, LOCALES } from "./i18n";
import { DATE_FORMATS, type DateFormat, type Me, type NoticeKind } from "@quiz/contracts";

import { NOTICE_KINDS, notifyPrefs, setNotifyPref } from "./notify";
import { setThemeChoice, useThemeChoice } from "./theme";
import {
  Avatar,
  Badge,
  Card,
  formatDateTimeAs,
  isoDateTime,
  PageHeader,
  SectionHeading,
  Segmented,
  Select,
  setDateFormat,
  SettingRow,
  Switch,
  Tip,
} from "./ui";

/** Language, appearance and date format: three rows, one card. */
function PreferencesCard({ me }: { me: Me }) {
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  // Shared store: the account menu toggle reads the same value.
  const theme = useThemeChoice();
  const saveDate = useMutation({
    mutationFn: (dateFormat: DateFormat) =>
      api("/app/api/me", { method: "PATCH", body: JSON.stringify({ dateFormat }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const current = me.dateFormat ?? "iso";
  const sample = new Date().toISOString();
  return (
    <section className="space-y-3">
      <SectionHeading icon={SlidersHorizontal} title={t("settings.preferences")} />
      <Card className="divide-y divide-line px-5">
        <SettingRow title={t("settings.language")} desc={t("settings.languageHint")}>
          <Segmented
            name="locale"
            value={locale}
            onChange={setLocale}
            options={LOCALES.map((l) => ({ value: l.code, label: l.label }))}
          />
        </SettingRow>
        <SettingRow title={t("settings.appearance")} desc={t("settings.appearanceHint")}>
          <Segmented
            name="theme"
            value={theme}
            onChange={setThemeChoice}
            options={[
              { value: "light", label: t("settings.theme.light") },
              { value: "dark", label: t("settings.theme.dark") },
              { value: "system", label: t("settings.theme.system") },
            ]}
          />
        </SettingRow>
        <SettingRow title={t("settings.dateFormat")} desc={t("settings.dateFormatHint")}>
          <Select
            value={current}
            disabled={saveDate.isPending}
            onChange={(e) => {
              const f = e.target.value as DateFormat;
              setDateFormat(f);
              saveDate.mutate(f);
            }}
            width="w-52"
            className="tabular-nums"
            aria-label={t("settings.dateFormat")}
          >
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {formatDateTimeAs(sample, f)}
              </option>
            ))}
          </Select>
        </SettingRow>
      </Card>
      {saveDate.isError ? (
        <p className="text-[13px] text-danger">{apiErrorMessage(saveDate.error, t("error.save"))}</p>
      ) : null}
    </section>
  );
}

/** Per-kind toggles for the real-time toasts; stored in this browser. */
function NotificationsCard() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState(notifyPrefs);
  const toggle = (kind: NoticeKind, next: boolean) => {
    setNotifyPref(kind, next);
    setPrefs({ ...prefs, [kind]: next });
  };
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={BellRing}
        title={t("settings.notifications")}
        description={t("settings.notificationsBrowser")}
      />
      <Card className="divide-y divide-line px-5">
        {NOTICE_KINDS.map(({ kind }) => (
          <SettingRow key={kind} title={t(`notify.${kind}` as Parameters<typeof t>[0])} className="py-2.5">
            <Switch
              checked={prefs[kind]}
              onChange={(v) => toggle(kind, v)}
              label={t(`notify.${kind}` as Parameters<typeof t>[0])}
            />
          </SettingRow>
        ))}
      </Card>
    </section>
  );
}

export function SettingsPage({ me }: { me: Me }) {
  const { t } = useI18n();
  const [editingAvatar, setEditingAvatar] = useState(false);

  const roleIcon =
    me.role === "admin" ? ShieldCheck : me.role === "teacher" ? School : GraduationCap;

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader title={t("settings.title")} />

      <section className="space-y-3">
        <SectionHeading title={t("settings.profile")} />
        <Card className="divide-y divide-line">
          <div className="flex flex-wrap items-center gap-5 p-5">
            <Tip label={t("settings.changePicture")}>
              <button
                type="button"
                onClick={() => setEditingAvatar(true)}
                aria-label={t("settings.changePicture")}
                className="group relative rounded-full"
              >
                <Avatar me={me} className="size-16 text-xl" />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-fg/50 text-xs font-medium text-canvas opacity-0 transition-opacity group-hover:opacity-100">
                  {t("settings.changePicture")}
                </span>
              </button>
            </Tip>
            <div className="min-w-0 flex-1">
              <p className="text-[17px] font-bold tracking-tight">
                {me.givenName} {me.familyName}
              </p>
              <p className="text-sm text-fg-muted">{me.email}</p>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-fg-faint">
                <Badge tone="zinc" icon={roleIcon}>
                  {t(`settings.role.${me.role}` as Parameters<typeof t>[0])}
                </Badge>
                {me.lastLoginAt ? <span>{t("settings.lastSignIn", { date: isoDateTime(me.lastLoginAt) })}</span> : null}
              </p>
            </div>
          </div>
        </Card>
      </section>

      <PreferencesCard me={me} />
      <NotificationsCard />

      {editingAvatar ? (
        <AvatarEditor
          hasAvatar={me.hasUploadedAvatar}
          onClose={() => setEditingAvatar(false)}
        />
      ) : null}
    </div>
  );
}
