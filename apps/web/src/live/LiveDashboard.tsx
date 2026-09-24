import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DashboardRow, EvaluationDetail } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { presence } from "../realtime/grid";
import type { Route } from "../router";
import { useShortcuts } from "../shortcuts";
import {
  Card,
  cx,
  EmptyState,
  isTyping,
  Kbd,
  PageError,
  PageSkeleton,
  ParentLink,
  Switch,
  useFullscreen,
  useNow,
} from "../ui";
import { anonymousNumbers } from "./cells";
import { InspectModal } from "./InspectModal";
import { Legend } from "./Legend";
import { LobbyPanel } from "./LobbyPanel";
import { LiveHeader, type LiveControls } from "./LiveHeader";
import { StudentGrid } from "./StudentGrid";
import { useDashboard } from "./useDashboard";
import { useLiveCommands } from "./useLiveCommands";
import { dashboardKey, evaluationKey } from "../queryKeys";

/**
 * The live dashboard (mockup 03, F-DASH, F-LIVE-11).
 *
 * Three decisions carry the screen:
 *   - it does not poll. One fetch, then the SSE stream walks the grid forward
 *     (`useDashboard`), with a once-a-minute refetch as the only safety net;
 *   - the shortcuts are the real interface. A teacher runs this from the back
 *     of a lecture hall: Space pauses, `n` hides the names before projecting,
 *     `r` hides the answers, `s` shows the results, `f` goes full screen. All
 *     of them are written under the grid, because a shortcut nobody can see
 *     does not exist;
 *   - reading ONE student is a modal over the grid and not a panel beside it
 *     (`InspectModal`): it holds every answer of that student at once, which
 *     is what the teacher opened it for, and the grid is one Escape away.
 */

/** Toggles (F-DASH-02), their keys, and their initial state. */
interface Toggles {
  names: boolean;
  answers: boolean;
  results: boolean;
}

export function LiveDashboard({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
  const [toggles, setToggles] = useState<Toggles>({ names: true, answers: true, results: true });
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const [selected, setSelected] = useState<{ attemptId: string; seatId: string; itemId: string } | null>(
    null,
  );

  const { query, clock, connected } = useDashboard(id, toggles.answers, toggles.results);
  // One tick a second drives every countdown on the page; the clock itself is
  // the server's, so they all agree (DESIGN.md, Countdown).
  useNow(1000);
  const now = clock.now();

  // The title and the classroom are the evaluation's, not the grid's read
  // model — one extra cached request, shared with the configuration screen.
  const detail = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(id),
    queryFn: () => api(`/app/api/evaluations/${id}`),
  });

  /**
   * A poll has no grid: one question, no roster, and its screen is the
   * projection (F-LIVE-13). `/evaluations/:id/live` is still a legitimate
   * address for it — an old link, a teacher typing the URL they know — so
   * the dashboard forwards rather than refusing, and it forwards as a
   * `navigate`, which replaces the address bar with the one that is right.
   */
  const isPoll = detail.data?.evaluation.mode === "poll";
  useEffect(() => {
    if (isPoll) navigate({ view: "poll", id });
  }, [isPoll, id, navigate]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: dashboardKey(id, toggles.answers, toggles.results) });
    void qc.invalidateQueries({ queryKey: evaluationKey(id) });
  }, [qc, id, toggles.answers, toggles.results]);

  const control = useMutation({
    mutationFn: (v: { path: string; body?: unknown }) =>
      api(`/app/api/evaluations/${id}/${v.path}`, {
        method: "POST",
        body: JSON.stringify(v.body ?? {}),
      }),
    onSuccess: refresh,
    // A refused control (a 409 illegal transition, a lost session) must say
    // so: a silent failure is a button that "has no effect" (#77).
    onError: toastError("live.controlFailed"),
  });
  const attemptControl = useMutation({
    mutationFn: (v: { attemptId: string; action: "close" | "reopen" }) =>
      api(`/app/api/evaluations/${id}/attempts/${v.attemptId}/${v.action}`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: refresh,
    onError: toastError("live.controlFailed"),
  });

  /**
   * Closing and reopening ONE student are the two row actions that change
   * somebody else's exam, so they ask first — the same rule as closing the
   * whole evaluation, and the reason `window.confirm` is banned.
   */
  const confirmAttempt = useCallback(
    (row: DashboardRow, action: "close" | "reopen", name: string) => {
      if (row.attemptId === null) return;
      const attemptId = row.attemptId;
      void (async () => {
        if (
          await confirm({
            title: t(action === "close" ? "live.row.closeConfirm" : "live.row.reopenConfirm", {
              name,
            }),
            confirmLabel: t(action === "close" ? "live.row.close" : "live.row.reopen"),
            cancelLabel: t("common.cancel"),
            danger: action === "close",
          })
        ) {
          attemptControl.mutate({ attemptId, action });
        }
      })();
    },
    // `attemptControl` is rebuilt on every render; `mutate` itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm, t],
  );

  const state = query.data ?? null;
  const evaluationState = state?.view.evaluation.state ?? "draft";
  const live = evaluationState === "running" || evaluationState === "paused";
  // Only an exam pauses (§1 glossary); unknown until the detail has loaded.
  const canPause = detail.data?.evaluation.mode === "exam";
  const pausable = live && (canPause || evaluationState === "paused");

  /**
   * What a row is called, once (F-DASH-02). With the names off it is
   * "Student 7" and not the animal pseudonym: in front of a class a teacher
   * says a number out loud. The number itself comes from `anonymousNumbers`,
   * which orders the rows by the server's per-evaluation hash so that the
   * numbering cannot be read back as the alphabetical roster.
   */
  const numbers = useMemo(() => anonymousNumbers(state?.view.rows ?? []), [state?.view.rows]);
  const nameOf = useCallback(
    (row: DashboardRow) =>
      toggles.names
        ? row.displayName
        : t("live.row.anonymous", { n: numbers.get(row.seatId) ?? 0 }),
    [toggles.names, numbers, t],
  );

  const controls: LiveControls = {
    busy: control.isPending,
    canPause,
    start: () => control.mutate({ path: "start", body: { confirm: true } }),
    pause: () => control.mutate({ path: "pause" }),
    resume: () => control.mutate({ path: "resume" }),
    extend: (minutes) => control.mutate({ path: "extend", body: { minutes, scope: "all" } }),
    close: () => {
      void (async () => {
        if (
          await confirm({
            title: t("live.closeAllConfirm"),
            confirmLabel: t("live.closeAll"),
            cancelLabel: t("common.cancel"),
            danger: true,
          })
        ) {
          control.mutate({ path: "close" });
        }
      })();
    },
  };

  const selectCell = useCallback((row: DashboardRow, itemId: string) => {
    if (row.attemptId === null) return;
    setSelected({ attemptId: row.attemptId, seatId: row.seatId, itemId });
  }, []);

  useLiveCommands({ t, state: evaluationState, controls, navigate, id });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === " " || e.key === "Spacebar") {
        if (!pausable) return;
        e.preventDefault();
        if (evaluationState === "paused") controls.resume();
        else controls.pause();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "n" || key === "r" || key === "s") {
        e.preventDefault();
        const field = key === "n" ? "names" : key === "r" ? "answers" : "results";
        setToggles((prev) => ({ ...prev, [field]: !prev[field] }));
        return;
      }
      if (key === "f") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      // Escape is the MODAL's, through `useLayer`: only the topmost layer
      // answers it, so a confirmation opened over the modal closes alone.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `controls` is rebuilt on every render; the handler reads the state it
    // needs through the closure, which is refreshed by the same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pausable, evaluationState, selected, toggleFullscreen]);

  // The same keys in the sidebar strip. Reactive to the state: Space only
  // means something while the quiz runs, and Escape only while a cell is open.
  useShortcuts([
    { keys: "N", label: t("live.toggle.names") },
    { keys: "R", label: t("live.toggle.answers") },
    { keys: "S", label: t("live.toggle.results") },
    ...(pausable
      ? [{ keys: "Space", label: evaluationState === "paused" ? t("live.resume") : t("live.pause") }]
      : []),
    { keys: "F", label: t("live.fullscreen") },
    ...(selected ? [{ keys: "Esc", label: t("live.inspect.close") }] : []),
  ]);

  if (isPoll) {
    return <p className="py-12 text-center text-sm text-fg-muted">{t("poll.opening")}</p>;
  }
  if (query.isLoading) {
    return <PageSkeleton header="title-and-bar" />;
  }
  if (query.isError || !state) {
    return (
      <PageError
        title={t("live.notFound")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const { view } = state;
  const counts = presence(state);
  const selectedRow =
    selected === null ? null : (view.rows.find((r) => r.seatId === selected.seatId) ?? null);
  const lobby = evaluationState === "lobby" || evaluationState === "scheduled";

  const body = (
    <div className="space-y-5">
      <LiveHeader
        title={detail.data?.evaluation.title ?? t("live.title")}
        eyebrow={
          <ParentLink onClick={() => navigate({ view: "evaluation", id })}>
            {t("eval.configure")}
          </ParentLink>
        }
        state={evaluationState}
        closesAt={view.evaluation.closesAt}
        now={now}
        controls={controls}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onGoToGrading={() => navigate(gradingLinks(id).grading)}
      />

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className={cx("flex flex-wrap items-center gap-x-5 gap-y-2", lobby && "hidden")}>
          {(["names", "answers", "results"] as const).map((field) => (
            <label key={field} className="flex items-center gap-2 text-[13px] text-fg-muted">
              <Switch
                checked={toggles[field]}
                label={t(`live.toggle.${field}`)}
                onChange={(v) => setToggles((prev) => ({ ...prev, [field]: v }))}
              />
              {t(`live.toggle.${field}`)}
            </label>
          ))}
        </div>
        <span
          className={cx(
            "flex items-center gap-1.5 text-[13px]",
            connected ? "text-fg-muted" : "text-warning",
          )}
        >
          {connected ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
          {connected ? t("live.connected") : t("live.disconnected")}
          <span className="text-fg-faint">
            · {t("live.present", { present: counts.present, enrolled: counts.enrolled })}
          </span>
        </span>
      </div>

      {view.rows.length === 0 ? (
        <Card>
          <EmptyState icon={Users} title={t("live.empty.title")}>
            {t("live.empty.body")}
          </EmptyState>
        </Card>
      ) : lobby ? (
        <LobbyPanel state={state} />
      ) : (
        <>
          <Card className="min-w-0 overflow-hidden">
            <StudentGrid
              state={state}
              now={now}
              paused={evaluationState === "paused"}
              nameOf={nameOf}
              showAnswers={toggles.answers}
              showResults={toggles.results}
              selected={selected}
              onInspect={selectCell}
              onExtend={(row) =>
                control.mutate({
                  path: "extend",
                  body: { minutes: 5, scope: "attempt", attemptId: row.attemptId },
                })
              }
              onClose={(row) => confirmAttempt(row, "close", nameOf(row))}
              onReopen={(row) => confirmAttempt(row, "reopen", nameOf(row))}
            />
          </Card>
          {selectedRow && selected ? (
            <InspectModal
              evaluationId={id}
              state={state}
              row={selectedRow}
              itemId={selected.itemId}
              nameOf={nameOf}
              onSelect={selectCell}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </>
      )}

      <div className={cx("flex flex-wrap items-center justify-between gap-4", lobby && "hidden")}>
        <Legend showResults={toggles.results} />
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-faint">
          <span>{t("live.hint")}</span>
          <span className="inline-flex items-center gap-1">
            <Kbd>N</Kbd> {t("live.toggle.names")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>R</Kbd> {t("live.toggle.answers")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>S</Kbd> {t("live.toggle.results")}
          </span>
          {pausable ? (
            <span className="inline-flex items-center gap-1">
              <Kbd>Space</Kbd> {t("live.pause")}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Kbd>F</Kbd> {t("live.fullscreen")}
          </span>
        </p>
      </div>
    </div>
  );

  return fullscreen ? (
    // `data-testid` and not a class query: the page-level full screen is a
    // STATE the tests assert on, and pinning it to `fixed inset-0 z-30` would
    // make restyling the overlay break the tests that guard its behaviour.
    <div
      data-testid="live-fullscreen-stage"
      className="fixed inset-0 z-30 overflow-auto bg-canvas px-6 py-6"
    >
      {body}
    </div>
  ) : (
    body
  );
}
