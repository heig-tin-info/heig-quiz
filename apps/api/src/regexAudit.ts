/**
 * Which published `short` and `cloze` versions hold a regex pattern the RE2
 * engine refuses (security audit H3, `@quiz/domain/short`): a backreference,
 * a lookaround, or a program too large. Such a pattern was accepted when
 * JavaScript's backtracking `RegExp` ran the matchers; under RE2 it never
 * matches, so a student's right answer would be marked wrong. The product
 * owner runs this against production before approving the deploy that
 * switches the engine (`regex-audit.ts`), and the teachers concerned
 * publish a fixed version.
 *
 * Read-only: one `READ ONLY` transaction, every published version (a
 * running or past evaluation may still grade an old one), drafts left out —
 * the editor reports those itself on the next save.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { parseCloze } from "@quiz/domain/cloze";
import { patternProblem, type PatternProblem } from "@quiz/domain/short";

import type { Db } from "./db/client.js";
import { pools, questions, questionVersions } from "./db/schema.js";

export interface RegexFinding {
  pool: string | null;
  questionId: string;
  question: string;
  type: "short" | "cloze";
  version: number;
  /** The question's latest published version: the one new evaluations take. */
  latest: boolean;
  deleted: boolean;
  /** `matcher 2` of a short answer, `blank 3` of a cloze, counted from 1. */
  where: string;
  problem: PatternProblem;
  pattern: string;
  flags: string;
}

export interface RegexAudit {
  versions: number;
  findings: RegexFinding[];
}

/** One pattern of a config, with where the teacher finds it. */
interface StoredPattern {
  where: string;
  pattern: string;
  flags: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** The regex matchers of a short answer, whatever its config version (they all store `pattern` and `flags`). */
function shortPatterns(config: unknown): StoredPattern[] {
  const matchers = asRecord(config).matchers;
  if (!Array.isArray(matchers)) return [];
  return matchers.flatMap((raw, i) => {
    const matcher = asRecord(raw);
    if (matcher.kind !== "regex") return [];
    return [{ where: `matcher ${i + 1}`, pattern: String(matcher.pattern), flags: typeof matcher.flags === "string" ? matcher.flags : "i" }];
  });
}

/** The regex blanks of a cloze text: a refused pattern stays a blank (`parseCloze`). */
function clozePatterns(config: unknown): StoredPattern[] {
  const text = asRecord(config).text;
  if (typeof text !== "string") return [];
  return parseCloze(text).blanks.flatMap((blank) =>
    blank.kind === "regex" ? [{ where: `blank ${blank.index + 1}`, pattern: blank.pattern, flags: blank.flags }] : [],
  );
}

export async function auditRegexPatterns(db: Db): Promise<RegexAudit> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return tx
      .select({
        pool: pools.name,
        questionId: questions.id,
        question: questions.internalName,
        type: questions.type,
        deletedAt: questions.deletedAt,
        version: questionVersions.number,
        config: questionVersions.config,
      })
      .from(questionVersions)
      .innerJoin(questions, eq(questions.id, questionVersions.questionId))
      .leftJoin(pools, eq(pools.id, questions.poolId))
      .where(and(isNotNull(questionVersions.number), inArray(questions.type, ["short", "cloze"])))
      .orderBy(asc(pools.name), asc(questions.internalName), asc(questionVersions.number));
  });

  const latest = new Map<string, number>();
  for (const row of rows) latest.set(row.questionId, Math.max(latest.get(row.questionId) ?? 0, row.version!));

  const findings = rows.flatMap((row) => {
    const type = row.type as RegexFinding["type"];
    const patterns = type === "short" ? shortPatterns(row.config) : clozePatterns(row.config);
    return patterns.flatMap(({ where, pattern, flags }): RegexFinding[] => {
      const problem = patternProblem(pattern, flags);
      if (problem === null) return [];
      return [
        {
          pool: row.pool,
          questionId: row.questionId,
          question: row.question,
          type,
          version: row.version!,
          latest: latest.get(row.questionId) === row.version,
          deleted: row.deletedAt !== null,
          where,
          problem,
          pattern,
          flags,
        },
      ];
    });
  });
  return { versions: rows.length, findings };
}

/** The report, one line per refused pattern, then the count. */
export function formatRegexAudit({ versions, findings }: RegexAudit): string {
  const lines = findings.map((f) =>
    [
      `${f.pool ?? "(no pool)"} / ${f.question} (${f.questionId})`,
      `v${f.version}${f.latest ? " latest" : ""}${f.deleted ? " deleted" : ""}`,
      `${f.type} ${f.where}`,
      f.problem,
      `/${f.pattern}/${f.flags}`,
    ].join("\t"),
  );
  const questionCount = new Set(findings.map((f) => f.questionId)).size;
  lines.push(
    findings.length === 0
      ? `Every regex pattern of the ${versions} published short and cloze versions compiles under RE2.`
      : `${findings.length} pattern(s) in ${questionCount} question(s) no longer compile under RE2 (${versions} published versions read).`,
  );
  return lines.join("\n");
}
