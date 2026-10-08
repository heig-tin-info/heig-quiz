import { useQuery } from "@tanstack/react-query";

import type { ConceptList } from "@quiz/contracts";

import { api } from "../api";
import { conceptsKey } from "../queryKeys";

/** The instance's vocabulary (ADR-081), merged concepts left out: one query, shared by the sorting screen and its dialogs. */
export function useConcepts(enabled = true) {
  return useQuery<ConceptList>({ queryKey: conceptsKey, queryFn: () => api("/app/api/concepts"), enabled });
}
