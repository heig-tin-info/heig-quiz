#!/usr/bin/env node
/**
 * The coverage of every workspace package against its floor.
 *
 * `pnpm test:coverage` leaves one `coverage/coverage-summary.json` per package
 * (vitest.shared.ts). This script reads them, prints one Markdown table (to
 * `$GITHUB_STEP_SUMMARY` too on CI) and fails when a package falls under its
 * floor in coverage.floors.json, when a package ran without a floor, or when
 * a floor has no report. The floors are a ratchet: `--ratchet` raises each
 * one to the whole percentage the run reached, and never lowers one.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const floorsFile = join(root, "coverage.floors.json");
const METRICS = ["lines", "branches", "functions"];

const floors = JSON.parse(readFileSync(floorsFile, "utf8"));
const reports = {};
for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(join(root, group))) {
    const file = join(root, group, name, "coverage", "coverage-summary.json");
    if (existsSync(file)) reports[`${group}/${name}`] = JSON.parse(readFileSync(file, "utf8")).total;
  }
}

const failures = [];
const rows = [];
for (const pkg of [...new Set([...Object.keys(floors), ...Object.keys(reports)])].sort()) {
  const total = reports[pkg];
  const floor = floors[pkg];
  if (!total) {
    failures.push(`${pkg}: a floor but no coverage report`);
    continue;
  }
  if (!floor) failures.push(`${pkg}: no floor in coverage.floors.json`);
  const cells = METRICS.map((m) => {
    const pct = total[m].pct;
    const min = floor?.[m];
    if (min !== undefined && pct < min) failures.push(`${pkg}: ${m} ${pct}% < floor ${min}%`);
    return `${pct.toFixed(1)}%${min !== undefined ? ` (≥ ${min})` : ""}${min !== undefined && pct < min ? " ❌" : ""}`;
  });
  rows.push(`| \`${pkg}\` | ${cells.join(" | ")} | ${total.lines.total} |`);
}

const table = [
  "## Coverage",
  "",
  "| Package | Lines | Branches | Functions | Measured lines |",
  "| --- | --- | --- | --- | --- |",
  ...rows,
  "",
  ...(failures.length ? ["**Failures**", "", ...failures.map((f) => `- ${f}`), ""] : []),
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);

if (process.argv.includes("--ratchet")) {
  const next = { ...floors };
  for (const [pkg, total] of Object.entries(reports)) {
    next[pkg] = Object.fromEntries(
      METRICS.map((m) => [m, Math.max(floors[pkg]?.[m] ?? 0, Math.floor(total[m].pct))]),
    );
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(floorsFile, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`\n${floorsFile} ratcheted.`);
} else if (failures.length) {
  process.exit(1);
}
