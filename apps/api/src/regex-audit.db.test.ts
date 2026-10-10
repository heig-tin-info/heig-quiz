/**
 * The pre-deploy audit of the RE2 switch (ADR-099, security audit H3): it finds every
 * published pattern RE2 refuses, in short answers and cloze blanks, old
 * versions and deleted questions included, ignores drafts and other types,
 * and writes nothing.
 */
import { randomUUID } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./db/client.js";
import { pools, questions, questionVersions, users } from "./db/schema.js";
import { auditRegexPatterns, formatRegexAudit } from "./regex-audit/audit.js";
import { pgliteDb, testDatabase } from "./test/db.js";

let db: Db;
let client: PGlite;
let poolId: string;

beforeAll(async () => {
  ({ db, client } = await testDatabase());
  const ownerId = randomUUID();
  await db.insert(users).values({ id: ownerId, oidcSub: "owner", email: "owner@heig-vd.ch", role: "teacher" });
  poolId = randomUUID();
  await db.insert(pools).values({ id: poolId, name: "Regex", ownerId });
});

async function question(
  type: string,
  name: string,
  versions: { number: number | null; config: unknown }[],
  deletedAt: Date | null = null,
): Promise<string> {
  const id = randomUUID();
  await db.insert(questions).values({ id, poolId, type, internalName: name, deletedAt });
  await db
    .insert(questionVersions)
    .values(versions.map((v) => ({ id: randomUUID(), questionId: id, number: v.number, config: v.config })));
  return id;
}

const short = (...patterns: string[]) => ({
  configVersion: 3,
  prompt: "?",
  matchers: [{ kind: "exact", value: "x" }, ...patterns.map((pattern) => ({ kind: "regex", pattern, flags: "i" }))],
});

describe("auditRegexPatterns", () => {
  it("lists the published patterns RE2 refuses, and only those", async () => {
    const fixed = await question("short", "fixed later", [
      { number: 1, config: short("(a)\\1") },
      { number: 2, config: short("a{2}") },
      { number: null, config: short("a(?=b)") },
    ]);
    const gone = await question("cloze", "deleted cloze", [{ number: 1, config: { text: "{{Newton}} {{/(?<=a)b/}}" } }], new Date());
    await question("short", "clean", [{ number: 1, config: short("galil[ée]e") }]);
    await question("mcq", "not a pattern", [{ number: 1, config: { matchers: [{ kind: "regex", pattern: "(a)\\1" }] } }]);

    const audit = await auditRegexPatterns(db);
    expect(audit.versions).toBe(4);
    expect(
      audit.findings.map((f) => [f.question, f.version, f.latest, f.deleted, f.where, f.problem, f.pattern, f.questionId]),
    ).toEqual([
      ["deleted cloze", 1, true, true, "blank 2", "unsupported", "(?<=a)b", gone],
      ["fixed later", 1, false, false, "matcher 2", "unsupported", "(a)\\1", fixed],
    ]);

    const report = formatRegexAudit(audit);
    expect(report).toContain("Regex / fixed later");
    expect(report).toContain("v1\tshort matcher 2\tunsupported\t/(a)\\1/i");
    expect(report.split("\n").at(-1)).toBe("2 pattern(s) in 2 question(s) never match under RE2 (4 published versions read).");
  });

  it("says so when every pattern compiles, and reads configs of any shape", async () => {
    await db.delete(questions);
    await question("short", "no matchers", [{ number: 1, config: {} }]);
    await question("cloze", "no text", [{ number: 1, config: { text: 3 } }]);
    await question("short", "old flags", [{ number: 1, config: { matchers: [{ kind: "regex", pattern: "abc" }] } }]);
    expect(formatRegexAudit(await auditRegexPatterns(db))).toBe(
      "Every regex pattern of the 3 published short and cloze versions compiles under RE2.",
    );
  });

  it("runs in a read-only transaction", async () => {
    const statements: string[] = [];
    await auditRegexPatterns(pgliteDb(client, { logQuery: (query) => statements.push(query) }));
    expect(statements[0]).toMatch(/^set transaction read only$/i);
    expect(statements.slice(1).every((s) => /^select /i.test(s))).toBe(true);
  });
});
