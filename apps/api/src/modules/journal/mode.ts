/**
 * The journal's two modes (ADR-057, D29) as types: a row is a Quiz-mode
 * journal (the database is the content) or a GitHub-mode one (a read-only
 * copy of a repository). The repository columns are nullable in the schema,
 * set exactly in GitHub mode (`classroom_journals_mode_ck`); {@link githubJournal}
 * is the one narrowing every GitHub path goes through — the ingestion, the
 * webhooks' fan-out, the staff's repository view — so a Quiz-mode row never
 * reaches GitHub code.
 */
import { encodeJournalPath } from "@quiz/contracts";

import type { classroomJournals } from "../../db/schema.js";

export type JournalRow = typeof classroomJournals.$inferSelect;

/** A GitHub-mode row, its repository columns known to be set. */
export type GithubJournal = JournalRow & {
  mode: "github";
  githubRepoId: number;
  fullName: string;
  ref: string;
};

/** The row as a GitHub-mode journal, or null for a Quiz-mode one. */
export function githubJournal(row: JournalRow): GithubJournal | null {
  if (row.mode !== "github" || row.githubRepoId === null || row.fullName === null || row.ref === null) return null;
  return row as GithubJournal;
}

/** A journal path as a path of the repository: under the row's root folder. */
export const repoPath = (journal: { rootPath: string }, path: string) =>
  journal.rootPath ? `${journal.rootPath}/${path}` : path;

/**
 * github.com's editor of a page's file on the journal's branch: the one way
 * to change a GitHub-mode page (the platform is read-only for it). Every
 * segment of the branch and of the path is encoded on its own, so a `#`, a
 * space or an accent survives and the slashes stay separators.
 */
export function editUrl(journal: GithubJournal, path: string): string {
  return `https://github.com/${journal.fullName}/edit/${encodeJournalPath(journal.ref)}/${encodeJournalPath(repoPath(journal, path))}`;
}
