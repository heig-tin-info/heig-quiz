import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronRight, GraduationCap, School, ShieldCheck, SlidersHorizontal } from "lucide-react";

import { ApiTokensCard, ConnectionsCard } from "./ApiTokensCard";
import { AvatarEditor } from "./AvatarEditor";
import { api, useMePatch } from "./api";
import { GithubAccountCard } from "./github/AccountCard";
import { ViewModeToggle } from "./Header";
import { useI18n, useT, LOCALES } from "./i18n";
import {
  DATE_FORMATS,
  McqPolicy,
  type DateFormat,
  type Me,
} from "@quiz/contracts";

import { NotificationSettingsSection } from "./notifications/NotificationSettings";
import { useToast } from "./notify";
import { meKey } from "./queryKeys";
import type { Route } from "./router";
import { SuperPowersSection } from "./SuperPowers";
import { setThemeChoice, useThemeChoice } from "./theme";
import {
  Avatar,
  Badge,
  Button,
  Card,
  formatDateTimeAs,
  FormError,
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

/**
 * How a multiple-answer MCQ is scored, by default, in the evaluations this
 * teacher creates (docs/04 §4.4).
 *
 * It is a SEED and says so: an evaluation copies it once, at creation, and
 * then owns its own. Changing it here never moves a quiz that exists, which
 * is the one thing a teacher needs to be sure of before touching it. A
 * student creates no evaluation, so the row is not on their settings page.
 */
function McqPolicyRow({ me }: { me: Me }) {
  const { t } = useI18n();
  const save = useMePatch();
  // A teacher who never opened this page has no preference: the default is
  // the one nobody has to be told about.
  const current = me.mcqPolicy ?? "all_or_nothing";
  return (
    <SettingRow
      title={t("mcq.policy.title")}
      desc={t(`mcq.policy.desc.${current}` as Parameters<typeof t>[0])}
      help="mcq-policies"
    >
      <Select
        value={current}
        disabled={save.isPending}
        onChange={(e) => save.mutate({ mcqPolicy: e.target.value as McqPolicy })}
        width="w-52"
        aria-label={t("mcq.policy.title")}
      >
        {McqPolicy.options.map((policy) => (
          <option key={policy} value={policy}>
            {t(`mcq.policy.${policy}` as Parameters<typeof t>[0])}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

/**
 * The coach marks (`coach/`): on or off, and "show them again", which forgets
 * every bubble read so far — the screen on display plays its tour at once.
 */
function CoachRow({ me }: { me: Me }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const save = useMePatch();
  const on = me.coach?.enabled !== false;
  const replay = useMutation({
    mutationFn: () =>
      api<{ seen: string[] }>("/app/api/me/coach", {
        method: "POST",
        body: JSON.stringify({ reset: true }),
      }),
    onSuccess: () => {
      toast(t("settings.coachReplayed"), "success");
      void qc.invalidateQueries({ queryKey: meKey });
    },
  });
  return (
    <SettingRow title={t("settings.coach")} desc={t("settings.coachHint")}>
      <div className="flex items-center gap-3">
        {on ? (
          <Button variant="secondary" size="sm" loading={replay.isPending} onClick={() => replay.mutate()}>
            {t("settings.coachReplay")}
          </Button>
        ) : null}
        <Switch
          checked={on}
          disabled={save.isPending}
          onChange={(next) => save.mutate({ coachEnabled: next })}
          label={t("settings.coach")}
        />
      </div>
    </SettingRow>
  );
}

/** The calculator an evaluation provides, in reverse Polish notation (ADR-069). */
function RpnCalculatorRow({ me }: { me: Me }) {
  const t = useT();
  const save = useMePatch();
  return (
    <SettingRow title={t("settings.rpnCalculator")} desc={t("settings.rpnCalculatorHint")}>
      <Switch
        checked={me.rpnCalculator === true}
        disabled={save.isPending}
        onChange={(next) => save.mutate({ rpnCalculator: next })}
        label={t("settings.rpnCalculator")}
      />
    </SettingRow>
  );
}

/** Language, appearance, date format — and, for a teacher, MCQ scoring. */
function PreferencesCard({ me }: { me: Me }) {
  const { t, choice, setLocale } = useI18n();
  // Shared store: the account menu toggle reads the same value.
  const theme = useThemeChoice();
  const saveDate = useMePatch();
  const current = me.dateFormat ?? "iso";
  const sample = new Date().toISOString();
  return (
    <section className="space-y-3">
      <SectionHeading icon={SlidersHorizontal} title={t("settings.preferences")} />
      <Card className="divide-y divide-line px-5">
        <SettingRow title={t("settings.language")} desc={t("settings.languageHint")}>
          <Segmented
            name="locale"
            value={choice}
            onChange={setLocale}
            options={[
              { value: "browser", label: t("settings.language.browser") },
              ...LOCALES.map((l) => ({ value: l.code, label: l.label })),
            ]}
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
              saveDate.mutate({ dateFormat: f });
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
        {me.role === "student" ? null : <McqPolicyRow me={me} />}
        <RpnCalculatorRow me={me} />
        <CoachRow me={me} />
      </Card>
      <FormError error={saveDate.error} fallback={t("error.save")} />
    </section>
  );
}

/**
 * What the phone's bottom bar puts under Profile (#449), above everything
 * else and under `lg` only, where the sidebar that holds them is gone:
 * Administration for an admin in the teacher UI, and the student-view
 * switch for whoever has one. Nothing when neither applies.
 */
function PhoneRows({
  admin,
  studentView,
  onToggleStudentView,
}: {
  admin: ((r: Route) => void) | null;
  studentView: boolean;
  onToggleStudentView?: () => void;
}) {
  const t = useT();
  if (!admin && !onToggleStudentView) return null;
  return (
    <Card className="divide-y divide-line overflow-hidden lg:hidden">
      {admin ? (
        <button
          type="button"
          onClick={() => admin({ view: "admin" })}
          className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2"
        >
          <ShieldCheck aria-hidden className="size-5 shrink-0 text-fg-faint" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("nav.admin")}</span>
            <span className="mt-0.5 block text-[13px] text-fg-muted">{t("settings.adminHint")}</span>
          </span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-faint" />
        </button>
      ) : null}
      {onToggleStudentView ? (
        <SettingRow title={t("view.label")} desc={t("settings.viewHint")} className="px-5">
          <ViewModeToggle studentView={studentView} onToggle={onToggleStudentView} />
        </SettingRow>
      ) : null}
    </Card>
  );
}

export function SettingsPage({
  me,
  navigate,
  teacherUi = false,
  studentView = false,
  onToggleStudentView,
}: {
  me: Me;
  /** Where the Administration row leads; without it, the row is not drawn. */
  navigate?: (r: Route) => void;
  /** The teacher UI is on: an admin's Administration row shows on a phone. */
  teacherUi?: boolean;
  studentView?: boolean;
  /** Defined for a teacher and an admin only, as the frame's switch. */
  onToggleStudentView?: () => void;
}) {
  const { t } = useI18n();
  const [editingAvatar, setEditingAvatar] = useState(false);

  const roleIcon =
    me.role === "admin" ? ShieldCheck : me.role === "teacher" ? School : GraduationCap;

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader title={t("settings.title")} />
      <PhoneRows
        admin={me.role === "admin" && teacherUi ? (navigate ?? null) : null}
        studentView={studentView}
        onToggleStudentView={onToggleStudentView}
      />

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
      {/* ADR-054: the server says whether this session may hold them. */}
      {me.session?.superPowersAvailable ? <SuperPowersSection me={me} /> : null}
      <NotificationSettingsSection />
      {/* F-GH-05: only when relevant, the card decides. */}
      <GithubAccountCard />
      {me.role === "student" ? null : (
        <>
          <ConnectionsCard />
          <ApiTokensCard />
        </>
      )}

      {editingAvatar ? (
        <AvatarEditor
          hasAvatar={me.hasUploadedAvatar}
          onClose={() => setEditingAvatar(false)}
        />
      ) : null}
    </div>
  );
}
