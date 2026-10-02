import { useQuery } from "@tanstack/react-query";

import type { LlmAvailability } from "@quiz/contracts";

import { api } from "./api";
import { generateAvailabilityKey } from "./queryKeys";

/**
 * Whether the platform has a model now, and the types with a wand
 * (ADR-059): what the wand, the pool's "LLM review" tab and "Review now"
 * (ADR-060) are offered on. One query, shared, kept a minute.
 */
export function useLlmAvailability() {
  return useQuery<LlmAvailability>({
    queryKey: generateAvailabilityKey,
    queryFn: () => api("/app/api/generate/availability"),
    staleTime: 60_000,
    retry: false,
  });
}
