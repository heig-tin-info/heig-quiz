/**
 * The agreement figures of an evaluation's grading (ADR-139 §15), for the
 * staff only; `@quiz/domain` (`gradingAgreement.ts`) computes them and these
 * schemas check its types. A figure with nothing to count is `null`.
 */
import { z } from "zod";

import type {
  AgreementTally as DomainAgreementTally,
  AiAgreement as DomainAiAgreement,
  ContestationTally as DomainContestationTally,
} from "@quiz/domain";

const count = z.number().int().nonnegative();

export const AgreementTally = z.object({
  compared: count,
  unchanged: count,
  changed: count,
  /** Mean |in force − proposal| over the changed cells, in points; `null` when none changed. */
  meanAbsDelta: z.number().nullable(),
}) satisfies z.ZodType<DomainAgreementTally>;
export type AgreementTally = z.infer<typeof AgreementTally>;

/** Per confidence the model stated, `null` for a level no cell had. */
export const AiAgreement = AgreementTally.extend({
  byConfidence: z.object({
    high: AgreementTally.nullable(),
    medium: AgreementTally.nullable(),
    low: AgreementTally.nullable(),
  }),
}) satisfies z.ZodType<DomainAiAgreement>;
export type AiAgreement = z.infer<typeof AiAgreement>;

const ContestedCount = z.object({ filed: count, accepted: count });

/** Over `graded`, the cells holding a validated grading; per source of the contested grading, filed and accepted. */
export const ContestationTally = ContestedCount.extend({
  graded: count,
  open: count,
  refused: count,
  bySource: z.object({ auto: ContestedCount, llm: ContestedCount, manual: ContestedCount }),
}) satisfies z.ZodType<DomainContestationTally>;
export type ContestationTally = z.infer<typeof ContestationTally>;

/** One question's figures, or the whole evaluation's. */
export const GradingFigures = z.object({
  agreement: AiAgreement.nullable(),
  contestations: ContestationTally.nullable(),
});
export type GradingFigures = z.infer<typeof GradingFigures>;
