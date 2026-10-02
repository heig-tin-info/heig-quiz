/**
 * The llm module, and its two services on the Fastify instance:
 *
 *  - `app.llm`, the GRADING service (ADR-045, ADR-063): at most one
 *    `GradingLlm`, selected once, at boot. `LLM_PROVIDER=stub` is the
 *    deterministic provider of development (`./stub.ts`), which `config.ts`
 *    refuses in production; otherwise the real model through the gateway
 *    (`./grader.ts`) whenever the gateway is on. `ready()` says whether a
 *    call can be made at all: the gateway holds a key.
 *  - `app.llmGateway`, the GATEWAY of ADR-058 (`./gateway.ts`): a real model,
 *    called with the institutional key an administrator stored, logged and
 *    capped. Off without `LLM_KEY_SECRET`.
 */
import type { LlmGradeOutcome, LlmGradeRequest } from "@quiz/core/server";

import type { AppConfig } from "../../config.js";
import { tracked } from "../../serviceHealth.js";
import type { LlmGateway } from "./gateway.js";
import { gatewayGrader } from "./grader.js";
import { StubLlm } from "./stub.js";

export interface GradingLlm {
  /** Whether a call can be made now; the grading pass offers the service only then. */
  ready(): Promise<boolean>;
  /** `billedTo` is the person the call is logged against (`llm_calls`, F-LLM-04), never sent to the model. */
  grade(req: LlmGradeRequest, billedTo: string | null): Promise<LlmGradeOutcome>;
}

/**
 * The stub when `LLM_PROVIDER=stub`, else the gateway's grader when there is
 * a gateway that is on. The seed passes none: it never calls a real model.
 */
export function createLlm(config: Pick<AppConfig, "LLM_PROVIDER">, gateway: LlmGateway | null): GradingLlm | null {
  if (config.LLM_PROVIDER === "stub") {
    const stub = new StubLlm();
    // Every call recorded for the services' status (ADR-055 §6); the gateway records its own.
    return { ready: () => Promise.resolve(true), grade: (req) => tracked("llm", () => stub.grade(req)) };
  }
  return gateway?.enabled ? gatewayGrader(gateway) : null;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Null without a provider: nothing is ever sent to a model. */
    llm: GradingLlm | null;
    /** The gateway of ADR-058; `enabled` is false without a master key. */
    llmGateway: LlmGateway;
  }
}
