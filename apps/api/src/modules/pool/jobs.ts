/**
 * The pool module's scheduled task (D10): the night's LLM review of the
 * published questions (ADR-060 §5). Every hour, so that a restart never
 * skips a night; the run itself works only between 01:00 and 06:00 in
 * Zurich, within its share of the day's cap.
 */
import type { ScheduledTask } from "../../ticker.js";
import { runNightReview } from "./review.js";

export const REVIEW_TASKS: ScheduledTask[] = [
  {
    key: "llm.review",
    defaultIntervalMinutes: 60,
    run: (app) => runNightReview(app.db, app.llmGateway, app.clock.now()),
  },
];
