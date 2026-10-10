/**
 * The pool module's scheduled tasks (D10): the night's LLM review of the
 * published questions (ADR-060 §5) and the night's domain pass (ADR-095). Every hour, so that a restart never
 * skips a night; the run itself works only between 01:00 and 06:00 in
 * Zurich, within its share of the day's cap.
 */
import type { ScheduledTask } from "../../ticker.js";
import { runNightDomains } from "./domain.js";
import { runNightReview } from "./review.js";

export const REVIEW_TASKS: ScheduledTask[] = [
  {
    key: "llm.review",
    defaultIntervalMinutes: 60,
    run: (app) => runNightReview(app.db, app.llmGateway, app.clock.now()),
  },
  // The bilingual domain of the public pools (ADR-095), on the review's cadence and night.
  {
    key: "llm.domain",
    defaultIntervalMinutes: 60,
    run: (app) => runNightDomains(app.db, app.llmGateway, app.clock.now()),
  },
];
