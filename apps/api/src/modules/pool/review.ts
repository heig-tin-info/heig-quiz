/**
 * The LLM review of the published questions (ADR-060): the prompt, the call
 * through the gateway of ADR-058 (purpose `review`), the findings kept, the
 * fix applied to the draft, and the night's run within its share of the cap.
 *
 * What is sent: the version's type, config and explanation — no name, no
 * author, no student (open question 43). What is kept: the findings, never
 * the prompt nor the reply.
 */
import { z } from "zod";

import type { QuestionReview, ReviewFinding } from "@quiz/contracts";
import {
  applyFix,
  isReviewNight,
  LLM_REVIEW_NIGHT_SHARE,
  llmWorstCaseUsd,
  modelFor,
  parsePath,
  REVIEW_MAX_FINDINGS,
  REVIEW_SEVERITIES,
  UNREVIEWED_TYPES,
  valueAt,
  withValueAt,
} from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { LlmError, settingsRow, spentToday, type LlmGateway } from "../llm/service.js";
import { draftOf, putDraft } from "./questionWrite.js";
import { nightCandidates, reviewJson, saveFindings, saveReview } from "./reviewStore.js";
import type { QuestionRecord } from "./shared.js";

/** Why a review cannot run or a fix cannot apply, before or after any model. */
export class ReviewRefusal extends Error {
  constructor(readonly code: "not_published" | "review_unsupported" | "no_review" | "no_fix" | "fix_stale") {
    super(code);
    this.name = "ReviewRefusal";
  }
}

const MAX_TOKENS = 4_000;

export const ReviewReply = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(REVIEW_SEVERITIES),
      path: z.string(),
      message: z.string(),
      fix: z.object({ from: z.string(), to: z.string() }).nullable(),
    }),
  ),
});

const SYSTEM = [
  "You review a quiz question of the HEIG-VD, a Swiss school of engineering, before students meet it in an exam.",
  "You receive its type, its config as JSON and its explanation. Report only what is WRONG: a spelling or grammar",
  "mistake (`notice`); an ambiguous statement, an explanation that contradicts the key, a distractor that is also",
  "right (`warn`); a wrong answer key, a question that cannot be answered as written (`error`). Never report style",
  "or wording preferences. When the question is fine, return no finding at all: silence is the expected answer.",
  "Each finding names its field by `path`, a dot path into the config (`prompt`, `choices.2.text`,",
  "`choices.2.correct`) or `explanation`; a `message` of one or two sentences, in the language of the statement;",
  "and, when the correction is certain and local, a `fix`: `from`, the EXACT text of the field to replace (it",
  "must occur once in it), and `to`, its replacement — for a tick, `from` `false` and `to` `true`. Otherwise",
  "`fix` is null.",
  "`[[…]]` expressions are parameters drawn per student, not typos. Images (`asset:` links) are not shown to you:",
  "never report a figure as missing or unclear.",
].join(" ");

/**
 * The findings kept from a reply: on a field the version has, the fix only
 * when it applies to the reviewed version itself — a fix that does not even
 * apply there is the model's mistake, not the question's.
 */
export function keptFindings(
  config: unknown,
  explanation: string,
  findings: z.infer<typeof ReviewReply>["findings"],
): ReviewFinding[] {
  const kept: ReviewFinding[] = [];
  for (const f of findings.slice(0, REVIEW_MAX_FINDINGS)) {
    const value = fieldValue(config, explanation, f.path);
    if (value === undefined) continue;
    const fix = f.fix && applyFix(value, f.fix.from, f.fix.to) !== null ? f.fix : null;
    kept.push({ severity: f.severity, path: f.path, message: f.message.trim().slice(0, 1_000), fix });
  }
  return kept;
}

/** The value a path names: `explanation`, or a field of the config. */
function fieldValue(config: unknown, explanation: string, path: string): unknown {
  if (path === "explanation") return explanation;
  const parts = parsePath(path);
  return parts === null ? undefined : valueAt(config, parts);
}

/** Reviews one published version and stores the review; the gateway's failures pass through. */
export async function reviewVersion(
  db: Db,
  gateway: LlmGateway,
  version: { id: string; number: number; type: string; config: unknown; explanation: string },
  userId: string | null,
  now: Date,
): Promise<QuestionReview> {
  if (UNREVIEWED_TYPES.has(version.type)) throw new ReviewRefusal("review_unsupported");
  const { value, model } = await gateway.complete({
    purpose: "review",
    userId,
    system: SYSTEM,
    prompt: [
      `Question type: ${version.type}.`,
      `Config, as JSON:\n${JSON.stringify(version.config)}`,
      `Explanation: ${version.explanation.trim() === "" ? "(none)" : `\n${version.explanation}`}`,
    ].join("\n\n"),
    schema: ReviewReply,
    maxTokens: MAX_TOKENS,
    effort: "low",
  });
  const findings = keptFindings(version.config, version.explanation, value.findings);
  const row = await saveReview(db, version.id, {
    state: findings.length === 0 ? "clean" : "findings",
    findings,
    model,
    at: now,
  });
  return reviewJson(row, version.number);
}

/**
 * Fix (ADR-060 §4): the finding's exact replacement applied to the
 * question's DRAFT — or, with `undo`, its inverse —, stored as an edit. The
 * field must still hold the text the review saw, once: otherwise the draft
 * moved on and the fix is refused (`fix_stale`).
 */
export async function applyReviewFix(
  db: Db,
  question: QuestionRecord,
  review: { versionId: string; findings: ReviewFinding[] },
  index: number,
  undo: boolean,
): Promise<ReviewFinding[]> {
  const finding = review.findings[index];
  if (!finding?.fix) throw new ReviewRefusal("no_fix");
  // A fix is applied once, and only an applied one is undone: an Undo of a
  // fix never made would rewrite text the teacher wrote, with no way back.
  if (undo !== (finding.applied === true)) throw new ReviewRefusal("fix_stale");
  const [from, to] = undo ? [finding.fix.to, finding.fix.from] : [finding.fix.from, finding.fix.to];
  const draft = await draftOf(db, question.id);
  let config = draft.config;
  let explanation = draft.explanation;
  if (finding.path === "explanation") {
    const next = applyFix(explanation, from, to);
    if (typeof next !== "string") throw new ReviewRefusal("fix_stale");
    explanation = next;
  } else {
    const path = parsePath(finding.path);
    const next = path && applyFix(valueAt(config, path), from, to);
    const replaced = path && next !== null ? withValueAt(config, path, next) : null;
    if (replaced === null) throw new ReviewRefusal("fix_stale");
    config = replaced;
  }
  await putDraft(db, question, { config, explanation });
  const findings = review.findings.map((f, i) => (i === index ? { ...f, applied: !undo } : f));
  await saveFindings(db, review.versionId, findings);
  return findings;
}

/** Versions looked at per run of the task: an hour's run never holds the worker long. */
const NIGHT_BATCH = 60;

/**
 * The night's run (ADR-060 §5), the scheduled task `llm.review`: between
 * 01:00 and 06:00 in Zurich, the latest versions of the pools that asked,
 * one call at a time, stopping BEFORE a call would take the night past its
 * share of the cap — never on the gateway's refusal, so the budget check
 * stays green. A failed call is recorded `failed` and retried the next
 * night; a missing key or an empty cap ends the run.
 */
export async function runNightReview(db: Db, gateway: LlmGateway, now: Date): Promise<string> {
  if (!isReviewNight(now)) return "outside the night (01:00–06:00, Zurich)";
  if (!(await gateway.ready())) return "no LLM key: nothing reviewed";
  const settings = await settingsRow(db);
  const share = settings.dailyCapUsd * LLM_REVIEW_NIGHT_SHARE;
  const model = modelFor(settings.models, "review");
  const candidates = await nightCandidates(db, now, NIGHT_BATCH);
  let reviewed = 0;
  let failed = 0;
  for (const version of candidates) {
    const promptChars = JSON.stringify(version.config).length + version.explanation.length + SYSTEM.length;
    if ((await spentToday(db, now, { purpose: "review", unattributed: true })) + llmWorstCaseUsd(model, promptChars, MAX_TOKENS) > share) {
      return `${reviewed} reviewed, ${failed} failed; the night's share of the cap is spent`;
    }
    try {
      await reviewVersion(db, gateway, { ...version, id: version.versionId, number: version.number! }, null, now);
      reviewed += 1;
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      // No key, or the cap itself: nothing more tonight.
      if (error.code === "not_configured" || error.code === "key_unreadable" || error.code === "budget_exhausted") {
        return `${reviewed} reviewed, ${failed} failed; stopped: ${error.code}`;
      }
      await saveReview(db, version.versionId, { state: "failed", findings: [], model: null, at: now });
      failed += 1;
    }
  }
  return `${reviewed} reviewed, ${failed} failed`;
}
