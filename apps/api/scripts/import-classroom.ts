/**
 * Imports heig-classroom's people and rosters into Quiz (ADR-035, merge task
 * M1-06; docs/merge/02-data-and-migration.md §2.5). M8-01 completes it with
 * projects, journals, webhooks and the legacy audit; until then it switches
 * nothing (spec 06 no. 45: the import, once complete, is the switch).
 *
 *   pnpm --filter @quiz/api import:classroom \
 *     --source postgres://reader@…/hgc --mapping mapping.json \
 *     --actor admin@heig-vd.ch [--dry-run | --apply] \
 *     [--assistants staff|skip] [--missing-students enroll|report]
 *
 * The target is the `DATABASE_URL` of the environment, as for the API. A dry
 * run (the default) does every write in a transaction it rolls back, and
 * prints the report. `--apply` refuses while the report has a refusal or an
 * open decision is not given (`run.ts`, `OpenDecisions`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { ClassroomMapping } from "./import-classroom/mapping.js";
import { formatReport, runImport, type ImportOptions } from "./import-classroom/run.js";
import { openSource, readSnapshot } from "./import-classroom/source.js";

const USAGE =
  "usage: import-classroom --source <classroom DATABASE_URL> --mapping <file.json> --actor <admin e-mail> " +
  "[--dry-run | --apply] [--assistants staff|skip] [--missing-students enroll|report]";

function choice<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${flag}: one of ${allowed.join(", ")}`);
  return value as T;
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      mapping: { type: "string" },
      actor: { type: "string" },
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      assistants: { type: "string" },
      "missing-students": { type: "string" },
    },
    strict: true,
  });
  if (!values.source || !values.mapping || !values.actor) throw new Error(USAGE);
  if (values.apply && values["dry-run"]) throw new Error("--dry-run and --apply exclude each other");

  const raw = readFileSync(values.mapping);
  const parsed = ClassroomMapping.safeParse(JSON.parse(raw.toString("utf8")));
  if (!parsed.success) throw new Error(`${values.mapping}: ${parsed.error.message}`);

  const options: ImportOptions = {
    apply: values.apply === true,
    actorEmail: values.actor,
    mappingSha256: createHash("sha256").update(raw).digest("hex"),
  };
  const assistants = choice(values.assistants, ["staff", "skip"], "--assistants");
  const missingStudents = choice(values["missing-students"], ["enroll", "report"], "--missing-students");
  if (assistants) options.assistants = assistants;
  if (missingStudents) options.missingStudents = missingStudents;

  const config = loadConfig();
  const source = await openSource(values.source);
  const target = createDb(config.DATABASE_URL);
  try {
    const snapshot = await readSnapshot(source.query);
    const report = await runImport(target.db, config, snapshot, parsed.data, options);
    console.log(formatReport(report));
    if (report.outcome === "refused") process.exitCode = 2;
  } finally {
    await source.close();
    await target.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
