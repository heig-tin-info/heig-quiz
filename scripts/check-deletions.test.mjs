// `node --test scripts/` — the history guard (scripts/check-deletions.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deletedKept, lostJournalTags } from './check-deletions.mjs';

test('a deleted or renamed migration or snapshot and a deleted ADR are reported; other deletions are not', () => {
  const diff = [
    'D\tapps/api/drizzle/0111_presence.sql',
    'D\tapps/api/drizzle/meta/0111_snapshot.json',
    'R100\tapps/api/drizzle/0110_seats.sql\tapps/api/drizzle/0110_staff_seats.sql',
    'D\tdocs/adr/ADR-107-activite.md',
    'D\tapps/api/src/modules/presence/service.ts',
    'D\tchanges/admin-activity.md',
    'M\tapps/api/drizzle/meta/_journal.json',
    'A\tapps/api/drizzle/0112_item_counting.sql',
  ].join('\n');
  assert.deepEqual(deletedKept(diff), [
    'apps/api/drizzle/0111_presence.sql',
    'apps/api/drizzle/meta/0111_snapshot.json',
    'apps/api/drizzle/0110_seats.sql',
    'docs/adr/ADR-107-activite.md',
  ]);
});

test('an ADR renumbered to another ADR path is a move, not a loss; a move out of docs/adr is', () => {
  const moved = 'R098\tdocs/adr/ADR-119-code-de-cours-non-unique.md\tdocs/adr/ADR-120-code-de-cours-non-unique.md';
  assert.deepEqual(deletedKept(moved), []);
  const out = 'R100\tdocs/adr/ADR-119-code-de-cours-non-unique.md\tdocs/history/ADR-119.md';
  assert.deepEqual(deletedKept(out), ['docs/adr/ADR-119-code-de-cours-non-unique.md']);
});

test('a journal entry the base has and the branch lacks is reported', () => {
  const journal = (...tags) => JSON.stringify({ entries: tags.map((tag) => ({ tag })) });
  assert.deepEqual(lostJournalTags(journal('0110_a', '0111_b'), journal('0110_a', '0112_c')), ['0111_b']);
  assert.deepEqual(lostJournalTags(journal('0110_a'), journal('0110_a', '0111_b')), []);
  assert.deepEqual(lostJournalTags('', journal('0110_a')), []);
});
