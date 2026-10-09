/**
 * Imports heig-classroom's data into Quiz (ADR-035, merge tasks M1-06 and
 * M8-01; docs/merge/02-data-and-migration.md §2.5). Complete only when every
 * part of M8-01 has landed; until then it switches nothing (spec 06 no. 45:
 * the complete import is the switch).
 *
 *   pnpm --filter @quiz/api import:classroom \
 *     --source-db hgc_cutover --mapping mapping.json \
 *     --actor admin@heig-vd.ch [--dry-run | --apply] [--final] \
 *     [--report-json report.json] [--window-hours 24] \
 *     [--assistants skip|staff] [--missing-students report|enroll]
 *
 * In the production image it is compiled with the API, like `seed.ts`, and
 * runs with plain Node, nothing fetched: `node dist/import-classroom.js …`
 * (from `/app`). `--help` prints the usage and exits 0 before reading any
 * configuration, which CI uses to prove the image carries it.
 *
 * The target is the `DATABASE_URL` of the environment, as for the API; the
 * source is the database `--source-db` names on the same server, reached
 * with the same credentials (`sourceUrl`), so no secret is ever on argv. A dry
 * run (the default) does every write in a transaction it rolls back, and
 * prints the full report. `--apply` refuses while the report has a refusal
 * (`run.ts`). `--final` marks the cutover import, which also enforces the
 * source-state pre-flight (`preflight.ts`). `--report-json` writes the report
 * as JSON (it names people: keep it off shared places).
 *
 * Exit status: 0 clean; 1 error; 2 refused; 3 red lines in the parity report
 * (an `--apply` that finds one wrote nothing).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import type { FastifyInstance } from "fastify";

import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { githubApp } from "./github/app.js";
import { ingestJournal } from "./modules/journal/ingest.js";
import { createDb } from "./db/client.js";
import { ClassroomMapping } from "./import-classroom/mapping.js";
import { formatReport, runImport, type ImportOptions } from "./import-classroom/run.js";
import { openSource, readSnapshot, sourceUrl } from "./import-classroom/source.js";

const USAGE =
  "usage: import-classroom --source-db <database on the server of DATABASE_URL> --mapping <file.json> --actor <admin e-mail> " +
  "[--dry-run | --apply] [--final] [--report-json <file>] [--window-hours <n>] " +
  "[--assistants skip|staff] [--missing-students report|enroll]";

function choice<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${flag}: one of ${allowed.join(", ")}`);
  return value as T;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "source-db": { type: "string" },
      mapping: { type: "string" },
      actor: { type: "string" },
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      assistants: { type: "string" },
      "missing-students": { type: "string" },
      final: { type: "boolean" },
      "report-json": { type: "string" },
      "window-hours": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values["source-db"] || !values.mapping || !values.actor) throw new Error(USAGE);
  if (values.apply && values["dry-run"]) throw new Error("--dry-run and --apply exclude each other");

  const raw = readFileSync(values.mapping);
  const parsed = ClassroomMapping.safeParse(JSON.parse(raw.toString("utf8")));
  if (!parsed.success) throw new Error(`${values.mapping}: ${parsed.error.message}`);

  const options: ImportOptions = {
    apply: values.apply === true,
    actorEmail: values.actor,
    mappingSha256: createHash("sha256").update(raw).digest("hex"),
    final: values.final === true,
  };
  if (values["window-hours"] !== undefined) {
    const hours = Number(values["window-hours"]);
    if (!Number.isFinite(hours) || hours < 0) throw new Error("--window-hours: a number of hours, 0 or more");
    options.windowHours = hours;
  }
  const assistants = choice(values.assistants, ["skip", "staff"], "--assistants");
  const missingStudents = choice(values["missing-students"], ["report", "enroll"], "--missing-students");
  if (assistants) options.assistants = assistants;
  if (missingStudents) options.missingStudents = missingStudents;

  const config = loadConfig();
  const source = await openSource(sourceUrl(config.DATABASE_URL, values["source-db"]));
  const target = createDb(config.DATABASE_URL);
  try {
    // The journal module's own ingestion over the target database, as the queue's worker runs it (no queue here: `boss` unset).
    if (githubApp(config)) {
      const quiet = (message: string, detail?: unknown) => console.error(message, detail ?? "");
      const app = {
        db: target.db,
        clock: systemClock,
        log: { warn: (detail: unknown, message?: string) => quiet(message ?? "", detail) },
      } as unknown as FastifyInstance;
      options.ingestJournal = (classroomId) => ingestJournal(app, config, classroomId);
    }
    const snapshot = await readSnapshot(source.query);
    const report = await runImport(target.db, config, snapshot, parsed.data, options);
    console.log(formatReport(report));
    if (values["report-json"]) writeFileSync(values["report-json"], `${JSON.stringify(report, null, 2)}\n`);
    if (report.outcome === "refused") process.exitCode = 2;
    else if (report.parity.redLines.length > 0) process.exitCode = 3;
  } finally {
    await source.close();
    await target.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
