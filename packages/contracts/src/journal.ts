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
 */
import { z } from "zod";

// ------------------------------------------------------------------ paths

/** Longest journal path the platform accepts (N-SEC-15). */
export const JOURNAL_PATH_MAX = 400;

/** An asset (image, handout) is copied into the platform up to this size (D14, F-JRN-11). */
export const JOURNAL_ASSET_MAX_BYTES = 5_000_000;

/** Longest markdown source a save or a preview carries. */
export const JOURNAL_MARKDOWN_MAX = 500_000;

/**
 * A path inside the journal's root (N-SEC-15), or null: no `..` nor `.`
 * segment, no empty segment, no leading `/`, no backslash, no control
 * character, at most {@link JOURNAL_PATH_MAX} characters. The route
 * parameters are already URL-decoded by the router, so nothing is decoded
 * here: a `%2e%2e` that survives is a literal file name, and harmless.
 */
export function safeJournalPath(raw: string): string | null {
  if (!raw || raw.length > JOURNAL_PATH_MAX) return null;
  if (raw.startsWith("/") || raw.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return raw;
}

const isPage = (path: string) => /\.md$/i.test(path);

/** Any file of the journal, by its path relative to the journal's root. */
export const JournalPath = z
  .string()
  .refine((p) => safeJournalPath(p) !== null, { message: "Not a path inside the journal" });

/** A page: a journal path ending in `.md`. */
export const JournalPagePath = JournalPath.refine(isPage, { message: "A page is a .md file" });

/** An asset: a journal path that is not a page. */
export const JournalAssetPath = JournalPath.refine((p) => !isPage(p), {
  message: "An asset is not a .md file",
});

/** `/classrooms/:id/journal/pages/*`. */
export const JournalPageParams = z.object({ id: z.uuid(), "*": JournalPagePath });
export type JournalPageParams = z.infer<typeof JournalPageParams>;

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

/** Every warning code, for the web's translation table. */
export const JOURNAL_WARNING_CODES = JournalWarning.options.map(
  (o) => o.shape.code.value,
) as readonly JournalWarningCode[];

// ---------------------------------------------------------------- reading

/** One heading of a page, for its table of contents. */
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
  title: string;
  /** The page opened by the entry; null for a section without a landing page. */
  pagePath: string | null;
  children: JournalNavNode[];
}
export const JournalNavNode: z.ZodType<JournalNavNode> = z.lazy(() =>
  z.strictObject({
    path: z.string(),
    title: z.string(),
    pagePath: z.string().nullable(),
    children: z.array(JournalNavNode),
  }),
);

/** The states of a classroom's copy of its repository (also the database's CHECK). */
export const JOURNAL_SYNC_STATUSES = ["pending", "ok", "error"] as const;
export const JournalSyncStatus = z.enum(JOURNAL_SYNC_STATUSES);
export type JournalSyncStatus = z.infer<typeof JournalSyncStatus>;

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
  syncError: z.string().nullable(),
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
  title: z.string(),
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

// ---------------------------------------------------------------- writing

/** A GitHub repository name (without its organization). */
export const GithubRepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "Not a repository name")
  .refine((n) => n !== "." && n !== "..", { message: "Not a repository name" });

/** A branch name: git's own rules, the ones that matter for a URL and a path. */
export const GitRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, "Not a branch name")
  .refine((r) => !r.startsWith("/") && !r.endsWith("/") && !r.includes("..") && !r.endsWith(".lock"), {
    message: "Not a branch name",
  });

/**
 * The folder of the repository holding the pages: "" for the root, else a
 * journal path. Surrounding slashes are dropped, as a teacher types them.
 */
export const JournalRootPath = z
  .string()
  .max(200)
  .transform((p) => p.trim().replace(/^\/+|\/+$/g, ""))
  .refine((p) => p === "" || safeJournalPath(p) !== null, { message: "Not a folder of the repository" });

/** `POST /classrooms/:id/journal`: create a repository (F-JRN-02); the name defaults to the proposal. */
export const JournalCreate = z.strictObject({ name: GithubRepoName.optional() });
export type JournalCreate = z.infer<typeof JournalCreate>;

/**
 * `POST /classrooms/:id/journal/use`: use a repository of the classroom's
 * organization (F-JRN-03, D27), on a branch (its default one otherwise) under
 * a root folder (the repository's root otherwise).
 */
export const JournalUse = z.strictObject({
  name: GithubRepoName,
  ref: GitRef.optional(),
  rootPath: JournalRootPath.optional(),
});
export type JournalUse = z.infer<typeof JournalUse>;

/** 409 of a creation on a name already taken: never adopted, a free one proposed. */
export const JournalNameTaken = z.strictObject({
  error: z.literal("name_taken"),
  suggestion: GithubRepoName,
});
export type JournalNameTaken = z.infer<typeof JournalNameTaken>;

/**
 * The refusals of the journal's routes that the web app words (the 404s stay
 * plain `not_found`, indistinguishable from a missing classroom):
 * no journal yet, one already set, the classroom not connected, the App not
 * installed, the repository gone, a stale `baseSha`, a page already there, a
 * content type that does not match the extension, a file over the limit.
 */
export const JournalErrorCode = z.enum([
  "no_journal",
  "journal_exists",
  "not_connected",
  "app_not_installed",
  "name_taken",
  "repository_not_found",
  "conflict",
  "page_exists",
  "type_mismatch",
  "too_large",
]);
export type JournalErrorCode = z.infer<typeof JournalErrorCode>;

/** `POST /classrooms/:id/journal/refresh`: what the synchronisation copied. */
export const JournalRefreshResult = z.strictObject({
  commitSha: z.string().nullable(),
  pages: z.number().int().min(0),
  assets: z.number().int().min(0),
  /** Referenced files left out for their size. */
  oversized: z.array(z.string()),
});
export type JournalRefreshResult = z.infer<typeof JournalRefreshResult>;

/** `POST /classrooms/:id/journal/preview`: render markdown not committed yet, as a page at `path`. */
export const JournalPreviewBody = z.strictObject({
  path: JournalPagePath,
  markdown: z.string().max(JOURNAL_MARKDOWN_MAX),
});
export type JournalPreviewBody = z.infer<typeof JournalPreviewBody>;

export const JournalPreview = z.strictObject({
  title: z.string(),
  html: z.string(),
  toc: z.array(JournalTocEntry),
  warnings: z.array(JournalWarning),
  draft: z.boolean(),
  visibleFrom: z.iso.datetime({ offset: true }).nullable(),
});
export type JournalPreview = z.infer<typeof JournalPreview>;

/** A git blob sha (SHA-1 or SHA-256, hexadecimal). */
export const BlobSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "Not a blob sha");

/**
 * `PUT /classrooms/:id/journal/pages/*`: save a page against the blob the
 * editor opened (`baseSha`): a repository that moved meanwhile is a 409
 * `conflict`, never a merge (F-JRN-10).
 */
export const JournalPageSave = z.strictObject({
  markdown: z.string().max(JOURNAL_MARKDOWN_MAX),
  baseSha: BlobSha,
  /** The commit message; a default one names the page. */
  message: z.string().trim().min(1).max(200).optional(),
});
export type JournalPageSave = z.infer<typeof JournalPageSave>;

export const JournalPageSaved = z.strictObject({
  path: z.string(),
  /** The page as the copy knows it after the save; null if the refresh did not land. */
  blobSha: z.string().nullable(),
  title: z.string().nullable(),
});
export type JournalPageSaved = z.infer<typeof JournalPageSaved>;

/** `POST /classrooms/:id/journal/pages`: add a page, seeded with its title. */
export const JournalPageCreate = z.strictObject({
  path: JournalPagePath,
  title: z.string().trim().min(1).max(200).optional(),
});
export type JournalPageCreate = z.infer<typeof JournalPageCreate>;

/** 201 of `POST pages` and of `POST assets/*` (raw body, ≤ {@link JOURNAL_ASSET_MAX_BYTES}). */
export const JournalFileCreated = z.strictObject({ path: z.string() });
export type JournalFileCreated = z.infer<typeof JournalFileCreated>;
