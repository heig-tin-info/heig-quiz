#!/usr/bin/env node
// The history guard, run by the `checks` job of .github/workflows/ci.yml on
// every pull request: a branch never deletes a database migration, a
// migration snapshot, an entry of the migrations' journal or an ADR. These
// only ever grow; a branch whose tree lost them was committed on a stale
// index (#806 squashed onto a moved origin/main and erased #800 whole).
//
//   node scripts/check-deletions.mjs --base origin/main
//
// The diff runs from the merge base to HEAD.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const KEPT = [/^apps\/api\/drizzle\/[^/]+\.sql$/, /^apps\/api\/drizzle\/meta\/\d+_snapshot\.json$/, /^docs\/adr\/ADR-\d+-[^/]+\.md$/];
const JOURNAL = 'apps/api/drizzle/meta/_journal.json';

export function deletedKept(nameStatus) {
  return nameStatus
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([status, path]) => (status === 'D' || status?.startsWith('R')) && KEPT.some((re) => re.test(path)))
    .map(([, path]) => path);
}

export function lostJournalTags(before, after) {
  const tags = (text) => new Set(text ? JSON.parse(text).entries.map((e) => e.tag) : []);
  const kept = tags(after);
  return [...tags(before)].filter((tag) => !kept.has(tag));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const at = process.argv.indexOf('--base');
  const base = at >= 0 ? process.argv[at + 1] : null;
  if (!base) {
    console.error('Usage: node scripts/check-deletions.mjs --base <ref>');
    process.exit(1);
  }
  const from = git('merge-base', base, 'HEAD').trim();
  const show = (ref) => {
    try {
      return git('show', `${ref}:${JOURNAL}`);
    } catch {
      return '';
    }
  };
  const lost = [
    ...deletedKept(git('diff', '--name-status', '-M', from, 'HEAD')),
    ...lostJournalTags(show(from), show('HEAD')).map((tag) => `${JOURNAL} entry ${tag}`),
  ];
  if (lost.length > 0) {
    console.error(`This branch deletes what never goes away:\n  ${lost.join('\n  ')}`);
    console.error('A tree that lost them was usually committed on a stale index: rebase onto the base instead (AGENTS.md §2).');
    process.exit(1);
  }
  console.log('Migrations, their journal and the ADRs: nothing deleted.');
}
