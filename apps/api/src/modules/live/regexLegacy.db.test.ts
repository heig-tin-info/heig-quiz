/**
 * A version published while JavaScript's engine ran the regex matchers, with
 * a pattern RE2 now refuses (ADR-099, security audit H3), stays readable: it
 * loads, reaches the student through the one exit, and grades — the refused
 * matcher or blank never matching. The refusal is publication's only.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { pools, questions, questionVersions, users } from "../../db/schema.js";
import { UnavailableRunner } from "../runner/unavailable.js";
import { loadConfig, typeOf, type StaticVersion } from "../pool/config.js";
import { testDatabase } from "../../test/db.js";
import { studentView } from "./studentView.js";

let db: Db;
let poolId: string;

beforeAll(async () => {
  ({ db } = await testDatabase());
  const ownerId = randomUUID();
  await db.insert(users).values({ id: ownerId, oidcSub: "legacy-owner", email: "owner@heig-vd.ch", role: "teacher" });
  poolId = randomUUID();
  await db.insert(pools).values({ id: poolId, name: "Legacy", ownerId });
});

/** Writes a published version straight into the table, as the old engine's publication left it. */
async function published(type: string, config: unknown, configVersion: number): Promise<StaticVersion> {
  const questionId = randomUUID();
  await db.insert(questions).values({ id: questionId, poolId, type, internalName: `legacy ${type}` });
  await db.insert(questionVersions).values({ id: randomUUID(), questionId, number: 1, config, configVersion });
  const [row] = await db.select().from(questionVersions).where(eq(questionVersions.questionId, questionId));
  return { config: row!.config, configVersion: row!.configVersion, variables: null };
}

async function grade(type: string, version: StaticVersion, answer: unknown) {
  const t = typeOf(type);
  return t.grade(loadConfig(type, version), t.answerSchema.parse(answer), {
    seed: 1,
    itemId: "item",
    attemptId: "attempt",
    itemPoints: 2,
    now: new Date(),
    runner: new UnavailableRunner("test"),
  });
}

describe("a published version holding a pattern RE2 refuses", () => {
  it("short: loads, serves the student view, grades the refused matcher as never matching", async () => {
    const t = typeOf("short");
    const version = await published(
      "short",
      {
        configVersion: t.configVersion,
        prompt: "Which letter comes before b?",
        matchers: [
          { kind: "regex", pattern: "SECRET-a(?=b)", flags: "i", points: 1 },
          { kind: "exact", value: "a", points: 0.5 },
        ],
      },
      t.configVersion,
    );
    const view = studentView({ type: "short", version, seed: 1, itemId: "item", shuffle: false });
    expect(JSON.stringify(view)).not.toContain("SECRET");
    // The first matcher would have taken "SECRET-ab"; under RE2 it never matches.
    expect(await grade("short", version, { text: "SECRET-ab" })).toMatchObject({ kind: "graded", points: 0 });
    expect(await grade("short", version, { text: "a" })).toMatchObject({ kind: "graded", points: 1 });
  });

  it("cloze: loads, serves the student view, grades the refused blank as never matching", async () => {
    const t = typeOf("cloze");
    const version = await published(
      "cloze",
      { configVersion: t.configVersion, text: "{{/SECRET-a(?=b)/}} then {{Newton}}" },
      t.configVersion,
    );
    const view = studentView({ type: "cloze", version, seed: 1, itemId: "item", shuffle: false }) as {
      blanks: unknown[];
    };
    expect(view.blanks).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    expect(await grade("cloze", version, { blanks: ["SECRET-ab", "Newton"] })).toMatchObject({
      kind: "graded",
      points: 1,
    });
  });
});
