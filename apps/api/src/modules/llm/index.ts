/**
 * The llm module: at most one `LlmService` on the Fastify instance (ADR-045).
 *
 * `LLM_PROVIDER` selects it once, at boot, like `RUNNER_MODE` selects the
 * runner: `none` (the default, and production's until a real provider
 * exists) leaves `app.llm` null, and an essay is graded by hand; `stub` is
 * the deterministic provider of development (`./stub.ts`), which
 * `config.ts` refuses in production.
 */
import type { LlmService } from "@quiz/core/server";

import type { AppConfig } from "../../config.js";
import { tracked } from "../../serviceHealth.js";
import { StubLlm } from "./stub.js";

export function createLlm(config: Pick<AppConfig, "LLM_PROVIDER">): LlmService | null {
  const provider = config.LLM_PROVIDER === "stub" ? new StubLlm() : null;
  // Every call recorded for the services' status (ADR-055 §6), whatever the provider.
  return provider && { grade: (req) => tracked("llm", () => provider.grade(req)) };
}

declare module "fastify" {
  interface FastifyInstance {
    /** Null without a provider: nothing is ever sent to a model. */
    llm: LlmService | null;
  }
}
