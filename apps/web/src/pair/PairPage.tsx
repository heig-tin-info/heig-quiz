import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, MonitorSmartphone, ScanQrCode, TriangleAlert } from "lucide-react";

import type { Me, PairApprove, PairApproved, PairPreview, PairableEvaluation, PairableProject } from "@quiz/contracts";
import { formatUserCode, normalizeUserCode } from "@quiz/domain";

import { ApiError, api } from "../api";
import { useT } from "../i18n";
import { pairPreviewKey } from "../queryKeys";
import type { Navigate } from "../router";
import { SignInGate } from "../SignInGate";
import { ConditionsList } from "../student/ConditionsList";
import { Alert, Button, Card, EmptyState, Field, GateCard, GateFrame, QueryError, RadioRow, Skeleton, cx } from "../ui";
import { CodeScanner } from "./CodeScanner";
import { canScan } from "./scan";

/**
 * `/pair` — the phone's half of a kiosk station's pairing (ADR-051 §7,
 * F-EVAL-28). The code comes from the station's QR (`?code=`), is typed, or
 * is read by the page's own camera scanner (a secondary action under the
 * field); the page then shows the station's NAME, to compare with the screen in
 * front of the student, and the exams and supervised projects (ADR-089 §5)
 * they can start there, as one choice. ONE primary
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

const errorOf = (err: unknown) => (err instanceof ApiError ? { status: err.status } : null);

/** One thing the station can open: an exam (its conditions read before confirming) or a project. */
type Pairable =
  | { kind: "exam"; key: string; item: PairableEvaluation }
  | { kind: "project"; key: string; item: PairableProject };

/** The exams, then the projects, each keyed by its kind: an exam and a project never share a radio value. */
const pairablesOf = (preview: PairPreview | undefined): Pairable[] => [
  ...(preview?.evaluations ?? []).map((item) => ({ kind: "exam" as const, key: `exam:${item.id}`, item })),
  ...(preview?.projects ?? []).map((item) => ({ kind: "project" as const, key: `project:${item.id}`, item })),
];

/** The approval's body for one choice (`PairApprove`). */
const approvalOf = (code: string, choice: Pairable): PairApprove =>
  choice.kind === "exam" ? { code, evaluationId: choice.item.id } : { code, projectId: choice.item.id };

function Pairing({ initial, navigate }: { initial: string | null; navigate?: Navigate | undefined }) {
  const t = useT();
  const [typed, setTyped] = useState(initial ?? "");
  const [code, setCode] = useState<string | null>(initial);
  const [malformed, setMalformed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const fieldId = useId();
  const [scannable] = useState(canScan);
  const [scanning, setScanning] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);

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
    mutationFn: (choice: Pairable) =>
      api<PairApproved>("/app/api/pair", { method: "POST", body: JSON.stringify(approvalOf(code!, choice)) }),
  });

  const lookUp = (value: string) => {
    const canonical = normalizeUserCode(value);
    setMalformed(canonical === null);
    if (canonical === null) return;
    setPicked(null);
    approve.reset();
    // The same code again, after a refusal: asked again, not read from the cache.
    if (canonical === code) void preview.refetch();
    else setCode(canonical);
  };
  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    lookUp(typed);
  };
  const startScan = () => {
    setCameraFailed(false);
    setScanning(true);
  };
  // A scanned code goes the way of a typed one: into the field, then Continue.
  const scanned = (value: string) => {
    setScanning(false);
    setTyped(value);
    lookUp(value);
  };
  const scanFailed = () => {
    setScanning(false);
    setCameraFailed(true);
    document.getElementById(fieldId)?.focus();
  };
  const changeCode = () => {
    setCode(null);
    setTyped("");
    setPicked(null);
    approve.reset();
  };

  if (approve.isSuccess) {
    return <Done label={approve.data.station.label} project={approve.variables.kind === "project"} navigate={navigate} />;
  }

  const lookupError = errorOf(preview.error);
  // A refusal the student answers by typing a code again; any other failure is a retry.
  const codeRefused = lookupError?.status === 404 || lookupError?.status === 429;
  const found = preview.data;
  const choices = pairablesOf(found);
  const chosen = choices.length === 1 ? choices[0]! : (choices.find((c) => c.key === picked) ?? null);
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
              id={fieldId}
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
            {scanning ? (
              <CodeScanner
                onCode={scanned}
                onCancel={() => setScanning(false)}
                onFail={scanFailed}
              />
            ) : cameraFailed ? (
              <p className="text-[13px] text-fg-muted">{t("pair.scan.unavailable")}</p>
            ) : scannable ? (
              <Button variant="secondary" className="w-full" onClick={startScan}>
                <ScanQrCode aria-hidden />
                {t("pair.scan.start")}
              </Button>
            ) : null}
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
            <QueryError title={t("error.server")} query={preview} />
          </div>
        ) : (
          <>
            <section className="mt-5 rounded-card border border-line bg-surface-2 px-4 py-3">
              <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">{t("pair.station")}</p>
              <p className="mt-1 text-xl font-bold tracking-tight">{found!.station.label}</p>
              <p className="mt-1 text-[13px] text-fg-muted">{t("pair.station.check")}</p>
            </section>

            {choices.length === 0 ? (
              <EmptyState icon={TriangleAlert} title={t("pair.none.title")} className="pt-6 pb-2">
                {t("pair.none.body")}
              </EmptyState>
            ) : (
              <Picker choices={choices} chosen={chosen?.key ?? null} onPick={setPicked} />
            )}

            {/* ADR-079 §7: the station begins the attempt directly, so the chosen exam's conditions are read here, before confirming. */}
            {chosen?.kind === "exam" ? <ConditionsList conditions={chosen.item.conditions} className="mt-5" /> : null}

            {approveError ? (
              <div className="mt-4">
                <Alert tone="danger">
                  {t(
                    approveError.status === 429
                      ? "pair.limited"
                      : approveError.status === 404
                        ? "pair.invalid.body"
                        : approve.variables?.kind === "project"
                          ? "pair.refused.project"
                          : "pair.refused",
                  )}
                </Alert>
              </div>
            ) : null}

            {choices.length > 0 ? (
              // A sticky dock on a phone (DESIGN.md, the launch step's): the conditions above may run past the fold.
              <div data-bottom-dock="" data-action-bar="" className="sticky bottom-0 z-10 -mx-5 mt-5 border-t border-line bg-surface px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:border-0 sm:p-0">
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  disabled={chosen === null}
                  loading={approve.isPending}
                  onClick={() => chosen && approve.mutate(chosen)}
                >
                  {t("pair.start")}
                </Button>
              </div>
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

/**
 * What the student may open on the station, exams then projects: one shown
 * as chosen, several as a radio group. The legend names the kinds listed;
 * mixed, each line says its kind.
 */
function Picker({
  choices,
  chosen,
  onPick,
}: {
  choices: Pairable[];
  chosen: string | null;
  onPick: (key: string) => void;
}) {
  const t = useT();
  const name = useId();
  const kinds = new Set(choices.map((c) => c.kind));
  const mixed = kinds.size > 1;
  const legend = mixed ? "pair.activity" : kinds.has("project") ? "pair.project" : "pair.exam";
  return (
    <fieldset className="mt-5 space-y-1.5">
      <legend className="text-[13px] font-medium text-fg">{t(legend)}</legend>
      <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
        {choices.map(({ key, kind, item }) => (
          <RadioRow key={key} name={name} value={key} checked={chosen === key} onPick={onPick} className="px-4 py-3 text-[15px]">
            <span className="block font-semibold text-fg">{item.title}</span>
            <span className="block text-[13px] text-fg-muted">
              {mixed ? `${t(kind === "exam" ? "pair.exam" : "pair.project")} · ` : null}
              {item.courseCode} · {item.classroomName}
            </span>
          </RadioRow>
        ))}
      </div>
    </fieldset>
  );
}

function Done({ label, project, navigate }: { label: string; project: boolean; navigate?: Navigate | undefined }) {
  const t = useT();
  return (
    <GateCard
      role="status"
      icon={<CircleCheck className="mx-auto size-10 text-success" aria-hidden />}
      title={t(project ? "pair.done.project.title" : "pair.done.title")}
      body={t(project ? "pair.done.project.body" : "pair.done.body", { label })}
    >
      {navigate ? (
        <Button variant="secondary" className="mt-6" onClick={() => navigate({ view: "home" })}>
          {t("player.closed.home")}
        </Button>
      ) : null}
    </GateCard>
  );
}
