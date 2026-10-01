/**
 * The journal's writes (merge task M4-03; spec F-JRN-02..05; ported from
 * heig-classroom's `modules/journal.ts`, sync point `ab98cc0`, one journal
 * per classroom since D03): create a repository, use one of the
 * organization's, remove the journal, refresh, preview; the refusals and the
 * context every write shares.
 *
 * **GitHub mode is read-only (ADR-057).** Its content is edited on GitHub
 * (`editUrl` of a page) and reaches the copy by a push or a Refresh. The
 * writes of the content — save, add, delete a page, upload an asset — are
 * Quiz mode's (`quiz.ts`, M4-08), which refuses a GitHub-mode journal with
 * 409 `read_only`. Of M4-03's GitHub writes, what creates a repository and
 * commits a file (`createRepo`, `putFile`, `commitAuthor`) stays, for the
 * creation and for M4-11's Move to GitHub.
 *
 * A new row starts at a random `version` (below), so an ingestion that read
 * GitHub for a removed row never writes its stale copy over a new one (J2,
 * `ingest.ts`).
 *
 * **Every write is audited** (`journal.*`, invariant 9) through the `note` of
 * the route, which knows the actor; an invitation is one entry each (D27).
 *
 * **Every GitHub call is bounded** (`boundedClient`: no retry, no rate-limit
 * wait, 30 s), and a failure GitHub answered — or GitHub not answering — is
 * a {@link JournalError} whose code the web words (invariant 1).
 */
import { randomInt } from "node:crypto";

import { count, eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Octokit } from "octokit";

import { type JournalErrorCode, type JournalPreviewResult, type JournalStaff } from "@quiz/contracts";
import { journalRepoName, prettifyName, renderPage } from "@quiz/docrender";
import { displayName, repoName } from "@quiz/domain";

import type { AuditAction } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import {
  classroomJournals,
  classrooms,
  courseStaff,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  journalAssets,
  journalPages,
  users,
} from "../../db/schema.js";
import { githubApp, githubStatus } from "../../github/app.js";
import { inviteCollaborator } from "../../github/collaborators.js";
import { DomainError } from "../http.js";
import { journalChanged } from "./events.js";
import { githubJournal } from "./mode.js";
import {
  boundedClient,
  createRepo,
  findRepo,
  JournalRepoError,
  syncErrorOf,
  type CommitAuthor,
  type FoundRepo,
  type ResolvedRepo,
} from "./repo.js";
import { requestIngest, staffJournal } from "./service.js";

// ---------------------------------------------------------------- refusals

/** The status of each refusal: the state of things (409) but for the upload's own faults and GitHub's silence. An upload over the cap is Fastify's own 413. */
const STATUS: Record<JournalErrorCode, number> = {
  repo_not_found: 409,
  ref_not_found: 409,
  root_not_found: 409,
  forbidden: 409,
  too_large: 409,
  github_unavailable: 503,
  not_connected: 409,
  journal_exists: 409,
  no_journal: 409,
  name_taken: 409,
  conflict: 409,
  page_exists: 409,
  asset_exists: 409,
  confirm_required: 409,
  type_mismatch: 415,
  empty_upload: 400,
  read_only: 409,
};

/** A write refused: `{ error: code, message: code, ...details }`, worded by the web app. */
export class JournalError extends DomainError {
  constructor(code: JournalErrorCode, details?: Readonly<Record<string, unknown>>) {
    super(code, STATUS[code], code, details);
    this.name = "JournalError";
  }
}

/**
 * `work`, its GitHub failures as {@link JournalError}s: a name taken as such,
 * anything GitHub answered (or its silence: a timeout, the network) as the
 * synchronisation's code for it. Anything else — a bug, the database — is
 * thrown as it is, a 500.
 */
async function onGithub<T>(log: FastifyBaseLogger, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof DomainError) throw err;
    if (err instanceof JournalRepoError && err.code === "name_taken") {
      throw new JournalError(err.code);
    }
    const name = (err as Error | null)?.name;
    if (err instanceof JournalRepoError || githubStatus(err) !== undefined || name === "TimeoutError" || name === "AbortError") {
      const code = syncErrorOf(err);
      log.warn({ code, status: githubStatus(err) }, "a journal write failed on GitHub");
      throw new JournalError(code);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- the target

/** What a write reaches: the classroom's organization, its journal row. */
interface Target {
  /** The organization, when Quiz's App is active on it; null: not connected. */
  org: { login: string; githubOrgId: number | null; installationId: number } | null;
  journal: typeof classroomJournals.$inferSelect | null;
}

/** One query: the classroom's link, its organization, its journal. */
async function targetOf(db: Db, classroomId: string): Promise<Target> {
  const [row] = await db
    .select({
      login: githubOrganizations.login,
      githubOrgId: githubOrganizations.githubOrgId,
      installationId: githubOrganizations.installationId,
      status: githubOrganizations.status,
      journal: classroomJournals,
    })
    .from(classrooms)
    .leftJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, classrooms.id))
    .leftJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
    .leftJoin(classroomJournals, eq(classroomJournals.classroomId, classrooms.id))
    .where(eq(classrooms.id, classroomId));
  const active = row?.login && row.installationId !== null && row.status === "active";
  return {
    org: active ? { login: row.login!, githubOrgId: row.githubOrgId, installationId: row.installationId! } : null,
    journal: row?.journal ?? null,
  };
}

function connected(t: Target): NonNullable<Target["org"]> {
  if (!t.org) throw new JournalError("not_connected");
  return t.org;
}

function attached(t: Target): NonNullable<Target["journal"]> {
  if (!t.journal) throw new JournalError("no_journal");
  return t.journal;
}

// ---------------------------------------------------------------- context

/** The audit actions of the journal, all of them staff writes (04-journal §4.1). */
export type JournalAuditAction = Extract<AuditAction, `journal.${string}`>;

/** What a route hands a write: the app, who acts, and how to audit (on the classroom, as the actor). */
export interface WriteContext {
  app: FastifyInstance;
  config: AppConfig;
  /** The Quiz user the commit is authored as. */
  userId: string;
  note: (action: JournalAuditAction, payload: Record<string, unknown>) => Promise<void>;
}

/** The classroom a write is on, as `accessibleClassroom` loaded it. */
export interface Room {
  id: string;
  name: string;
  courseId: string;
}

/**
 * Who a browser commit is authored as (F-JRN-10, D27: "the commits are
 * authored as the teacher"): their name (`displayName`, never an address in
 * its place) and a NOREPLY address, never their email (N-DATA-02): every
 * member of the organization reads the history, and it outlives the
 * classroom. Linked to GitHub, `<id>+<login>@users.noreply.github.com`, which
 * GitHub attributes to the account by its immutable id (a later rename
 * changes nothing); otherwise `quiz-<user id>@users.noreply.<the platform's
 * host>`, which names the Quiz account and reaches nobody. The COMMITTER
 * stays the App (`repo.ts`), so GitHub signs the commit.
 */
export async function commitAuthor(db: Db, config: AppConfig, userId: string): Promise<CommitAuthor> {
  const [u] = await db
    .select({
      givenName: users.givenName,
      familyName: users.familyName,
      githubUserId: githubAccounts.githubUserId,
      login: githubAccounts.login,
    })
    .from(users)
    .leftJoin(githubAccounts, eq(githubAccounts.userId, users.id))
    .where(eq(users.id, userId));
  if (!u) throw new Error(`commit author ${userId} is not a user`);
  const host = new URL(config.PUBLIC_URL).hostname;
  const linked = u.githubUserId !== null && u.login !== null;
  const email = linked ? `${u.githubUserId}+${u.login}@users.noreply.github.com` : `quiz-${userId}@users.noreply.${host}`;
  const name = displayName({ givenName: u.givenName, familyName: u.familyName, email: null });
  return { name: name || (linked ? u.login! : `quiz-${userId}`), email };
}

// ---------------------------------------------------------------- choosing a repository

/** What a new journal's repository starts with (F-JRN-02): the layout, told in the repository itself. */
export const SEED_README = `# Journal

This repository is the journal of a classroom on Quiz. Everything in it is
rendered for the students of that classroom, who never see the repository
itself.

## How it is organised

There is no configuration file: the layout of the repository IS the navigation.

\`\`\`
README.md              this page, the front page of the journal
010-basics/
  README.md            the landing page of the section, and its title
  010-variables.md
  020-pointers.md
  images/pointers.svg  referenced as ![](images/pointers.svg)
\`\`\`

- Pages are sorted by file name, so a numeric prefix decides the order. Use
  steps of ten (\`010-\`, \`020-\`) and inserting a page renumbers nothing.
- The prefix is never displayed. A page is titled by its \`title:\` front
  matter, else by its first \`#\` heading, else by its file name.
- \`README.md\` in a directory titles that section. A directory without one is
  a heading that opens nothing.
- Links and images are relative (\`images/p.svg\`, \`../010-basics/020-pointers.md\`),
  so the same markdown reads correctly here on GitHub and on Quiz.

## Front matter

\`\`\`yaml
---
title: What is a pointer
date: 2026-10-01
draft: true              # staff only: prepare a page without publishing it
visible_from: 2026-10-08 # hidden from the students until then
---
\`\`\`

## Two ways to write it

Edit the pages on Quiz, or clone this repository and push: both write these
files. Raw HTML is shown as text rather than rendered, and images must be
committed here: a page cannot load one from another site.
`;

/**
 * A new row starts at a RANDOM version, not 0: an ingestion that took its
 * snapshot of a row since removed (at version 0, say) must not find a fresh
 * row of the same classroom — perhaps on another repository — at the version
 * it expects, and write the old repository's copy into it. Half the integer
 * range keeps room for the bumps.
 */
export const freshVersion = () => randomInt(1, 2 ** 30);

/**
 * The row of a classroom's new journal, then the staff invited and the copy
 * requested. A row that appeared meanwhile (two tabs) wins: 409.
 */
async function attach(
  ctx: WriteContext,
  room: Room,
  octokit: Octokit,
  repo: FoundRepo,
  where: { ref: string; rootPath: string },
  action: "journal.create" | "journal.use",
): Promise<JournalStaff> {
  const inserted = await ctx.app.db
    .insert(classroomJournals)
    .values({
      classroomId: room.id,
      mode: "github",
      githubRepoId: repo.githubRepoId,
      fullName: repo.fullName,
      ref: where.ref,
      rootPath: where.rootPath,
      createdBy: ctx.userId,
      version: freshVersion(),
    })
    .onConflictDoNothing()
    .returning({ classroomId: classroomJournals.classroomId });
  if (inserted.length === 0) throw new JournalError("journal_exists");
  await ctx.note(action, { mode: "github", fullName: repo.fullName, githubRepoId: repo.githubRepoId, ...where });
  await inviteStaff(ctx, octokit, repo, room);
  await requestIngest(ctx.app, ctx.config, room.id);
  return staffJournal(ctx.app.db, room);
}

/**
 * The free name proposed when `name` is taken (F-JRN-02): `name` with the
 * classroom's id as a disambiguator, the first 8 characters, else all 32 —
 * deterministic, so a retried creation proposes the same name instead of
 * scattering repositories over the organization.
 */
async function freeName(octokit: Octokit, org: string, name: string, room: Room) {
  const id = room.id.replace(/-/g, "");
  const short = repoName(name, id.slice(0, 8));
  return (await findRepo(octokit, org, short)) ? repoName(name, id) : short;
}

/** `POST /classrooms/:id/journal`: a new private repository with its README (F-JRN-02). */
export async function createJournal(ctx: WriteContext, room: Room, name: string | undefined): Promise<JournalStaff> {
  // Without Quiz's App there is no organization to create in (a Quiz-mode journal needs none).
  if (!githubApp(ctx.config)) throw new JournalError("not_connected");
  const t = await targetOf(ctx.app.db, room.id);
  const org = connected(t);
  if (t.journal) throw new JournalError("journal_exists");
  const wanted = name ?? journalRepoName(room.name);
  const author = await commitAuthor(ctx.app.db, ctx.config, ctx.userId);
  return onGithub(ctx.app.log, async () => {
    const octokit = await boundedClient(ctx.config, org.installationId);
    let repo: FoundRepo;
    try {
      repo = await createRepo(octokit, {
        org: org.login,
        name: wanted,
        // Text written into GitHub is English (D12, open: its suggestion).
        description: `Journal of ${room.name}`,
        seed: { path: "README.md", content: SEED_README },
        author,
      });
    } catch (err) {
      if (!(err instanceof JournalRepoError && err.code === "name_taken")) throw err;
      throw new JournalError("name_taken", { suggestion: await freeName(octokit, org.login, wanted, room) });
    }
    return attach(ctx, room, octokit, repo, { ref: repo.defaultBranch, rootPath: "" }, "journal.create");
  });
}

/**
 * `POST /classrooms/:id/journal/use`: any repository of the classroom's
 * organization (D27), by name, on `ref` (its default branch otherwise) under
 * `rootPath`. GitHub follows a transferred repository to its new owner: one
 * whose owner is not the organization is not found, like a missing one.
 */
export async function useJournal(
  ctx: WriteContext,
  room: Room,
  body: { name: string; ref?: string | undefined; rootPath?: string | undefined },
): Promise<JournalStaff> {
  const t = await targetOf(ctx.app.db, room.id);
  const org = connected(t);
  if (t.journal) throw new JournalError("journal_exists");
  return onGithub(ctx.app.log, async () => {
    const octokit = await boundedClient(ctx.config, org.installationId);
    const repo = await findRepo(octokit, org.login, body.name);
    const owned =
      repo !== null &&
      (org.githubOrgId !== null ? repo.ownerId === org.githubOrgId : repo.owner.toLowerCase() === org.login.toLowerCase());
    if (!owned) throw new JournalError("repo_not_found");
    const where = { ref: body.ref ?? repo.defaultBranch, rootPath: body.rootPath ?? "" };
    return attach(ctx, room, octokit, repo, where, "journal.use");
  });
}

/**
 * `DELETE /classrooms/:id/journal` (F-JRN-04): the row goes, and its pages,
 * assets and revisions with it by cascade. In GitHub mode the repository is
 * never touched; it needs no GitHub, nor even an organization still
 * installed — so a journal whose App was uninstalled can still be removed,
 * which in turn lets the classroom be disconnected (D28). In Quiz mode the
 * pages are the only copy: with any, `confirm` must be the classroom's name
 * (409 `confirm_required`, nothing removed). Idempotent.
 */
export async function removeJournal(ctx: WriteContext, room: Room, confirm: string | undefined): Promise<void> {
  const removed = await ctx.app.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        mode: classroomJournals.mode,
        fullName: classroomJournals.fullName,
        githubRepoId: classroomJournals.githubRepoId,
      })
      .from(classroomJournals)
      .where(eq(classroomJournals.classroomId, room.id))
      .for("update");
    if (!row) return null;
    const [counted] = await tx.select({ pages: count() }).from(journalPages).where(eq(journalPages.classroomId, room.id));
    const pages = counted?.pages ?? 0;
    if (row.mode === "quiz" && pages > 0 && confirm?.trim() !== room.name.trim()) {
      throw new JournalError("confirm_required");
    }
    await tx.delete(classroomJournals).where(eq(classroomJournals.classroomId, room.id));
    return { ...row, pages };
  });
  if (!removed) return;
  await ctx.note("journal.remove", removed);
  journalChanged([room.id]);
}

// ---------------------------------------------------------------- invitations (D27)

/** GitHub's permissions of a collaborator, from the least to the most. */
const PERMISSION_RANK: Record<string, number> = { none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 };

/**
 * `login`'s permission on the repository now, or null when they hold none
 * (GitHub answers 404 for a user who is not a collaborator).
 */
async function permissionOf(octokit: Octokit, repo: ResolvedRepo, login: string): Promise<string | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
      owner: repo.owner,
      repo: repo.name,
      username: login,
    });
    return (data as { permission?: string }).permission ?? null;
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
}

/**
 * Invites the course's staff who linked a GitHub account as collaborators
 * of the repository, `push` only — never `admin` nor `maintain` — so the
 * clone-and-push path works without anyone touching GitHub's settings
 * (F-JRN-02, F-JRN-03). Their CURRENT login, read by their account's
 * immutable id (`linkedLogin`): an invitation to a renamed login would reach
 * nobody. A member who already holds `push` or more on a repository chosen
 * with "use" is left as they are (`accepted`): GitHub's invitation SETS the
 * permission, and would lower an admin to `push`. One audit entry per member,
 * whatever came of it; a failure is logged and audited, and never fails the
 * creation or the choice.
 */
async function inviteStaff(ctx: WriteContext, octokit: Octokit, repo: ResolvedRepo, room: Room): Promise<void> {
  const staff = await ctx.app.db
    .select({ userId: githubAccounts.userId })
    .from(courseStaff)
    .innerJoin(githubAccounts, eq(githubAccounts.userId, courseStaff.userId))
    .where(eq(courseStaff.courseId, room.courseId));
  for (const { userId } of staff) {
    let login: string | null = null;
    let outcome: "pending" | "accepted" | "stale" | "failed";
    try {
      const current = await linkedLogin(ctx.app.db, octokit, userId);
      if (typeof current !== "string") outcome = "stale"; // GITHUB_ACCOUNT_STALE
      else {
        login = current;
        const held = await permissionOf(octokit, repo, current);
        outcome =
          (PERMISSION_RANK[held ?? "none"] ?? 0) >= PERMISSION_RANK.write!
            ? "accepted"
            : await inviteCollaborator(octokit, repo.owner, repo.name, current, "push");
      }
    } catch (err) {
      outcome = "failed";
      ctx.app.log.warn(
        { userId, repository: repo.fullName, status: githubStatus(err), error: (err as Error)?.name },
        "a journal collaborator invitation failed",
      );
    }
    await ctx.note("journal.invite", { userId, login, fullName: repo.fullName, permission: "push", outcome });
  }
}

// ---------------------------------------------------------------- refresh, preview

/**
 * `POST /classrooms/:id/journal/refresh` (F-JRN-05): one synchronisation
 * requested — queued, or run without a queue. Its outcome is the row's
 * `syncStatus`, which the `journal` hint makes the client read again. Needs
 * no connection check: the ingestion records an organization no longer
 * installed as `forbidden`. A Quiz-mode journal is its own source, always
 * up to date: nothing to do, nothing audited.
 */
export async function refreshJournal(ctx: WriteContext, classroomId: string): Promise<void> {
  const journal = githubJournal(attached(await targetOf(ctx.app.db, classroomId)));
  if (!journal) return;
  await ctx.note("journal.refresh", { fullName: journal.fullName });
  await requestIngest(ctx.app, ctx.config, classroomId);
}

/**
 * `POST /classrooms/:id/journal/preview`: `markdown` rendered as the staff
 * would read the page at `path` — the same renderer, against the copy's
 * pages and assets, so a link or an image that will not resolve shows as it
 * will. Nothing is stored, nothing audited: it writes nothing.
 */
export async function previewPage(db: Db, classroomId: string, path: string, markdown: string): Promise<JournalPreviewResult> {
  attached(await targetOf(db, classroomId));
  const [pages, assets] = await Promise.all([
    db.select({ path: journalPages.path }).from(journalPages).where(eq(journalPages.classroomId, classroomId)),
    db.select({ path: journalAssets.path }).from(journalAssets).where(eq(journalAssets.classroomId, classroomId)),
  ]);
  const page = renderPage(markdown, {
    classroomId,
    pagePath: path,
    fallbackTitle: prettifyName(path),
    pages: new Set([...pages.map((p) => p.path), path]),
    assets: new Set(assets.map((a) => a.path)),
  });
  return {
    title: page.title,
    html: page.html,
    toc: page.toc,
    draft: page.draft,
    visibleFrom: page.visibleFrom?.toISOString() ?? null,
    warnings: page.warnings,
  };
}
