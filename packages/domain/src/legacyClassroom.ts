/**
 * The pure half of the legacy URL resolver (merge task M8-02, spec
 * docs/merge/06 §6.6): what an old `classroom.chevallier.io` path MEANS.
 * Caddy hands every human-clicked path to Quiz as
 * `/legacy/classroom<old path>`; this module reads the old path and names
 * the rule that applies, with the old ids it carries. It never looks an id
 * up and never builds a Quiz URL for an entity: the `legacy` module of the
 * API resolves the ids through the import's id map and loads the entity
 * under `staffAccess` (invariant 6). Nothing here reaches a database.
 *
 * An id that is not a UUID can match no row: it is `not_found`, as a
 * well-formed id nobody holds is. A path no row of §6.6 names falls to the
 * fragment's last line, Quiz's home.
 */

/** What one old path asks for. */
export type LegacyRule =
  /** A fixed Quiz path: `/settings`, `/admin`, `/`. */
  | { kind: "redirect"; to: string }
  /** A dead API: 410, with the Quiz home as the place to go. */
  | { kind: "gone" }
  /** `/classrooms/:id` and every sub-page of it that has no row of its own. */
  | { kind: "classroom"; classroomId: string }
  /** `/classrooms/:id/assignments/:aid` (the classroom id is not read: the assignment id decides). */
  | { kind: "project"; assignmentId: string }
  /** `/classrooms/:id/assignments/:aid/groups`. */
  | { kind: "groups"; assignmentId: string }
  /** `/classrooms/:cid/journal/<path>`; `path` is the raw remainder, to be vetted by `safeJournalPath` (empty: the journal's home). */
  | { kind: "journal"; classroomId: string; path: string }
  /** `/app/codespace/start/:aid` (the old `.seb` startURL). */
  | { kind: "start"; assignmentId: string }
  /** `/app/api/users/:uid/avatar`. */
  | { kind: "avatar"; userId: string }
  /** A malformed id under a known prefix: indistinguishable from a missing entity. */
  | { kind: "not_found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (s: string | undefined): s is string => s !== undefined && UUID.test(s);

/** Quiz's home: the landing of a fixed row, of an unknown path and of a 410. */
export const LEGACY_HOME = "/";

/**
 * The rule of one old path (the part after `/legacy/classroom`, a query
 * already removed). Case matters, as in the old router; a trailing slash
 * does not.
 */
export function legacyRule(path: string): LegacyRule {
  const parts = path.split("/").filter((s) => s !== "");
  const [a, b, c, d, e] = parts;

  // Dead APIs and machines' endpoints.
  if (a === "webhooks" && b === "github") return { kind: "gone" };
  if (a === "kc" || a === "healthz" || a === "metrics") return { kind: "gone" };

  if (a === "app") {
    if (b === "auth") return { kind: "redirect", to: c === "github" && d === "callback" ? "/settings" : LEGACY_HOME };
    if (b === "email" && c === "unsub") return { kind: "redirect", to: "/settings" };
    if (b === "events") return { kind: "gone" };
    if (b === "codespace" && c === "start") {
      return isId(d) && parts.length === 4 ? { kind: "start", assignmentId: d } : { kind: "not_found" };
    }
    if (b === "api") {
      // `/app/api/journals/:jid/assets/*`: a journal id is not kept (D03).
      if (c === "users" && e === "avatar" && parts.length === 5) {
        return isId(d) ? { kind: "avatar", userId: d } : { kind: "gone" };
      }
      return { kind: "gone" };
    }
  }

  if (a === "settings" && parts.length === 1) return { kind: "redirect", to: "/settings" };
  if (a === "admin") return { kind: "redirect", to: "/admin" };

  if (a === "classrooms" && b !== undefined) {
    if (!isId(b)) return { kind: "not_found" };
    if (c === "assignments" && d !== undefined) {
      if (!isId(d)) return { kind: "not_found" };
      if (e === "groups") return { kind: "groups", assignmentId: d };
      return { kind: "project", assignmentId: d };
    }
    if (c === "journal") return { kind: "journal", classroomId: b, path: parts.slice(3).join("/") };
    return { kind: "classroom", classroomId: b };
  }

  // Every other path, `/`, `/setup/github/installed` and `/app/auth/*` among them: the home.
  return { kind: "redirect", to: LEGACY_HOME };
}
