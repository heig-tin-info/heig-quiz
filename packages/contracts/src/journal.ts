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
 * Only the read half lives here (what M4-02 serves and M4-04 reads); the
 * bodies of the writes (create, use, save, add, preview, refresh) are
 * written by M4-03 with their handlers (`docs/merge/09-tasks.md`).
 */
import { z } from "zod";

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
 * A path inside the journal's root (N-SEC-15), or null: no `..` nor `.`
 * segment, no empty segment, no leading `/`, no backslash, no control
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
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
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

/** The repository a classroom's journal mirrors, for the staff. */
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
  /** Writes need a copy that knows the head it writes over. */
  editable: z.boolean(),
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
  /** Null while the classroom has no journal. */
  repository: JournalRepository.nullable(),
  nav: z.array(JournalNavNode),
  homePath: z.string().nullable(),
  /** The pages students do not see yet (drafts, future `visible_from`). */
  hiddenPaths: z.array(z.string()),
  /** How many pages carry at least one warning. */
  warningCount: z.number().int().min(0),
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
  /** The optimistic lock of a save (`baseSha`). */
  blobSha: z.string(),
  warnings: z.array(JournalWarning),
});
export type JournalPageStaff = z.infer<typeof JournalPageStaff>;

export const JournalPage = z.discriminatedUnion("view", [JournalPageStudent, JournalPageStaff]);
export type JournalPage = z.infer<typeof JournalPage>;
