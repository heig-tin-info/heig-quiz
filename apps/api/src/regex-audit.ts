/**
 * A one-shot operations tool, kept for the deploy that switches the regex
 * engine to RE2 (ADR-099): it lists the published `short` and `cloze`
 * versions whose patterns RE2 refuses, which then never match
 * (`regex-audit/audit.ts`). Read-only. Delete it once production has run it
 * and the teachers concerned have published fixed versions.
 *
 *   DATABASE_URL=… pnpm --filter @quiz/api regex:audit
 *
 * In the production image it is compiled with the API, like `seed.ts`, and
 * runs with plain Node: `node dist/regex-audit.js` (from `/app`), against
 * the `DATABASE_URL` of the environment. Nothing falls back to a local
 * database: without `DATABASE_URL` it refuses, so an empty answer is never
 * an all-clear for the wrong database.
 *
 * Exit status: 0 nothing refused; 2 at least one pattern listed; 3 no
 * published short or cloze version read at all (the wrong database?); 1 error.
 */
import { parseArgs } from "node:util";

import { createDb } from "./db/client.js";
import { auditRegexPatterns, formatRegexAudit } from "./regex-audit/audit.js";

async function main() {
  const { values } = parseArgs({ options: { help: { type: "boolean" } } });
  if (values.help) {
    console.log("usage: DATABASE_URL=… regex-audit   (lists the regex patterns RE2 refuses; writes nothing)");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set: name the database to audit");
  const handle = createDb(url);
  try {
    const audit = await auditRegexPatterns(handle.db);
    console.log(formatRegexAudit(audit));
    if (audit.versions === 0) {
      console.error("No published short or cloze version was read: is DATABASE_URL the right database?");
      process.exitCode = 3;
    } else if (audit.findings.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
