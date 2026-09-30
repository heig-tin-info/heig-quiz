import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, MonitorSmartphone, TriangleAlert } from "lucide-react";

import type { Me, PairApprove, PairApproved, PairPreview, PairableEvaluation } from "@quiz/contracts";
import { formatUserCode, normalizeUserCode } from "@quiz/domain";

import { ApiError, api } from "../api";
import { useT } from "../i18n";
import { pairPreviewKey } from "../queryKeys";
import type { Navigate } from "../router";
import { SignInGate } from "../SignInGate";
import { Alert, Button, Card, EmptyState, Field, GateFrame, QueryError, Skeleton, cx } from "../ui";

/**
 * `/pair` — the phone's half of a kiosk station's pairing (ADR-051 §7,
 * F-EVAL-28). The code comes from the station's QR (`?code=`) or is typed;
 * the page then shows the station's NAME, to compare with the screen in
 * front of the student, and the exams they can start there. ONE primary
 * action at a time: Continue while there is only a code, then "Start on
 * this station".
 *
 * Signed out, it signs in and comes back with the same code (`next`, masked
 * in the request log). The code leaves the address bar once read: a phone's
 * history is not where a pairing code should linger.
 */
export function PairPage({ me, navigate }: { me: Me | null; navigate?: Navigate }) {
  const t = useT();
  const [initial] = useState(() => normalizeUserCode(new URLSearchParams(window.location.search).get("code") ?? ""));
  if (!me) {
    return (
      <SignInGate
        next={initial ? `/pair?code=${initial}` : "/pair"}
        header={<MonitorSmartphone className="mx-auto size-8 text-fg-muted" />}
        title={t("pair.signIn.title")}
        body={t("pair.signIn.body")}
        action={t("pair.signIn.action")}
      />
    );
  }
  return <Pairing initial={initial} navigate={navigate} />;
}

const errorOf = (err: unknown) =>
  err instanceof ApiError ? { status: err.status, code: (err.body as { error?: string } | null)?.error } : null;

function Pairing({ initial, navigate }: { initial: string | null; navigate?: Navigate | undefined }) {
  const t = useT();
  const [typed, setTyped] = useState(initial ?? "");
  const [code, setCode] = useState<string | null>(initial);
  const [malformed, setMalformed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const preview = useQuery<PairPreview>({
    queryKey: pairPreviewKey(code ?? ""),
    queryFn: async () => {
      const found = await api<PairPreview>(`/app/api/pair/${encodeURIComponent(code!)}`);
      // Read once: out of the address bar and the history.
      window.history.replaceState(null, "", "/pair");
      return found;
    },
    enabled: code !== null,
    retry: false,
    // Every look-up of a wrong code is counted against the student: never twice for one typing.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const approve = useMutation({
    mutationFn: (evaluationId: string) =>
      api<PairApproved>("/app/api/pair", {
        method: "POST",
        body: JSON.stringify({ code: code!, evaluationId } satisfies PairApprove),
      }),
  });

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    const canonical = normalizeUserCode(typed);
    setMalformed(canonical === null);
    if (canonical === null) return;
    setPicked(null);
    approve.reset();
    // The same code again, after a refusal: asked again, not read from the cache.
    if (canonical === code) void preview.refetch();
    else setCode(canonical);
  };
  const changeCode = () => {
    setCode(null);
    setTyped("");
    setPicked(null);
    approve.reset();
  };

  if (approve.isSuccess) return <Done label={approve.data.station.label} navigate={navigate} />;

  const lookupError = errorOf(preview.error);
  // A refusal the student answers by typing a code again; any other failure is a retry.
  const codeRefused = lookupError?.status === 404 || lookupError?.status === 429;
  const found = preview.data;
  const exams = found?.evaluations ?? [];
  const chosen = exams.length === 1 ? exams[0]!.id : picked;
  const approveError = errorOf(approve.error);

  return (
    <GateFrame>
      <Card className="px-5 py-6 sm:px-6">
        <h1 className="text-lg font-bold tracking-tight">{t("pair.title")}</h1>

        {code === null || codeRefused ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={submitCode} noValidate>
            {lookupError?.status === 404 ? (
              <Alert tone="warning" title={t("pair.invalid.title")}>
                {t("pair.invalid.body")}
              </Alert>
            ) : lookupError?.status === 429 ? (
              <Alert tone="danger">{t("pair.limited")}</Alert>
            ) : null}
            <Field
              label={t("pair.code.label")}
              fullWidth
              value={typed}
              onChange={(e) => {
                setTyped(formatUserCode(e.target.value));
                setMalformed(false);
              }}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              placeholder="BCDF-GHJK"
              aria-invalid={malformed || undefined}
              className="font-mono text-lg tracking-[0.08em]"
            />
            <p className={cx("-mt-1 text-[13px]", malformed ? "text-danger" : "text-fg-faint")}>
              {t(malformed ? "pair.code.malformed" : "pair.code.hint")}
            </p>
            <Button type="submit" variant="primary" size="lg" className="w-full">
              {t("pair.code.submit")}
            </Button>
          </form>
        ) : preview.isLoading ? (
          <div className="mt-5 space-y-3" aria-busy>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : preview.isError ? (
          <div className="mt-5">
            <QueryError
              title={t("error.server")}
              error={preview.error}
              onRetry={() => void preview.refetch()}
              retrying={preview.isFetching}
              fallback={t("error.server")}
            />
          </div>
        ) : (
          <>
            <section className="mt-5 rounded-card border border-line bg-surface-2 px-4 py-3">
              <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">{t("pair.station")}</p>
              <p className="mt-1 text-xl font-bold tracking-tight">{found!.station.label}</p>
              <p className="mt-1 text-[13px] text-fg-muted">{t("pair.station.check")}</p>
            </section>

            {exams.length === 0 ? (
              <EmptyState icon={TriangleAlert} title={t("pair.none.title")} className="pt-6 pb-2">
                {t("pair.none.body")}
              </EmptyState>
            ) : (
              <ExamPicker exams={exams} chosen={chosen} onPick={setPicked} />
            )}

            {approveError ? (
              <div className="mt-4">
                <Alert tone="danger">
                  {t(
                    approveError.status === 429
                      ? "pair.limited"
                      : approveError.status === 404
                        ? "pair.invalid.body"
                        : "pair.refused",
                  )}
                </Alert>
              </div>
            ) : null}

            {exams.length > 0 ? (
              <Button
                variant="primary"
                size="lg"
                className="mt-5 w-full"
                disabled={chosen === null}
                loading={approve.isPending}
                onClick={() => chosen && approve.mutate(chosen)}
              >
                {t("pair.start")}
              </Button>
            ) : null}
            <Button variant="ghost" className="mt-2 w-full" onClick={changeCode}>
              {t("pair.code.change")}
            </Button>
          </>
        )}
      </Card>
    </GateFrame>
  );
}

/** The exams the student may open on the station: one shown as chosen, several as a radio group. */
function ExamPicker({
  exams,
  chosen,
  onPick,
}: {
  exams: PairableEvaluation[];
  chosen: string | null;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const name = useId();
  return (
    <fieldset className="mt-5 space-y-1.5">
      <legend className="text-[13px] font-medium text-fg">{t("pair.exam")}</legend>
      <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
        {exams.map((exam) => {
          const checked = chosen === exam.id;
          return (
            <label
              key={exam.id}
              className={cx(
                "flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors",
                checked ? "bg-accent-soft" : "hover:bg-surface-2",
              )}
            >
              <input
                type="radio"
                name={name}
                value={exam.id}
                checked={checked}
                onChange={() => onPick(exam.id)}
                className="mt-1 size-4 shrink-0 appearance-none rounded-full border border-line-strong bg-surface transition-[border-width] checked:border-[5px] checked:border-accent"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-fg">{exam.title}</span>
                <span className="block text-[13px] text-fg-muted">
                  {exam.courseCode} · {exam.classroomName}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Done({ label, navigate }: { label: string; navigate?: Navigate | undefined }) {
  const t = useT();
  return (
    <GateFrame>
      <Card className="px-6 py-8 text-center" role="status">
        <CircleCheck className="mx-auto size-10 text-success" aria-hidden />
        <h1 className="mt-3 text-lg font-bold tracking-tight">{t("pair.done.title")}</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("pair.done.body", { label })}</p>
        {navigate ? (
          <Button variant="secondary" className="mt-6" onClick={() => navigate({ view: "home" })}>
            {t("player.closed.home")}
          </Button>
        ) : null}
      </Card>
    </GateFrame>
  );
}
