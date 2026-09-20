import { z } from "zod";

export const HealthStatus = z.enum(["ok", "degraded"]);

export const HealthResponse = z.object({
  status: HealthStatus,
  checks: z.object({
    database: z.enum(["up", "down"]),
    jobs: z.enum(["up", "down"]),
    /**
     * The code runner. `disabled` is `RUNNER_MODE=stub`, the default: the
     * platform is running as configured, so it is not a failure (decision D14).
     */
    runner: z.enum(["up", "down", "disabled"]),
  }),
  uptimeSeconds: z.number(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
