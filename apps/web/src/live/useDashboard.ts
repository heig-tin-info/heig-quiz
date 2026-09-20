import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { DashboardView } from "@quiz/contracts";

import { api } from "../api";
import { dashboardKey } from "../evaluation/common";
import { applyGridEvent, initialGrid, type GridState } from "../realtime/grid";
import { useEventStream } from "../realtime/useEventStream";
import { useServerClock, type ServerClock } from "../realtime/useServerClock";

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

export function useDashboard(id: string, includeAnswers: boolean): DashboardStream {
  const qc = useQueryClient();
  const clock = useServerClock();
  const key = dashboardKey(id, includeAnswers);

  const query = useQuery<GridState>({
    queryKey: key,
    // The answers toggle changes the KEY (`?includeAnswers=`), and a grid
    // that blanks to a skeleton every time a teacher hides the answers
    // before projecting is a grid that flashes at the worst moment. The
    // previous variant stays on screen until the new one lands.
    placeholderData: keepPreviousData,
    queryFn: async () =>
      initialGrid(
        await api(`/app/api/evaluations/${id}/dashboard?includeAnswers=${includeAnswers ? 1 : 0}`),
      ),
  });

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, id, includeAnswers]);

  const { connected } = useEventStream({
    watch: `evaluation:${id}`,
    onClock: (serverNow) => clock.sample(serverNow),
    onSnapshot: (state) => {
      if (includeAnswers) {
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
    },
    onRefresh: refresh,
  });

  return { query, clock, connected };
}
