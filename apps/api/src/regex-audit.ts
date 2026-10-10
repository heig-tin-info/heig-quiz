/**
 * Lists the published `short` and `cloze` versions whose regex patterns the
 * RE2 engine refuses (`regexAudit.ts`, security audit H3). Read-only.
 *
 *   pnpm --filter @quiz/api regex:audit          # DATABASE_URL of ../../.env
 *
 * In the production image it is compiled with the API, like `seed.ts`, and
 * runs with plain Node: `node dist/regex-audit.js` (from `/app`), against the
 * `DATABASE_URL` of the environment.
 *
 * Exit status: 0 nothing refused; 2 at least one pattern listed; 1 error.
 */
import { parseArgs } from "node:util";

import { createDb } from "./db/client.js";
import { auditRegexPatterns, formatRegexAudit } from "./regexAudit.js";

async function main() {
  const { values } = parseArgs({ options: { help: { type: "boolean" } } });
  if (values.help) {
    console.log("usage: regex-audit   (reads DATABASE_URL; lists the regex patterns RE2 refuses, writes nothing)");
    return;
  }
  const handle = createDb(process.env.DATABASE_URL ?? "pglite://.data/pglite");
  try {
    const audit = await auditRegexPatterns(handle.db);
    console.log(formatRegexAudit(audit));
    if (audit.findings.length > 0) process.exitCode = 2;
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
