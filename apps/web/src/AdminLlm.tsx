import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, CheckCircle2, KeyRound, Sparkles, Trash2, XCircle } from "lucide-react";
import { useState } from "react";

import type { LlmErrorCode, LlmSettings, LlmSettingsPatch, LlmTestResult, LlmUsage } from "@quiz/contracts";
import { LLM_MODELS, type LlmModelId } from "@quiz/domain";

import { api, apiErrorMessage } from "./api";
import { useConfirm } from "./confirm";
import { formatDecimal, useI18n, useT, type Dict, type Locale } from "./i18n";
import { adminLlmKey, adminLlmUsageKey } from "./queryKeys";
import {
  Alert,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorText,
  Field,
  QueryError,
  SectionHeading,
  Select,
  Skeleton,
  Stat,
  T,
  TableHead,
} from "./ui";

const usd = (value: number, locale: Locale, digits = 2) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(value);

/** Every error of the gateway's vocabulary, worded in both languages. */
const errorLabel = (code: LlmErrorCode) => `admin.llm.error.${code}` as const satisfies keyof Dict;

/**
 * The LLM gateway (ADR-058): the institutional key, the model, the daily
 * cap, the connection test, and the month's usage per person. The tab's one
 * primary action is "Save"; the test is secondary.
 */
export function LlmSection() {
  const t = useT();
  const settings = useQuery<LlmSettings>({ queryKey: adminLlmKey, queryFn: () => api("/app/api/admin/llm") });

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionHeading icon={Sparkles} title={t("admin.llm.title")} description={t("admin.llm.hint")} />
        {settings.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : settings.isError ? (
          <QueryError title={t("admin.llm.title")} query={settings} />
        ) : settings.data ? (
          <SettingsForm settings={settings.data} />
        ) : null}
      </section>
      <UsageSection settings={settings.data ?? null} />
    </div>
  );
}

function SettingsForm({ settings }: { settings: LlmSettings }) {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<LlmModelId>(settings.model);
  const [cap, setCap] = useState(String(settings.dailyCapUsd));

  const save = useMutation({
    mutationFn: (patch: LlmSettingsPatch) =>
      api<LlmSettings>("/app/api/admin/llm", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (next) => {
      qc.setQueryData(adminLlmKey, next);
      setApiKey("");
      test.reset();
    },
  });
  const test = useMutation({
    mutationFn: () => api<LlmTestResult>("/app/api/admin/llm/test", { method: "POST" }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: adminLlmKey });
      void qc.invalidateQueries({ queryKey: adminLlmUsageKey });
    },
  });

  const capValue = Number(cap);
  const capValid = cap.trim() !== "" && capValue > 0 && capValue <= settings.dailyCapMaxUsd;
  const patch: LlmSettingsPatch = {
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(model !== settings.model ? { model } : {}),
    ...(capValid && capValue !== settings.dailyCapUsd ? { dailyCapUsd: capValue } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  const disabled = !settings.enabled;
  const hasKey = settings.keyLast4 !== null;

  return (
    <div className="space-y-3">
      {!settings.enabled ? (
        <Alert tone="warning" icon={KeyRound} title={t("admin.llm.disabled.title")}>
          {t("admin.llm.disabled.body")}
        </Alert>
      ) : hasKey && !settings.keyReadable ? (
        <Alert tone="danger" icon={KeyRound} title={t("admin.llm.unreadable.title")}>
          {t("admin.llm.unreadable.body")}
        </Alert>
      ) : null}

      <Card className="p-5">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate(patch);
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Field
                label={t("admin.llm.key")}
                type="password"
                autoComplete="off"
                fullWidth
                disabled={disabled}
                placeholder={hasKey ? t("admin.llm.key.replace") : "sk-ant-…"}
                hint={hasKey ? t("admin.llm.key.saved", { last4: settings.keyLast4! }) : t("admin.llm.key.none")}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-fg-faint">{t("admin.llm.key.help")}</p>
            </div>
            <Select
              label={t("admin.llm.model")}
              disabled={disabled}
              value={model}
              onChange={(e) => setModel(e.target.value as LlmModelId)}
            >
              {LLM_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {t("admin.llm.model.option", {
                    name: m.label,
                    input: usd(m.inputPerMTok, locale, 0),
                    output: usd(m.outputPerMTok, locale, 0),
                  })}
                </option>
              ))}
            </Select>
            <Field
              label={t("admin.llm.cap")}
              type="number"
              inputMode="decimal"
              min={1}
              max={settings.dailyCapMaxUsd}
              step="1"
              fullWidth
              disabled={disabled}
              hint={t("admin.llm.cap.max", { max: usd(settings.dailyCapMaxUsd, locale, 0) })}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          </div>
          <div className="grid gap-x-5 gap-y-1 text-xs text-fg-faint sm:grid-cols-2">
            <p>{t("admin.llm.model.price")}</p>
            <p>{t("admin.llm.cap.help")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button type="submit" loading={save.isPending} disabled={disabled || !dirty || !capValid}>
              {t("common.save")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={test.isPending}
              disabled={disabled || !hasKey || dirty}
              onClick={() => test.mutate()}
            >
              {t("admin.llm.test")}
            </Button>
            {hasKey ? (
              <Button
                type="button"
                variant="ghost"
                className="ml-auto"
                disabled={disabled || save.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: t("admin.llm.key.removeConfirm"),
                      confirmLabel: t("admin.llm.key.remove"),
                      danger: true,
                    })
                  ) {
                    save.mutate({ apiKey: null });
                  }
                }}
              >
                <Trash2 /> {t("admin.llm.key.remove")}
              </Button>
            ) : null}
          </div>
          {save.isError ? <ErrorText>{apiErrorMessage(save.error, t("error.save"))}</ErrorText> : null}
          {test.isError ? <ErrorText>{apiErrorMessage(test.error, t("error.server"))}</ErrorText> : null}
          {test.data ? <TestOutcome result={test.data} /> : null}
        </form>
      </Card>
    </div>
  );
}

function TestOutcome({ result }: { result: LlmTestResult }) {
  const t = useT();
  const { locale } = useI18n();
  return result.ok ? (
    <Alert tone="success" icon={CheckCircle2} title={t("admin.llm.test.ok")}>
      {t("admin.llm.test.okBody", { model: result.model, seconds: formatDecimal(result.latencyMs / 1000, 1, locale) })}
    </Alert>
  ) : (
    <Alert tone="danger" icon={XCircle} title={t("admin.llm.test.failed")}>
      {t(errorLabel(result.error))}
    </Alert>
  );
}

/** Today against the cap, and the month per person (ADR-058 §9). */
function UsageSection({ settings }: { settings: LlmSettings | null }) {
  const t = useT();
  const { locale } = useI18n();
  const usage = useQuery<LlmUsage>({ queryKey: adminLlmUsageKey, queryFn: () => api("/app/api/admin/llm/usage") });
  const tokens = (n: number) => formatDecimal(n, 0, locale);

  return (
    <section className="space-y-3">
      <SectionHeading icon={BarChart3} title={t("admin.llm.usage")} description={t("admin.llm.usage.hint")} />
      {usage.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : usage.isError ? (
        <QueryError title={t("admin.llm.usage")} query={usage} />
      ) : usage.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label={t("admin.llm.today")}
              value={settings ? usd(settings.spentTodayUsd, locale) : "—"}
              hint={settings ? t("admin.llm.today.of", { cap: usd(settings.dailyCapUsd, locale, 0) }) : null}
            />
            <Stat label={t("admin.llm.month.cost")} value={usd(usage.data.total.costUsd, locale)} hint={t("admin.llm.estimate")} />
            <Stat label={t("admin.llm.month.calls")} value={tokens(usage.data.total.calls)} />
          </div>
          {usage.data.rows.length === 0 ? (
            <Card>
              <EmptyState icon={BarChart3} title={t("admin.llm.usage.empty.title")}>
                {t("admin.llm.usage.empty.body")}
              </EmptyState>
            </Card>
          ) : (
            <Card className="overflow-x-auto">
              <table className={cx(T.table, "min-w-160")}>
                <TableHead
                  columns={[
                    { key: "person", label: t("admin.col.person") },
                    { key: "calls", label: t("admin.llm.col.calls"), right: true },
                    { key: "errors", label: t("admin.llm.col.errors"), right: true },
                    { key: "input", label: t("admin.llm.col.input"), right: true },
                    { key: "output", label: t("admin.llm.col.output"), right: true },
                    { key: "cost", label: t("admin.llm.col.cost"), right: true },
                  ]}
                />
                <tbody>
                  {usage.data.rows.map((r) => {
                    const name = [r.givenName, r.familyName].filter(Boolean).join(" ");
                    return (
                      <tr key={r.userId ?? "system"} className={T.row}>
                        <td className={T.td}>
                          <span className="font-semibold">
                            {r.userId === null ? t("admin.llm.system") : name || r.email || "—"}
                          </span>
                          {r.userId !== null && name && r.email ? (
                            <span className="block text-xs text-fg-faint">{r.email}</span>
                          ) : null}
                        </td>
                        <td className={cx(T.td, "text-right tabular-nums")}>{tokens(r.calls)}</td>
                        <td className={cx(T.td, "text-right tabular-nums")}>{r.errors ? tokens(r.errors) : "—"}</td>
                        <td className={cx(T.td, "text-right tabular-nums")}>{tokens(r.inputTokens)}</td>
                        <td className={cx(T.td, "text-right tabular-nums")}>{tokens(r.outputTokens)}</td>
                        <td className={cx(T.td, "text-right tabular-nums")}>{usd(r.costUsd, locale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      ) : null}
    </section>
  );
}
