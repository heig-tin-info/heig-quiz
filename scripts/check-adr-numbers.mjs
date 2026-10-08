#!/usr/bin/env node
// Fails when two records in docs/adr/ share an `ADR-NNN-` prefix (#342).
// Parallel branches each pick "the next free number" from their own base, so
// a collision only shows once both have merged. Run by the `checks` job of
// .github/workflows/ci.yml, which runs on every pull request, prose-only ones
// included. No dependency: `node scripts/check-adr-numbers.mjs`.
import { readdirSync } from 'node:fs';

const dir = new URL('../docs/adr/', import.meta.url);
const byNumber = new Map();
for (const name of readdirSync(dir)) {
  const match = /^ADR-(\d+)-/.exec(name);
  if (!match) continue;
  const number = Number(match[1]);
  byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
}

const duplicates = [...byNumber].filter(([, names]) => names.length > 1);
for (const [number, names] of duplicates) {
  console.error(`ADR-${String(number).padStart(3, '0')} is used by: ${names.join(', ')}`);
}
if (duplicates.length > 0) {
  console.error('Renumber the later record to the next free number (AGENTS.md, ADR numbers).');
  process.exit(1);
}
console.log(`docs/adr: ${byNumber.size} records, no shared number.`);
