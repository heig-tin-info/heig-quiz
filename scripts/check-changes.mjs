#!/usr/bin/env node
// The changelog guard (ADR-087), run by the `checks` job of
// .github/workflows/ci.yml on every pull request, prose-only ones included:
// every entry under changes/ must parse, and, with `--base <ref>`, the
// branch must ADD an entry and may not RENAME one (the slug is the entry's
// identity in the database). Deleting an entry is allowed.
//
//   node scripts/check-changes.mjs                      # validate only
//   node scripts/check-changes.mjs --base origin/main   # and the diff
//
// The diff runs from the merge base to the working tree, untracked files
// counted as added, so a branch is checked before it is committed.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readEntries } from './changes.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const isEntry = (path) => /^changes\/[^/]+\.md$/.test(path) && path !== 'changes/README.md';

const fail = (message) => {
  console.error(message);
  console.error('See changes/README.md (ADR-087).');
  process.exit(1);
};

let entries;
try {
  entries = readEntries(new URL('../changes/', import.meta.url));
} catch (error) {
  fail(error.message);
}

const at = process.argv.indexOf('--base');
if (at >= 0) {
  const base = process.argv[at + 1];
  if (!base) fail('--base needs a git ref.');
  const from = git('merge-base', base, 'HEAD').trim();
  const added = [];
  const renamed = [];
  for (const line of git('diff', '--name-status', '-M', from, '--', 'changes/').split('\n')) {
    const [status = '', path, to] = line.split('\t');
    if (status.startsWith('R') && isEntry(path)) renamed.push(`${path} -> ${to}`);
    else if ((status === 'A' || status.startsWith('R')) && isEntry(to ?? path)) added.push(to ?? path);
  }
  added.push(...git('ls-files', '--others', '--exclude-standard', '--', 'changes/').split('\n').filter(isEntry));
  if (renamed.length > 0) fail(`An entry's file name is its identity and never changes; renamed: ${renamed.join(', ')}`);
  if (added.length === 0) fail('This branch adds no changes/<slug>.md entry (audience `none` is allowed).');
  console.log(`changes/: ${entries.length} entries valid; added: ${added.join(', ')}.`);
} else {
  console.log(`changes/: ${entries.length} entries valid.`);
}
