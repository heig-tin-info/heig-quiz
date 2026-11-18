/**
 * The names both `project.ts` and `codespace.ts` need — a commit id, a
 * repository's name and full name, a path inside a repository, a branch,
 * what a message to the students never holds — one schema each, here
 * because the second is imported by the first, so neither can own them.
 */
import { z } from "zod";

/** A full SHA-1 object id, as GitHub names a commit or a tree: 40 lowercase hex digits. */
export const Sha1 = z.string().regex(/^[0-9a-f]{40}$/, "a full SHA-1 expected");

/** A repository's name in the organization: a name, never a path nor an owner. */
export const RepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => name !== "." && name !== "..", "not a repository name");

/** An organization's login on GitHub: letters, digits and inner hyphens, 39 at most. */
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** `owner/name` as GitHub names a repository: an organization's login, then a {@link RepoName}. */
export const RepositoryFullName = z.string().refine((full) => {
  const [owner, name, ...rest] = full.split("/");
  return rest.length === 0 && owner !== undefined && GITHUB_OWNER.test(owner) && RepoName.safeParse(name).success;
}, "repository expected in the form owner/name");

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

/**
 * A branch to hand out: what `git check-ref-format --branch` accepts, minus
 * what could read as an option (a leading `-`).
 */
export const BranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (b) =>
      !b.startsWith("-") &&
      !b.endsWith(".lock") &&
      !b.includes("..") &&
      b.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".")),
    "not a branch name",
  );

/**
 * What a message to the students never holds (ADR-132 §10): the C0 controls
 * but tab and line feed, DEL, the C1 controls, and the bidirectional
 * overrides and isolates — `CONTROL_CHAR` of `journal.ts`, widened. A NUL
 * would fail the database's write after the distribution moved.
 */
// eslint-disable-next-line no-control-regex
export const MESSAGE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
