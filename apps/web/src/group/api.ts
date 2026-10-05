/*
 * The reads and writes of the group sets (ADR-070, M3-16a), on the routes
 * of `apps/api/src/modules/group/routes.ts`; and the student's (F-PROJ-22,
 * M3-17): their view of the classroom's sets, their four writes. Every write of a set answers
 * the set as it now stands (`GroupSetDetail`) but its deletion and its
 * duplication, and goes through ONE queue per set: one request at a time,
 * the cache set from the latest answer only, an optimistic move rolled back
 * to the last answer when the queue ends on an error.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";

import {
  GroupCreate,
  GroupMemberPut,
  GroupRandomForm,
  GroupRename,
  GroupSetCreate,
  GroupSetPatch,
  StudentGroupCreate,
  StudentGroupJoin,
  type GroupSetDetail,
  type GroupSetSummary,
  type StudentGroupSets,
} from "@quiz/contracts";

import { api, refusedWith } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { classroomGroupSetsKey, groupSetKey, groupSetListsKey, studentClassroomKey, studentGroupSetsKey, studentHomeKey } from "../queryKeys";
import { groupRefusalMessage, WriteHeld } from "./groupRules";

/** `GET /classrooms/:id/group-sets`: the classroom's sets, the oldest first. */
export function useClassroomGroupSets(classroomId: string) {
  return useQuery<GroupSetSummary[]>({
    queryKey: classroomGroupSetsKey(classroomId),
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
 * page, and the classroom's list is read again; a failure is a toast.
 */
export function useCreateGroupSet(classroomId: string, onCreated: (created: GroupSetDetail) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  return useMutation({
    mutationFn: () =>
      api<GroupSetDetail>(`/app/api/classrooms/${classroomId}/group-sets`, {
        method: "POST",
        body: JSON.stringify(GroupSetCreate.parse({})),
      }),
    onSuccess: async (created) => {
      qc.setQueryData(groupSetKey(created.set.id), created);
      await qc.invalidateQueries({ queryKey: classroomGroupSetsKey(classroomId) });
      onCreated(created);
    },
    onError: (error) => toast(groupRefusalMessage(error, t), "error"),
  });
}

/**
 * One write of a set: its method, its path under `/group-sets/:id`, and its
 * body built by the route's own schema (invariant 7). `setWrite` makes each.
 */
type SetWrite =
  | { method: "PATCH"; path: ""; body: GroupSetPatch }
  | { method: "POST"; path: "/groups"; body: GroupCreate }
  | { method: "PATCH"; path: `/groups/${string}`; body: GroupRename }
  | { method: "DELETE"; path: `/groups/${string}`; body?: undefined }
  | { method: "PUT"; path: `/members/${string}`; body: GroupMemberPut }
  | { method: "POST"; path: "/random"; body: GroupRandomForm };

export const setWrite = {
  patch: (body: GroupSetPatch): SetWrite => ({ method: "PATCH", path: "", body: GroupSetPatch.parse(body) }),
  addGroup: (): SetWrite => ({ method: "POST", path: "/groups", body: GroupCreate.parse({}) }),
  /** Null when the name is no name (no letter nor digit): the caller says so. */
  renameGroup: (groupId: string, name: string): SetWrite | null => {
    const body = GroupRename.safeParse({ name });
    return body.success ? { method: "PATCH", path: `/groups/${groupId}`, body: body.data } : null;
  },
  deleteGroup: (groupId: string): SetWrite => ({ method: "DELETE", path: `/groups/${groupId}` }),
  /** `confirm`: the digest of the consequences the staff confirmed (ADR-070 §6). */
  place: (enrollmentId: string, groupId: string | null, confirm?: string): SetWrite => ({
    method: "PUT",
    path: `/members/${enrollmentId}`,
    body: GroupMemberPut.parse(confirm === undefined ? { groupId } : { groupId, confirm }),
  }),
  random: (body: GroupRandomForm): SetWrite => ({ method: "POST", path: "/random", body: GroupRandomForm.parse(body) }),
};

/**
 * The write queue of one set. `write(request, optimistic?)` sends the
 * request after every write before it has settled, and resolves with its
 * answer (or rejects with its error). `optimistic` is drawn at once; the
 * cache then takes the latest answer only once the queue is empty, so an
 * answer to an earlier write never undoes a later move on screen. A queue
 * that ends on an error puts back the last answer, and reads the set again:
 * whatever refused the write may have changed it (another teacher's
 * deletion).
 *
 * A write refused `409 needs_confirmation` (ADR-070 §6, M3-16b) HOLDS the
 * queue: its optimistic step stays drawn while the page asks, every later
 * write — queued already, or new — is rejected with {@link WriteHeld}
 * rather than sent, and the page ends the hold with `confirm(request)`,
 * the same write with the digest, or `cancel()`, which puts back the last
 * answer.
 */
export function useGroupSetWrites(setId: string) {
  const qc = useQueryClient();
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  /** The set as the server last answered it, or as it stood when the queue started. */
  const server = useRef<GroupSetDetail | undefined>(undefined);
  /** A confirmation is asked: nothing is sent until it is answered. */
  const held = useRef(false);
  /** The drawn set is not the server's since a hold: kept as the base until the hold's write settles. */
  const holding = useRef(false);

  return useMemo(() => {
    const key = groupSetKey(setId);
    const putBack = () => {
      holding.current = false;
      if (server.current) qc.setQueryData(key, server.current);
      void qc.invalidateQueries({ queryKey: key });
    };
    const write = (request: SetWrite, optimistic?: (detail: GroupSetDetail) => GroupSetDetail): Promise<GroupSetDetail> => {
      if (held.current) return Promise.reject(new WriteHeld());
      if (inFlight.current === 0 && !holding.current) server.current = qc.getQueryData<GroupSetDetail>(key);
      inFlight.current += 1;
      if (optimistic) {
        // A read in flight would land over the move.
        void qc.cancelQueries({ queryKey: key });
        qc.setQueryData<GroupSetDetail>(key, (d) => (d ? optimistic(d) : d));
      }
      const send = () => {
        if (held.current) throw new WriteHeld();
        return api<GroupSetDetail>(`/app/api/group-sets/${setId}${request.path}`, {
          method: request.method,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        });
      };
      const run = tail.current.then(send);
      tail.current = run.catch(() => undefined);
      return run.then(
        (answer) => {
          inFlight.current -= 1;
          server.current = answer;
          if (inFlight.current === 0) {
            holding.current = false;
            qc.setQueryData(key, answer);
          }
          void qc.invalidateQueries({ queryKey: groupSetListsKey });
          return answer;
        },
        (error: unknown) => {
          inFlight.current -= 1;
          if (refusedWith(error, "needs_confirmation")) {
            held.current = true;
            holding.current = true;
          } else if (inFlight.current === 0 && !held.current) {
            putBack();
          }
          throw error;
        },
      );
    };
    return {
      write,
      /** Ends the hold by sending `request` — the held write with its digest. */
      confirm: (request: SetWrite): Promise<GroupSetDetail> => {
        held.current = false;
        return write(request);
      },
      /** Ends the hold without sending: the last answer is drawn again. */
      cancel: () => {
        held.current = false;
        if (inFlight.current === 0) putBack();
      },
    };
  }, [qc, setId]);
}

// ---------------------------------------------------------------- the student's side (F-PROJ-22, M3-17)

/** `GET /classrooms/:id/group-sets/student`: the classroom's sets as the caller reads them. */
export function useStudentGroupSets(classroomId: string) {
  return useQuery<StudentGroupSets>({
    queryKey: studentGroupSetsKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/group-sets/student`),
  });
}

/** One write of a student, under `/group-sets/:id/student`, its body built by the route's own schema (invariant 7). */
export type StudentWrite =
  | { method: "POST"; path: "/groups"; body: StudentGroupCreate }
  | { method: "PUT"; path: "/membership"; body: StudentGroupJoin }
  | { method: "DELETE"; path: "/membership"; body?: undefined }
  | { method: "PATCH"; path: `/groups/${string}`; body: GroupRename };

export const studentWrite = {
  create: (name: string): StudentWrite => ({
    method: "POST",
    path: "/groups",
    body: StudentGroupCreate.parse(name.trim() === "" ? {} : { name }),
  }),
  join: (groupId: string): StudentWrite => ({ method: "PUT", path: "/membership", body: StudentGroupJoin.parse({ groupId }) }),
  leave: (): StudentWrite => ({ method: "DELETE", path: "/membership" }),
  rename: (groupId: string, name: string): StudentWrite => ({ method: "PATCH", path: `/groups/${groupId}`, body: GroupRename.parse({ name }) }),
};

/**
 * A student's write on set `setId` of `classroomId`: its answer — the
 * classroom's sets as the writer now reads them — replaces the list, and
 * the student's pages (the Activities row says their group) are read again. A refusal re-reads the list — the set
 * may have closed, frozen or filled since — and is the caller's to say.
 */
export function useStudentGroupWrite(classroomId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ setId, request }: { setId: string; request: StudentWrite }) =>
      api<StudentGroupSets>(`/app/api/group-sets/${setId}/student${request.path}`, {
        method: request.method,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }),
    onSuccess: (answer) => {
      qc.setQueryData(studentGroupSetsKey(classroomId), answer);
      void qc.invalidateQueries({ queryKey: studentClassroomKey(classroomId), exact: true });
      void qc.invalidateQueries({ queryKey: studentHomeKey });
    },
    onError: () => void qc.invalidateQueries({ queryKey: studentGroupSetsKey(classroomId) }),
  });
}
