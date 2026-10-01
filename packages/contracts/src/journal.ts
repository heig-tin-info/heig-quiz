/**
 * The journal's routes (docs/merge/04-journal.md §4.1 as amended by D03, D24
 * and D27; spec 05 §5.11): base `/app/api/classrooms/:id/journal`, one
 * journal per classroom, so no journal id anywhere.
 *
 * Two payload families, told apart by a `view` literal:
 *   - `student` — the journal's one exit towards a student (N-SEC-12). Its
 *     objects are STRICT and structurally lack the markdown, the blob sha,
 *     the warnings, the draft flag, the visibility date and every count of
 *     what is hidden: a staff payload cannot be assigned to a student type
 *     (the literals differ), and one parsed as a student payload is refused.
 *   - `staff` — everything, for the course's staff in the teacher's view.
 *
 * Warnings are CODES with parameters (fix J5), translated by the web app.
 *
 * The read half (what M4-02 serves and M4-04 reads) comes first; the write
 * half (M4-03: create, use, preview, save, add, upload, and the refusals)
 * closes the file. Refresh has no body either way: 202, the outcome is the
 * row's `syncStatus` after the `journal` hint.
 */
import { z } from "zod";

import { GITHUB_REPO_NAME_MAX } from "@quiz/domain";

// ------------------------------------------------------------------ paths

/** Longest journal path the platform accepts (N-SEC-15). */
export const JOURNAL_PATH_MAX = 400;

/** An asset (image, handout) is copied into the platform up to this size (D14, F-JRN-11). */
export const JOURNAL_ASSET_MAX_BYTES = 5_000_000;

/**
 * The C0 control characters and DEL: the one definition, which a caller
 * that replaces them builds a global form of (`new RegExp(CONTROL_CHAR.source, "g")`).
 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Whether a string holds a control character (C0 or DEL): never part of a
 * journal path, and never let into a title or a warning parameter.
 */
export function hasControlChar(text: string): boolean {
  return CONTROL_CHAR.test(text);
}

/**
 * A path inside the journal's root (N-SEC-15), or null: no segment starting
 * with `.` (so no `..`, no `.`, and no repository furniture — `.github/`
 * workflows, `.gitignore` — which the copy never holds and a write must
 * never touch), no empty segment, no leading `/`, no backslash, no control
 * character, at most {@link JOURNAL_PATH_MAX} characters. The route
 * parameters are already URL-decoded by the router, so nothing is decoded
 * here; a percent-escape that would decode to `.`, `/` or a backslash
 * (`%2e`, `%2f`, `%5c`, in any case) is refused outright, so that no second
 * decoding downstream can ever turn the path into a traversal.
 */
export function safeJournalPath(raw: string): string | null {
  if (!raw || raw.length > JOURNAL_PATH_MAX) return null;
  if (raw.startsWith("/") || raw.includes("\\")) return null;
  if (hasControlChar(raw) || /%(2e|2f|5c)/i.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((p) => p === "" || p.startsWith("."))) return null;
  return raw;
}

/**
 * A journal path as a URL path: each segment encoded on its own, so a space,
 * an accent or a `#` survives and the slashes stay separators. The web app's
 * reader addresses (`/classrooms/:id/journal/<path>`) and the calls to the
 * journal's page and asset routes both write paths with it.
 */
export function encodeJournalPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** A page of the journal is a markdown file; any other file is an asset. */
export function isJournalPagePath(path: string): boolean {
  return /\.md$/i.test(path);
}

/** Any file of the journal, by its path relative to the journal's root. */
export const JournalPath = z
  .string()
  .refine((p) => safeJournalPath(p) !== null, { message: "Not a path inside the journal" });

/** A page: a journal path ending in `.md`. */
export const JournalPagePath = JournalPath.refine(isJournalPagePath, { message: "A page is a .md file" });

/** An asset: a journal path that is not a page. */
export const JournalAssetPath = JournalPath.refine((p) => !isJournalPagePath(p), {
  message: "An asset is not a .md file",
});

/** `/classrooms/:id/journal/pages/*`. */
export const JournalPageParams = z.object({ id: z.uuid(), "*": JournalPagePath });
export type JournalPageParams = z.infer<typeof JournalPageParams>;

/**
 * Where a classroom's journal assets are served (D03): the route registers
 * `JOURNAL_ASSETS_PATH(":id") + "/*"`, and the renderer builds the URL of one
 * asset on it, so the two cannot drift.
 */
export const JOURNAL_ASSETS_PATH = (classroomId: string) =>
  `/app/api/classrooms/${classroomId}/journal/assets`;

/** Content types served for the extensions a journal may carry. */
export const JOURNAL_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  pdf: "application/pdf",
  zip: "application/zip",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  py: "text/plain",
};

/**
 * The content type an asset is served with, from its extension; anything
 * unknown is `application/octet-stream` (downloaded, never rendered). An
 * upload must declare exactly this type (F-JRN-11, {@link JournalUploadHeaders}).
 */
export function assetContentType(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return JOURNAL_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * The headers of `POST /classrooms/:id/journal/assets/*`: the media type the
 * client declares, parameters dropped and lowercased. The route refuses one
 * that is not `assetContentType(path)` (415 `type_mismatch`); the editor
 * (M4-06) sends exactly that.
 */
export const JournalUploadHeaders = z.object({
  "content-type": z
    .string()
    .default("")
    .transform((t) => t.split(";")[0]!.trim().toLowerCase()),
});
export type JournalUploadHeaders = z.infer<typeof JournalUploadHeaders>;

/** `/classrooms/:id/journal/assets/*`. */
export const JournalAssetParams = z.object({ id: z.uuid(), "*": JournalAssetPath });
export type JournalAssetParams = z.infer<typeof JournalAssetParams>;

/**
 * `?view=student` on the reads: the staff ask for the student payload (a
 * teacher in the student view, ADR-018). It can only NARROW: a student
 * asking for nothing still gets the student payload, and there is no value
 * that widens (05 §5.7).
 */
export const JournalViewQuery = z.object({ view: z.literal("student").optional() });
export type JournalViewQuery = z.infer<typeof JournalViewQuery>;

// --------------------------------------------------------------- warnings

/**
 * What the author of a page should know; nothing here stops a page from
 * rendering. A closed union: a new code is a compile error on the web side
 * until it has its `en` and `fr` strings.
 *
 * - `front_matter_yaml` — the `---` block is not valid YAML (`line` when known);
 * - `front_matter_not_mapping` — it parses, but not as a list of keys;
 * - `visible_from_invalid` — `visible_from` is not a date (the page stays visible);
 * - `raw_html` — raw HTML was shown as text (once per page, D15);
 * - `external_image` — an image outside the repository was dropped;
 * - `target_missing` — a link or image resolves to nothing in the journal;
 * - `asset_too_large` — it resolves to a file over the size limit;
 * - `math_error` — a formula KaTeX refused, shown as code.
 */
export const JournalWarning = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("front_matter_yaml"), line: z.number().int().optional() }),
  z.strictObject({ code: z.literal("front_matter_not_mapping") }),
  z.strictObject({ code: z.literal("visible_from_invalid"), value: z.string() }),
  z.strictObject({ code: z.literal("raw_html") }),
  z.strictObject({ code: z.literal("external_image"), href: z.string() }),
  z.strictObject({ code: z.literal("target_missing"), href: z.string(), path: z.string() }),
  z.strictObject({ code: z.literal("asset_too_large"), href: z.string(), path: z.string() }),
  z.strictObject({ code: z.literal("math_error"), source: z.string() }),
]);
export type JournalWarning = z.infer<typeof JournalWarning>;
export type JournalWarningCode = JournalWarning["code"];

// ---------------------------------------------------------------- reading

/**
 * One heading of a page, for its table of contents. `text` is PLAIN TEXT
 * (what the reader sees, entities decoded), rendered as React text, never as
 * HTML.
 */
export const JournalTocEntry = z.strictObject({
  id: z.string(),
  depth: z.number().int().min(1).max(6),
  text: z.string(),
});
export type JournalTocEntry = z.infer<typeof JournalTocEntry>;

/** A node of the navigation: a page, or a section (a directory). */
export interface JournalNavNode {
  /** Path of the page, or of the directory for a section. */
  path: string;
  /** Plain text, rendered as React text; null when the file name gives none (the web words it). */
  title: string | null;
  /** The page opened by the entry; null for a section without a landing page. */
  pagePath: string | null;
  children: JournalNavNode[];
}
export const JournalNavNode: z.ZodType<JournalNavNode> = z.lazy(() =>
  z.strictObject({
    path: z.string(),
    title: z.string().nullable(),
    pagePath: z.string().nullable(),
    children: z.array(JournalNavNode),
  }),
);

/** The states of a classroom's copy of its repository. */
export const JOURNAL_SYNC_STATUSES = ["pending", "ok", "error"] as const;
export const JournalSyncStatus = z.enum(JOURNAL_SYNC_STATUSES);
export type JournalSyncStatus = z.infer<typeof JournalSyncStatus>;

/**
 * Why a synchronisation failed, as a code the web app words (invariant 1):
 * the repository, the branch or the root folder is gone, GitHub did not
 * answer, the tree is too large to copy, or the App may not read it. M4-02
 * may add codes.
 */
export const JournalSyncError = z.enum([
  "repo_not_found",
  "ref_not_found",
  "root_not_found",
  "github_unavailable",
  "too_large",
  "forbidden",
]);
export type JournalSyncError = z.infer<typeof JournalSyncError>;

/**
 * Where a journal's content lives, chosen when it is created (ADR-057, D29):
 *
 * - `quiz` — in Quiz itself: the database is the source of truth, edited in
 *   the platform; no GitHub needed;
 * - `github` — in a repository, edited there (VS Code, git, github.com): the
 *   platform holds a read-only copy and refuses every write of the content
 *   (`read_only`).
 */
export const JOURNAL_MODES = ["quiz", "github"] as const;
export const JournalMode = z.enum(JOURNAL_MODES);
export type JournalMode = z.infer<typeof JournalMode>;

/** The repository a classroom's journal mirrors, for the staff (GitHub mode only). */
export const JournalRepository = z.strictObject({
  /** `org/name`. */
  fullName: z.string(),
  /** The branch the copy follows. */
  ref: z.string(),
  /** The folder holding the pages, "" for the repository's root. */
  rootPath: z.string(),
  htmlUrl: z.string(),
  syncStatus: JournalSyncStatus,
  /** Why the last synchronisation failed, when it did. */
  syncError: JournalSyncError.nullable(),
  lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
  lastCommitSha: z.string().nullable(),
});
export type JournalRepository = z.infer<typeof JournalRepository>;

/** `GET /classrooms/:id/journal` for a student: the pages it would serve, nothing else. */
export const JournalStudent = z.strictObject({
  view: z.literal("student"),
  nav: z.array(JournalNavNode),
  homePath: z.string().nullable(),
});
export type JournalStudent = z.infer<typeof JournalStudent>;

/** `GET /classrooms/:id/journal` for the staff. */
export const JournalStaff = z.strictObject({
  view: z.literal("staff"),
  /** Where the content lives; null while the classroom has no journal. */
  mode: JournalMode.nullable(),
  /** The repository of a GitHub-mode journal; null otherwise. */
  repository: JournalRepository.nullable(),
  nav: z.array(JournalNavNode),
  homePath: z.string().nullable(),
  /** The pages students do not see yet (drafts, future `visible_from`). */
  hiddenPaths: z.array(z.string()),
  /** How many pages carry at least one warning. */
  warningCount: z.number().int().min(0),
  /**
   * How many pages the journal holds, hidden ones included: what removing a
   * Quiz-mode journal destroys, said in its confirmation (F-JRN-04).
   */
  pageCount: z.number().int().min(0),
  /** What "Create a journal" proposes (F-JRN-02); null once there is one. */
  proposedName: z.string().nullable(),
});
export type JournalStaff = z.infer<typeof JournalStaff>;

export const Journal = z.discriminatedUnion("view", [JournalStudent, JournalStaff]);
export type Journal = z.infer<typeof Journal>;

const pageFields = {
  path: z.string(),
  /** Plain text, rendered as React text, never as HTML; null when nothing names the page. */
  title: z.string().nullable(),
  /**
   * The rendered page. The student payload carries the student rendering, in
   * which a link to a page hidden from students is plain text.
   */
  html: z.string(),
  toc: z.array(JournalTocEntry),
  updatedAt: z.iso.datetime({ offset: true }),
};

/** `GET /classrooms/:id/journal/pages/*` for a student. */
export const JournalPageStudent = z.strictObject({ view: z.literal("student"), ...pageFields });
export type JournalPageStudent = z.infer<typeof JournalPageStudent>;

/** `GET /classrooms/:id/journal/pages/*` for the staff: the source and its lock too. */
export const JournalPageStaff = z.strictObject({
  view: z.literal("staff"),
  ...pageFields,
  draft: z.boolean(),
  visibleFrom: z.iso.datetime({ offset: true }).nullable(),
  /** Not served to students right now: a draft, or `visibleFrom` in the future. */
  hidden: z.boolean(),
  markdown: z.string(),
  /** The optimistic lock of a Quiz-mode save: its `baseVersion` (ADR-057). */
  version: z.number().int(),
  warnings: z.array(JournalWarning),
  /**
   * GitHub mode: github.com's editor of the page's file on the journal's
   * branch (`https://github.com/<org/name>/edit/<ref>/<root>/<path>`), the
   * one way to change it. Null in Quiz mode. Staff only: a student never
   * learns the repository.
   */
  editUrl: z.string().nullable(),
});
export type JournalPageStaff = z.infer<typeof JournalPageStaff>;

export const JournalPage = z.discriminatedUnion("view", [JournalPageStudent, JournalPageStaff]);
export type JournalPage = z.infer<typeof JournalPage>;

// ---------------------------------------------------------------- writing

/** The longest page a save or a preview accepts, in characters (F-JRN-10). */
export const JOURNAL_MARKDOWN_MAX = 500_000;

/**
 * A repository name as GitHub accepts it: letters, digits, `.`, `-`, `_`, at
 * most 100 characters, and never `.` nor `..` (which name no repository, and
 * would change the meaning of the URL they go into).
 */
export const GithubRepoName = z
  .string()
  .min(1)
  .max(GITHUB_REPO_NAME_MAX)
  .regex(/^[A-Za-z0-9._-]+$/, { message: "Letters, digits, '.', '-' and '_' only" })
  .refine((n) => n !== "." && n !== "..", { message: "Not a repository name" });

/**
 * A branch name, checked as git's `check-ref-format` would and then some: no
 * leading `-` (it would read as an option), no `..`, no empty segment (`//`,
 * a leading or trailing `/`), no segment starting with `.` (so `.` and `/./`
 * too), no `.lock` ending, no `@{`, no character git refuses (white space,
 * `~`, `^`, `:`, `?`, `*`, `[`, `\`, a control character).
 */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > 255 || ref.startsWith("-") || ref.endsWith(".lock")) return false;
  if (ref.includes("..") || ref.includes("@{") || /[\s~^:?*[\\]/.test(ref) || hasControlChar(ref)) return false;
  return ref.split("/").every((segment) => segment !== "" && !segment.startsWith("."));
}

export const GitRef = z.string().refine(isSafeGitRef, { message: "Not a branch name" });

/**
 * The folder of the repository holding the pages: trimmed of its surrounding
 * slashes, "" for the repository's root, otherwise a path inside the
 * repository ({@link safeJournalPath}), at most {@link JOURNAL_PATH_MAX}
 * characters.
 */
export const JournalRootPath = z
  .string()
  .max(JOURNAL_PATH_MAX)
  .transform((p) => p.replace(/^\/+|\/+$/g, ""))
  .refine((p) => p === "" || safeJournalPath(p) !== null, { message: "Not a folder of the repository" });

/**
 * `POST /classrooms/:id/journal`, by its mode (ADR-057). `quiz`: a journal
 * held in Quiz, needing no GitHub at all, seeded with its home page
 * (`README.md`). `github`: a private repository created in the classroom's
 * organization (F-JRN-02); without a name, the staff payload's
 * `proposedName`. Answers 201 with the staff `Journal`.
 */
export const JournalCreate = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("quiz") }),
  z.strictObject({ mode: z.literal("github"), name: GithubRepoName.optional() }),
]);
export type JournalCreate = z.infer<typeof JournalCreate>;

/**
 * `POST /classrooms/:id/journal/use`: a repository of the classroom's
 * organization, by name (F-JRN-03, D27); the repository's default branch
 * without a `ref`, its root without a `rootPath`. Answers 201 with the staff
 * `Journal`.
 */
export const JournalUse = z.strictObject({
  name: GithubRepoName,
  ref: GitRef.optional(),
  rootPath: JournalRootPath.optional(),
});
export type JournalUse = z.infer<typeof JournalUse>;

/**
 * `PUT /classrooms/:id/journal/pages/*` (Quiz mode): the page's new source,
 * against the version the editor opened (`JournalPageStaff.version`). Saved
 * since by someone else ⇒ 409 `conflict`, nothing written and nothing merged
 * (F-JRN-10, ADR-057). Answers {@link JournalFileWritten}.
 */
export const JournalPageSave = z.strictObject({
  markdown: z.string().max(JOURNAL_MARKDOWN_MAX),
  baseVersion: z.number().int(),
});
export type JournalPageSave = z.infer<typeof JournalPageSave>;

/**
 * `POST /classrooms/:id/journal/pages`: a new page, empty or with its first
 * heading. Answers 201 with {@link JournalFileWritten}.
 */
export const JournalPageAdd = z.strictObject({
  path: JournalPagePath,
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((t) => !hasControlChar(t), { message: "No control character" })
    .optional(),
});
export type JournalPageAdd = z.infer<typeof JournalPageAdd>;

/**
 * A file a Quiz-mode write stored (a saved, added or restored page, an
 * uploaded asset): its journal path, and the page as it now reads — its
 * `version` the next save's `baseVersion`; null for an asset.
 */
export const JournalFileWritten = z.strictObject({
  path: z.string(),
  page: JournalPageStaff.nullable(),
});
export type JournalFileWritten = z.infer<typeof JournalFileWritten>;

/**
 * `POST /classrooms/:id/journal/preview`: markdown not committed yet,
 * rendered as the staff would read the page at `path`, against the copy's
 * pages and assets. Nothing is stored.
 */
export const JournalPreview = z.strictObject({
  path: JournalPagePath,
  markdown: z.string().max(JOURNAL_MARKDOWN_MAX),
});
export type JournalPreview = z.infer<typeof JournalPreview>;

export const JournalPreviewResult = z.strictObject({
  title: z.string().nullable(),
  html: z.string(),
  toc: z.array(JournalTocEntry),
  draft: z.boolean(),
  visibleFrom: z.iso.datetime({ offset: true }).nullable(),
  warnings: z.array(JournalWarning),
});
export type JournalPreviewResult = z.infer<typeof JournalPreviewResult>;

/**
 * Why a write was refused, as a code the web app words (invariant 1): the
 * synchronisation's codes when GitHub answered so, and
 *
 * - `not_connected` — the classroom is not connected to an organization where
 *   Quiz's App is installed (F-JRN-02);
 * - `journal_exists` — the classroom already has a journal (F-JRN-01);
 * - `no_journal` — it has none to write to;
 * - `name_taken` — the organization already has a repository by that name,
 *   which is never adopted: {@link JournalNameTaken} proposes another;
 * - `conflict` — the page was saved by someone else since it was opened;
 * - `page_exists` — the journal already has a page at that path;
 * - `asset_exists` — it already has another file at that path (assets are
 *   append-only: never overwritten);
 * - `confirm_required` — removing a Quiz-mode journal that holds pages
 *   destroys the only copy: the classroom's name must be typed (F-JRN-04);
 * - `type_mismatch` — an upload's content type is not its extension's;
 * - `empty_upload` — an upload with no bytes;
 * - `read_only` — the journal lives in a GitHub repository (ADR-057): its
 *   pages and assets are edited there, never written by the platform.
 *
 * An upload over {@link JOURNAL_ASSET_MAX_BYTES} is Fastify's own 413.
 */
export const JournalErrorCode = z.enum([
  ...JournalSyncError.options,
  "not_connected",
  "journal_exists",
  "no_journal",
  "name_taken",
  "conflict",
  "page_exists",
  "asset_exists",
  "confirm_required",
  "type_mismatch",
  "empty_upload",
  "read_only",
]);
export type JournalErrorCode = z.infer<typeof JournalErrorCode>;

/** The body of a refused write: `message` is the code again, the web app words it. */
export const JournalRefusal = z.object({ error: JournalErrorCode, message: z.string() });
export type JournalRefusal = z.infer<typeof JournalRefusal>;

/** The 409 of a create on a name already taken, with a free name to propose instead (F-JRN-02). */
export const JournalNameTaken = z.object({
  error: z.literal("name_taken"),
  message: z.string(),
  suggestion: GithubRepoName,
});
export type JournalNameTaken = z.infer<typeof JournalNameTaken>;

/**
 * `DELETE /classrooms/:id/journal?confirm=<the classroom's name>` (F-JRN-04),
 * and `DELETE /classrooms/:id` the same way (F-ORG-09): a Quiz-mode journal
 * holding pages is the only copy of them, and goes only with the
 * classroom's name typed (409 `confirm_required` otherwise). A GitHub-mode
 * journal, or an empty one, needs nothing: the repository stays.
 */
export const JournalRemoveQuery = z.strictObject({ confirm: z.string().max(200).optional() });
export type JournalRemoveQuery = z.infer<typeof JournalRemoveQuery>;

/** `DELETE /classrooms/:id`: the classroom's journal goes with it, under the same confirmation. */
export const ClassroomDeleteQuery = JournalRemoveQuery;
export type ClassroomDeleteQuery = JournalRemoveQuery;

// ---------------------------------------------------------------- revisions (Quiz mode)

/**
 * One saved state of a Quiz-mode page (ADR-057), for the staff only: no
 * student route ever reads a revision. `author` is the display name, null
 * when it gives none (the web words it).
 */
export const JournalRevision = z.strictObject({
  id: z.uuid(),
  path: z.string(),
  author: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type JournalRevision = z.infer<typeof JournalRevision>;

/** `GET /classrooms/:id/journal/revisions/*`: a page's revisions, newest first, a deleted page's too; no content. */
export const JournalRevisionList = z.array(JournalRevision);
export type JournalRevisionList = z.infer<typeof JournalRevisionList>;

/** `GET /classrooms/:id/journal/revision/:revisionId`: one revision with its markdown. */
export const JournalRevisionContent = JournalRevision.extend({ markdown: z.string() });
export type JournalRevisionContent = z.infer<typeof JournalRevisionContent>;

/** `/classrooms/:id/journal/revision/:revisionId`. */
export const JournalRevisionParams = z.object({ id: z.uuid(), revisionId: z.uuid() });
export type JournalRevisionParams = z.infer<typeof JournalRevisionParams>;

/**
 * `GET /classrooms/:id/journal/deleted`: the paths that have revisions and no
 * page any more, each restorable from its revisions; newest first. `title`
 * is the latest revision's, null when nothing names it; `revisionId` is that
 * revision, the one a restore brings back.
 */
export const JournalDeletedPage = z.strictObject({
  path: z.string(),
  title: z.string().nullable(),
  revisionId: z.uuid(),
  savedAt: z.iso.datetime({ offset: true }),
});
export type JournalDeletedPage = z.infer<typeof JournalDeletedPage>;

/**
 * `POST /classrooms/:id/journal/restore`: a revision becomes the page's
 * content again — a save like any other (a new revision, the version bumped,
 * audited), and a deleted page is created again. Answers {@link JournalFileWritten}.
 */
export const JournalRestore = z.strictObject({ revisionId: z.uuid() });
export type JournalRestore = z.infer<typeof JournalRestore>;
