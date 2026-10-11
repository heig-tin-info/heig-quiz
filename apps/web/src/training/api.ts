/**
 * The training course of a new teacher (ADR-105, F-ORG-17): its status —
 * whether the content is installed, the caller's course, the state of each
 * mission — and the one action that provisions or opens it. The two calls
 * are typed by the contract; the status is derived server-side and never
 * stored, so the client only reads and invalidates.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { TrainingProvisionResponse, TrainingStatus } from "@quiz/contracts";

import { api, type ReadOptions } from "../api";
import { useErrorToast } from "../notify";
import { coursesKey, trainingKey } from "../queryKeys";
import type { Route } from "../router";

/** `GET /training`: the caller's training course and the state of its missions. */
export function useTrainingStatus(options: ReadOptions = {}) {
  return useQuery<TrainingStatus>({
    queryKey: trainingKey,
    queryFn: () => api("/app/api/training"),
    ...options,
  });
}

/**
 * Provisions the caller's training course, or opens the one they have: the
 * ONE gesture behind the Courses home's line, the account menu's entry and
 * the palette's command (ADR-105 §5). A second call returns the existing
 * course, so the three doors lead to the same classroom. The courses are
 * refreshed too: a course appeared on the home and in the sidebar.
 */
export function useOpenTraining(navigate: (r: Route) => void) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const status = useTrainingStatus({ enabled: false });
  const provision = useMutation({
    mutationFn: () => api<TrainingProvisionResponse>("/app/api/training", { method: "POST" }),
    onSuccess: async (made) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: trainingKey }),
        qc.invalidateQueries({ queryKey: coursesKey }),
      ]);
      navigate({ view: "classroom", id: made.classroomId });
    },
    onError: toastError("training.provisionFailed"),
  });
  const course = status.data?.course;
  return {
    open: () => {
      if (course) navigate({ view: "classroom", id: course.classroomId });
      else provision.mutate();
    },
    pending: provision.isPending,
  };
}
