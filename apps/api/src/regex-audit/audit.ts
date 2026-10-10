/**
 * Which published `short` and `cloze` versions hold a regex pattern the RE2
 * engine refuses (ADR-099, security audit H3): JavaScript-only syntax (a
 * backreference, a lookaround), a program too large, patterns that together
 * pass the build budget of one question, or — in a parameterized cloze — a
 * regex blank holding a `[[…]]` reference, a pattern of its own built for
 * every student (ADR-056 §10). Such a pattern was
 * accepted while JavaScript's backtracking `RegExp` ran the matchers. Under
 * RE2 the version stays readable, but that matcher or blank never matches,
 * so a student's right answer there is graded wrong until the teacher
 * publishes a fixed version (an evaluation that froze the old one keeps it).
 *
 * The command line is `../regex-audit.ts`. Read-only: one `READ ONLY`
 * transaction over every published version (a running or past evaluation
 * may still grade an old one), drafts left out — the editor reports those
 * itself on the next save.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { parseCloze } from "@quiz/domain/cloze";
import { configPatternProblems, DEFAULT_REGEX_FLAGS, type PatternProblem } from "@quiz/domain/regex";

import type { Db } from "../db/client.js";
import { pools, questions, questionVersions } from "../db/schema.js";

export interface RegexFinding {
  pool: string | null;
  questionId: string;
  question: string;
  type: "short" | "cloze";
  version: number;
  /** The question's latest published version: the one new evaluations take. */
  latest: boolean;
  deleted: boolean;
  /** `matcher 2` of a short answer, `blank 3` of a cloze, counted from 1; `question` for the whole. */
  where: string;
  /** Why it never matches, or why it should not be published again. */
  problem: PatternProblem | "config_too_complex" | "computed_regex_key";
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
    const flags = typeof matcher.flags === "string" ? matcher.flags : DEFAULT_REGEX_FLAGS;
    return [{ where: `matcher ${i + 1}`, pattern: String(matcher.pattern), flags }];
  });
}

/** The regex blanks of a cloze text: the parse keeps every one, whatever its pattern. */
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
        variables: questionVersions.variables,
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
    const finding = (where: string, problem: RegexFinding["problem"], pattern = "", flags = ""): RegexFinding => ({
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
    });
    const patterns = type === "short" ? shortPatterns(row.config) : clozePatterns(row.config);
    const parameterized = (row.variables?.rows.length ?? 0) > 0;
    // A template's `[[…]]` is replaced per student: the template's own pattern says nothing.
    const computed = type === "cloze" && parameterized ? patterns.filter((p) => p.pattern.includes("[[")) : [];
    const fixed = patterns.filter((p) => !computed.includes(p));
    const problems = configPatternProblems(fixed);
    return [
      ...computed.map((p) => finding(p.where, "computed_regex_key", p.pattern, p.flags)),
      ...(problems === "too_costly"
        ? [finding("question", "config_too_complex")]
        : fixed.flatMap((p, i) => (problems[i] ? [finding(p.where, problems[i], p.pattern, p.flags)] : []))),
    ];
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
      f.pattern === "" ? "-" : `/${f.pattern}/${f.flags}`,
    ].join("\t"),
  );
  const questionCount = new Set(findings.map((f) => f.questionId)).size;
  lines.push(
    findings.length === 0
      ? `Every regex pattern of the ${versions} published short and cloze versions compiles under RE2.`
      : `${findings.length} finding(s) in ${questionCount} question(s): never matching under RE2, or to fix before publishing again (${versions} published versions read).`,
  );
  return lines.join("\n");
}
