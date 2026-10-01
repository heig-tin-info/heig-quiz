/**
 * The llm module, and its two services on the Fastify instance, on purpose
 * (ADR-058 §8):
 *
 *  - `app.llm`, the GRADING service of ADR-045: at most one `LlmService`,
 *    selected once, at boot, by `LLM_PROVIDER`, like `RUNNER_MODE` selects
 *    the runner. `none` (the default, and production's) leaves it null, and
 *    an essay is graded by hand; `stub` is the deterministic provider of
 *    development (`./stub.ts`), which `config.ts` refuses in production.
 *  - `app.llmGateway`, the GATEWAY of ADR-058 (`./gateway.ts`): a real model,
 *    called with the institutional key an administrator stored, logged and
 *    capped. Off without `LLM_KEY_SECRET`. Not wired into grading yet.
 */
import type { LlmService } from "@quiz/core/server";

import type { AppConfig } from "../../config.js";
import { tracked } from "../../serviceHealth.js";
import type { LlmGateway } from "./gateway.js";
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
    /** The gateway of ADR-058; `enabled` is false without a master key. */
    llmGateway: LlmGateway;
  }
}
