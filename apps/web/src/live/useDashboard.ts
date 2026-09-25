import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { DashboardView } from "@quiz/contracts";

import { api } from "../api";
import { applyGridEvent, initialGrid, type GridState } from "../realtime/grid";
import { useEventStream } from "../realtime/useEventStream";
import { useServerClock, type ServerClock } from "../realtime/useServerClock";
import { attemptInspectKey, attemptInspectPrefix, dashboardKey } from "../queryKeys";

/**
 * The live dashboard as one hook: the read model, the stream that moves it,
 * and the server clock every countdown on the screen reads.
 *
 * The grid is fetched ONCE and then walked forward by events
 * (`dashboard.cell`, `dashboard.presence`, `evaluation.state`,
 * `lobby.count`), written straight into the query cache with
 * `setQueryData`. No cell fetches anything: thirty students answering twelve
 * questions would otherwise be a few hundred requests a minute, and a grid
 * that refetches is a grid that flickers on a projector.
 *
 * One asymmetry is the server's, and it is worth naming. The `snapshot` frame
 * of an evaluation stream is always built with `includeAnswers: false`
 * (`modules/realtime/routes.ts`), because the stream does not know which
 * toggles the teacher has on. So a snapshot SEEDS the cache while the answers
 * toggle is off, and merely triggers a refetch of `?includeAnswers=1` while
 * it is on — rather than silently blanking every answer the teacher is
 * reading.
 */
export interface DashboardStream {
  query: ReturnType<typeof useQuery<GridState>>;
  clock: ServerClock;
  connected: boolean;
}

export function useDashboard(
  id: string,
  includeAnswers: boolean,
  includeResults: boolean,
): DashboardStream {
  const qc = useQueryClient();
  const clock = useServerClock();
  const key = dashboardKey(id, includeAnswers, includeResults);

  const query = useQuery<GridState>({
    queryKey: key,
    // The answers toggle changes the KEY (`?includeAnswers=`), and a grid
    // that blanks to a skeleton every time a teacher hides the answers
    // before projecting is a grid that flashes at the worst moment. The
    // previous variant stays on screen until the new one lands.
    placeholderData: keepPreviousData,
    queryFn: async () =>
      initialGrid(
        await api(
          `/app/api/evaluations/${id}/dashboard?includeAnswers=${
            includeAnswers ? 1 : 0
          }&results=${includeResults ? 1 : 0}`,
        ),
      ),
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key });
    // A re-read of the grid (a reconnect, a snapshot, a hint) may follow
    // frames this tab never received, so every paper cached for a tooltip or
    // the inspection modal is suspect too.
    void qc.invalidateQueries({ queryKey: attemptInspectPrefix(id) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, id, includeAnswers, includeResults]);

  const { connected } = useEventStream({
    watch: `evaluation:${id}`,
    onClock: (serverNow) => clock.sample(serverNow),
    onSnapshot: (state) => {
      // The stream builds its snapshot without either toggle, so a teacher
      // reading the answers OR the live verdicts refetches their own variant
      // instead of having it silently blanked.
      if (includeAnswers || includeResults) {
        refresh();
        return;
      }
      const parsed = DashboardView.safeParse(state);
      if (!parsed.success) return;
      qc.setQueryData<GridState>(key, (prev) =>
        prev ? { ...prev, view: parsed.data } : initialGrid(parsed.data),
      );
    },
    onEvent: (event) => {
      qc.setQueryData<GridState>(key, (prev) => (prev ? applyGridEvent(prev, event) : prev));
      // The student wrote something, or their attempt changed state: the
      // paper cached for that attempt (the cell tooltip's, the modal's) is
      // now behind the grid. It is MARKED stale and not refetched here: a
      // student typing sends a frame a second, and an open modal re-reading
      // the whole paper at that pace is a request a second for nothing —
      // it reads the fresh one on its next opening. A tooltip that is open
      // compares the paper's revision with its cell's and re-reads it
      // itself (`AnswerTip`), so it never shows an answer older than its
      // cell (#94).
      const attemptId =
        event.type === "dashboard.cell" ||
        event.type === "dashboard.attempt" ||
        event.type === "attempt.closed" ||
        event.type === "attempt.deadline"
          ? event.attemptId
          : null;
      if (attemptId !== null) {
        void qc.invalidateQueries({
          queryKey: attemptInspectKey(id, attemptId),
          refetchType: "none",
        });
      }
    },
    /*
     * A hint on the `evaluations` family means the grid gained or lost a ROW
     * — a teacher who just took a seat and opened the quiz (ADR-018), or one
     * who threw their test attempt away. No typed frame can express that, and
     * every frame that follows it (`dashboard.presence`, `dashboard.cell`) is
     * keyed on a row that is not there yet, so it lands nowhere. Re-reading is
     * the answer, and it is the one the server asked for by sending a hint.
     */
    onHint: (hint) => {
      if (hint.kinds.includes("evaluations")) refresh();
    },
    onRefresh: refresh,
  });

  return { query, clock, connected };
}
