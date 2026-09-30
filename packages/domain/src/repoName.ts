/**
 * How the platform names the repositories it creates in a GitHub
 * organization (ported from classroom's `repoName.ts` and `slugify`).
 *
 * One organization holds every classroom of a course, often over several
 * years, so a name that only says what a repository IS collides: two
 * classrooms with the same project slug both want `labo-01-group-1`. Every
 * name is therefore `<what discriminates>-<what it is>`, capped at GitHub's
 * limit, with a DETERMINISTIC disambiguator appended when the name is
 * already taken — a random suffix would leave a second orphan repository
 * behind every retry of a creation that failed halfway.
 *
 * The journal's repository name is built on `repoName` by
 * `packages/docrender` (M4-01), not here.
 */

/** GitHub refuses a repository name longer than 100 characters. */
export const GITHUB_REPO_NAME_MAX = 100;

/** The longest slug `slugify` returns, so that two slugs and a suffix fit in a name. */
export const SLUG_MAX = 60;

/**
 * Repository-name slug of a free-text name: accents folded, everything else
 * collapsed to single dashes, capped at `SLUG_MAX` characters. Returns ""
 * when the name has no usable character.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

/**
 * `stem` with `disambiguator` appended, capped. The tail survives the cap and
 * the stem is truncated from the right: the disambiguator is the part that
 * makes the name unique, so cutting it would defeat its purpose. A trailing
 * dash left by the cut is dropped — `labo-01-group` is free and prettier than
 * `labo-01-group-`.
 */
export function repoName(stem: string, disambiguator?: string): string {
  const tail = disambiguator ? `-${disambiguator}` : "";
  const head = stem.slice(0, GITHUB_REPO_NAME_MAX - tail.length).replace(/-+$/, "");
  return `${head}${tail}`;
}
