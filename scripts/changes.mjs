// The changelog entries of `changes/<slug>.md` (ADR-087): one file per pull
// request, frontmatter only. The ONE parser of the format, with no
// dependency, read by the `checks` job (`scripts/check-changes.mjs`) and by
// the API's build (`apps/api/scripts/changelog.mjs`, which writes
// `dist/changelog.json`). The format is `changes/README.md`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AUDIENCES = ['student', 'teacher', 'none'];
export const KINDS = ['new', 'changed', 'moved', 'deprecated', 'removed'];
/** The file name without `.md`: the entry's identity, immutable once merged. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** One short sentence or two, read in a dialog. */
export const MAX_TEXT = 300;

const KEYS = ['audience', 'kind', 'en', 'fr'];

/** A value: `"…"` (JSON escapes), `'…'` (`''` for a quote), or bare text with an optional ` # comment`. */
function valueOf(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw new Error('unterminated quote');
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw.replace(/\s+#.*$/, '');
}

/**
 * The `key: value` fields of a frontmatter-only file, and the problems of its
 * SHAPE (no block, a stray line, a key unknown or repeated, a bad quote).
 */
export function frontmatter(text) {
  const problems = [];
  const fields = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) {
    return { fields, problems: ['the file must be a frontmatter block between two `---` lines'] };
  }
  if (lines.slice(end + 1).some((l) => l.trim() !== '')) problems.push('nothing may follow the frontmatter');
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (!m) {
      problems.push(`not a \`key: value\` line: ${line}`);
      continue;
    }
    const [, key, raw] = m;
    if (!KEYS.includes(key)) problems.push(`unknown key \`${key}\``);
    else if (key in fields) problems.push(`\`${key}\` appears twice`);
    else {
      try {
        fields[key] = valueOf(raw).trim();
      } catch {
        problems.push(`\`${key}\`: badly quoted value`);
      }
    }
  }
  return { fields, problems };
}

/** The problems of an entry's CONTENT: its slug and its fields. Audience `none` may omit the texts. */
export function validate(slug, { audience, kind, en, fr }) {
  const problems = [];
  if (!SLUG.test(slug)) problems.push('the file name must be lower-case words joined by hyphens');
  if (!AUDIENCES.includes(audience)) problems.push(`\`audience\` must be one of ${AUDIENCES.join(', ')}`);
  if (!KINDS.includes(kind)) problems.push(`\`kind\` must be one of ${KINDS.join(', ')}`);
  for (const [key, value] of [['en', en], ['fr', fr]]) {
    if (value === undefined || value === '') {
      if (audience !== 'none') problems.push(`\`${key}\` is required unless the audience is none`);
    } else if (value.length > MAX_TEXT) problems.push(`\`${key}\` is longer than ${MAX_TEXT} characters`);
    else if (/<[a-zA-Z/!]/.test(value)) problems.push(`\`${key}\` holds raw HTML; write markdown`);
  }
  return problems;
}

/** The entry of `changes/<slug>.md`, or an Error listing every problem of the file. */
export function parseEntry(slug, text) {
  const { fields, problems } = frontmatter(text);
  problems.push(...validate(slug, fields));
  if (problems.length > 0) return new Error(`changes/${slug}.md: ${problems.join('; ')}`);
  const { audience, kind, en = '', fr = '' } = fields;
  return { id: slug, audience, kind, en, fr };
}

/** Every entry of `dir` (a path or a file URL; README.md aside), by id; throws one Error naming every invalid file. */
export function readEntries(at) {
  const dir = at instanceof URL ? fileURLToPath(at) : at;
  const parsed = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => parseEntry(f.slice(0, -3), readFileSync(join(dir, f), 'utf8')));
  const errors = parsed.filter((p) => p instanceof Error);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('\n'));
  return parsed;
}
