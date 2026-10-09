// Bundles the changelog (ADR-087) into `dist/changelog.json`, the artifact
// the server reads: the last step of `pnpm --filter @quiz/api build`. Plain
// Node, because its parser is the dependency-free `scripts/changes.mjs` that
// the `checks` job runs too. The bundle is then checked against the schema
// the server reads it with (`ChangelogSource`, @quiz/contracts' build), so a
// drift between the two fails here, not at boot. An invalid entry fails the
// build. The entries of audience `none` are nobody's and stay out.
import { mkdirSync, writeFileSync } from "node:fs";

import { ChangelogSource } from "@quiz/contracts";

import { readEntries } from "../../../scripts/changes.mjs";

const entries = ChangelogSource.array().parse(
  readEntries(new URL("../../../changes/", import.meta.url)).filter((e) => e.audience !== "none"),
);
const out = new URL("../dist/changelog.json", import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, JSON.stringify(entries));
console.log(`changelog: ${entries.length} entries → dist/changelog.json`);
