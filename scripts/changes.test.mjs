// `node --test scripts/` — the parser of changes/<slug>.md (ADR-087).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseEntry, readEntries } from './changes.mjs';

const file = (...lines) => ['---', ...lines, '---', ''].join('\n');
const problems = (slug, text) => {
  const result = parseEntry(slug, text);
  assert.ok(result instanceof Error, 'expected a refusal');
  return result.message;
};

test('a valid entry, with a comment, a quoted value and inline markdown', () => {
  const entry = parseEntry(
    'course-settings',
    file(
      'audience: teacher     # student | teacher | none',
      'kind: moved',
      'en: Evaluation conditions now live in the course **Settings**.',
      `fr: 'Les conditions d''évaluation # sont dans les Réglages.'`,
    ),
  );
  assert.deepEqual(entry, {
    id: 'course-settings',
    audience: 'teacher',
    kind: 'moved',
    en: 'Evaluation conditions now live in the course **Settings**.',
    fr: "Les conditions d'évaluation # sont dans les Réglages.",
  });
});

test('a missing fr is refused unless the audience is none', () => {
  assert.match(problems('x', file('audience: student', 'kind: new', 'en: Hello.')), /`fr` is required/);
  assert.deepEqual(parseEntry('x', file('audience: none', 'kind: changed')), {
    id: 'x',
    audience: 'none',
    kind: 'changed',
    en: '',
    fr: '',
  });
});

test('a bad audience, kind, key, slug, body or raw HTML is refused, every problem named', () => {
  const message = problems(
    'Bad_Slug',
    file('audience: everyone', 'kind: fixed', 'title: x', 'en: <b>Hi</b>', 'fr: Salut.') + 'body\n',
  );
  for (const expected of [/file name/, /`audience` must be/, /`kind` must be/, /unknown key `title`/, /raw HTML/, /nothing may follow/]) {
    assert.match(message, expected);
  }
  assert.match(problems('x', 'audience: student\n'), /frontmatter block/);
  assert.match(problems('x', file('audience: none', 'audience: none', 'kind: new')), /appears twice/);
});

test('the repository entries all parse', () => {
  assert.ok(readEntries(new URL('../changes/', import.meta.url)).length > 0);
});
