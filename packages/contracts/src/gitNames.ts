/**
 * The names that reach git or GitHub, one schema per notion: a commit id, a
 * repository's name and full name, a path inside a repository. `project.ts`
 * and `codespace.ts` both read them from here (the second is imported by the
 * first, so neither can own them).
 */
import { z } from "zod";

/** A full SHA-1 object id, as GitHub names a commit or a tree: 40 lowercase hex digits. */
export const Sha1 = z.string().regex(/^[0-9a-f]{40}$/, "a full SHA-1 expected");

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const notDots = (name: string) => name !== "." && name !== "..";

/** A repository's name in the organization: a name, never a path nor an owner. */
export const RepoName = z.string().regex(REPO_NAME).refine(notDots, "not a repository name");

/**
 * `owner/name` as GitHub names a repository: an organization's login (letters,
 * digits, inner hyphens, 39 at most), then a {@link RepoName}.
 */
export const RepositoryFullName = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "repository expected in the form owner/name")
  .refine((full) => notDots(full.slice(full.indexOf("/") + 1)), "not a repository name");

/**
 * A path inside a repository, never out of it and never read as an option:
 * relative, its segments neither empty nor `.` nor `..` nor `.git`, no
 * leading `-`, no backslash and no control character.
 */
export const ProtectedPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) =>
      !p.startsWith("-") &&
      !/[\u0000-\u001f\u007f\\]/.test(p) &&
      p.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
    "not a relative path",
  );
