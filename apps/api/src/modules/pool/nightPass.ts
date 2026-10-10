/**
 * The skeleton of the night's LLM passes (ADR-060 §5, ADR-095): the scheduled
 * tasks `llm.review` and `llm.domain` both run between 01:00 and 06:00 in
 * Zurich, need a key, take a small share of the day's cap, make one call at
 * a time and stop BEFORE a call would take the night past that share — never
 * on the gateway's refusal, so the budget check stays green. What differs
 * (the candidates, the call, the words of the report) is passed in.
 */
import {
  isReviewNight,
  llmWorstCaseUsd,
  modelFor,
  type LlmPurpose,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { LlmError, settingsRow, spentToday, type LlmGateway } from "../llm/service.js";

export interface NightPassSpec<T> {
  purpose: LlmPurpose;
  /** The pass's share of the day's cap, 0 to 1. */
  share: number;
  /** What the report says when there is no key ("nothing reviewed"). */
  noKey: string;
  /** The candidates, read once the night, the key and the settings are checked. */
  items: () => Promise<T[]>;
  /** The size of the prompt, in characters, for the worst-case cost of one call. */
  promptChars: (item: T) => number;
  maxTokens: number;
  /** One call. An `LlmError` other than a fatal one counts as a failure. */
  run: (item: T) => Promise<void>;
  /** A failed call, recorded so the next night tries again. */
  onFailure?: (item: T) => Promise<void>;
  /** The counts, in the task's words. */
  report: (done: number, failed: number) => string;
}

/** The night's run: the report line, or why it did not run. */
export async function nightPass<T>(db: Db, gateway: LlmGateway, now: Date, spec: NightPassSpec<T>): Promise<string> {
  if (!isReviewNight(now)) return "outside the night (01:00–06:00, Zurich)";
  if (!(await gateway.ready())) return `no LLM key: ${spec.noKey}`;
  const settings = await settingsRow(db);
  const share = settings.dailyCapUsd * spec.share;
  const model = modelFor(settings.models, spec.purpose);
  let done = 0;
  let failed = 0;
  for (const item of await spec.items()) {
    const spent = await spentToday(db, now, { purpose: spec.purpose, unattributed: true });
    if (spent + llmWorstCaseUsd(model, spec.promptChars(item), spec.maxTokens) > share) {
      return `${spec.report(done, failed)}; the night's share of the cap is spent`;
    }
    try {
      await spec.run(item);
      done += 1;
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      // No key, or the cap itself: nothing more tonight.
      if (error.code === "not_configured" || error.code === "key_unreadable" || error.code === "budget_exhausted") {
        return `${spec.report(done, failed)}; stopped: ${error.code}`;
      }
      await spec.onFailure?.(item);
      failed += 1;
    }
  }
  return spec.report(done, failed);
}
