/*
 * The reads and writes of the group sets (ADR-070, M3-16a), on the routes
 * of `apps/api/src/modules/group/routes.ts`. Every write of a set answers
 * the set as it now stands (`GroupSetDetail`) but its deletion and its
 * duplication, and goes through ONE queue per set: one request at a time,
 * the cache set from the latest answer only, an optimistic move rolled back
 * to the last answer when the queue ends on an error.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import type { GroupSetCreate, GroupSetDetail, GroupSetSummary } from "@quiz/contracts";

import { api } from "../api";
import { classroomGroupSetsKey, groupSetKey, groupSetsKey } from "../queryKeys";

/** `GET /classrooms/:id/group-sets`: the classroom's sets, the oldest first. */
export function useClassroomGroupSets(classroomId: string, enabled = true) {
  return useQuery<GroupSetSummary[]>({
    queryKey: classroomGroupSetsKey(classroomId),
    enabled,
    queryFn: () => api(`/app/api/classrooms/${classroomId}/group-sets`),
  });
}

/** `GET /group-sets/:id`. */
export function useGroupSet(id: string) {
  return useQuery<GroupSetDetail>({ queryKey: groupSetKey(id), queryFn: () => api(`/app/api/group-sets/${id}`) });
}

/**
 * `POST /classrooms/:id/group-sets`: an empty set, named by the server after
 * now ("Groups of <date> <time>", ADR-070 §2). Its answer seeds the set's
 * page, and the classroom's list is read again.
 */
export function useCreateGroupSet(classroomId: string, onCreated: (created: GroupSetDetail) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GroupSetCreate) =>
      api<GroupSetDetail>(`/app/api/classrooms/${classroomId}/group-sets`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (created) => {
      qc.setQueryData(groupSetKey(created.set.id), created);
      await qc.invalidateQueries({ queryKey: classroomGroupSetsKey(classroomId) });
      onCreated(created);
    },
  });
}

/** One write of a set: its method, its path under `/group-sets/:id`, its body. */
export interface SetWrite {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

/** The classrooms' lists count what a write of a set changes: marked stale, refetched where shown. */
const listsKey = [...groupSetsKey, "classroom"] as const;

/**
 * The write queue of one set. `write(request, optimistic?)` sends the
 * request after every write before it has settled, and resolves with its
 * answer (or rejects with its error). `optimistic` is drawn at once; the
 * cache then takes the latest answer only once the queue is empty, so an
 * answer to an earlier write never undoes a later move on screen.
 */
export function useGroupSetWrites(setId: string) {
  const qc = useQueryClient();
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  /** The set as the server last answered it, or as it stood when the queue started. */
  const server = useRef<GroupSetDetail | undefined>(undefined);

  return useCallback(
    (request: SetWrite, optimistic?: (detail: GroupSetDetail) => GroupSetDetail): Promise<GroupSetDetail> => {
      const key = groupSetKey(setId);
      if (inFlight.current === 0) server.current = qc.getQueryData<GroupSetDetail>(key);
      inFlight.current += 1;
      if (optimistic) {
        // A read in flight would land over the move.
        void qc.cancelQueries({ queryKey: key });
        qc.setQueryData<GroupSetDetail>(key, (d) => (d ? optimistic(d) : d));
      }
      const send = () =>
        api<GroupSetDetail>(`/app/api/group-sets/${setId}${request.path}`, {
          method: request.method,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        });
      const run = tail.current.then(send);
      tail.current = run.catch(() => undefined);
      return run.then(
        (answer) => {
          inFlight.current -= 1;
          server.current = answer;
          if (inFlight.current === 0) qc.setQueryData(key, answer);
          void qc.invalidateQueries({ queryKey: listsKey });
          return answer;
        },
        (error: unknown) => {
          inFlight.current -= 1;
          if (inFlight.current === 0 && server.current) qc.setQueryData(key, server.current);
          throw error;
        },
      );
    },
    [qc, setId],
  );
}
