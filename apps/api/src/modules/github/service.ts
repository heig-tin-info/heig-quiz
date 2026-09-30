/**
 * The `github` module (ADR-035, spec 05 §5.11, docs/merge/03-github-projects.md
 * §3.1 "Org onboarding"): the organizations where Quiz's App (D23) is
 * installed, a classroom's link to one of them, the App's setup return, the
 * lazy healing of an organization, and its avatar. Ported from
 * heig-classroom's `modules/classrooms.ts` (sync point `ab98cc0`).
 *
 * This module owns `github_organizations` and `github_classroom_links`; it
 * reads `classroom_journals` by join (D28) until the journal module has a
 * service (M4-02).
 *
 * Every GitHub read here serves an HTTP request, so it passes `HTTP_READ`:
 * a rate limit fails at once and the stored state is served (§3.1, #37).
 * The callers check `githubApp(config)` first: without an App the routes
 * answer 404 and nothing here is reached.
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { and, desc, eq, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";

import type {
  GITHUB_CONNECT_REFUSALS,
  GithubChecks,
  GithubClassroom,
  GithubOrg,
  GithubSetupQuery,
} from "@quiz/contracts";

import { audit } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import {
  classroomJournals,
  classrooms,
  githubClassroomLinks,
  githubOrganizations,
} from "../../db/schema.js";
import {
  fetchInstallation,
  fetchOrgLlmSecret,
  fetchOrgPlan,
  HTTP_READ,
  listInstallations,
  orgExistsOnGithub,
  resolveOrgInstallation,
  type AppInstallation,
} from "../../github/app.js";
import { DomainError } from "../http.js";
import { sniffImage } from "../pool/assets.js";
import { installationChanged } from "./events.js";

type OrgRow = typeof githubOrganizations.$inferSelect;

/**
 * How long a healing, or the listing of the installations, stands before
 * GitHub is asked again. The classroom's Settings are opened, refreshed by
 * every SSE hint and re-opened; one minute keeps that from costing a GitHub
 * round trip (and a write) each time, while a teacher who just fixed
 * something on GitHub sees it on the next open after a minute. The setup
 * return drops the cache of the organization it touched.
 */
export const HEAL_TTL_MS = 60_000;

const UNKNOWN_CHECKS: GithubChecks = { allRepositories: null, llmSecret: "unknown" };

// ---------------------------------------------------------------- caches

/** The checks of one organization's last healing, by row id; the promise is shared by concurrent reads. */
const healed = new Map<string, { at: number; checks: Promise<GithubChecks> }>();
/** The last synchronisation of the installation listing. */
let listing: { at: number; done: Promise<void> } | null = null;
/** Avatars by GitHub's organization id (below). */
const avatars = new Map<number, { at: number; ttl: number; image: Promise<OrgAvatar | null> }>();

/** Test hook: every cache of this module emptied. */
export function resetGithubCaches(): void {
  healed.clear();
  avatars.clear();
  listing = null;
}

// ---------------------------------------------------------------- views

export function orgView(row: OrgRow): GithubOrg {
  return {
    id: row.id,
    login: row.login,
    // Derived from GitHub's immutable id: without one, the web draws initials.
    avatarUrl: row.githubOrgId === null ? null : `/app/api/github/orgs/${row.id}/avatar`,
    installed: row.installationId !== null,
    status: row.status,
    plan: row.plan,
  };
}

/** GitHub's install page of Quiz's App; `state` brings the teacher back to this classroom. */
function installUrl(config: AppConfig, classroomId: string): string {
  return `https://github.com/apps/${encodeURIComponent(config.GITHUB_APP_SLUG)}/installations/new?state=${classroomId}`;
}

// ---------------------------------------------------------------- organization rows

function systemAudit(
  db: Db | Tx,
  action: "github_org.installation_resolved" | "github_org.installation_deleted" | "github_org.renamed" | "github_org.deleted",
  orgId: string,
  payload: Record<string, unknown>,
) {
  return audit(db, {
    actorType: "system",
    action,
    subjectType: "github_organization",
    subjectId: orgId,
    payload,
  });
}

async function patchOrg(db: Db, id: string, patch: Partial<Omit<OrgRow, "id">>): Promise<OrgRow> {
  const [row] = await db
    .update(githubOrganizations)
    .set(patch)
    .where(eq(githubOrganizations.id, id))
    .returning();
  return row!;
}

/**
 * The row of an organization GitHub has just shown installed, created or
 * brought up to date: the installation, the login (a rename is followed by
 * the immutable id), `active`. Idempotent: a second call with the same
 * installation writes and audits nothing.
 */
export async function recordInstallation(
  db: Db,
  inst: AppInstallation,
  via: "setup_url" | "listing" | "healing",
): Promise<OrgRow> {
  // The id first; the login for a row imported before its id was known
  // (M8-01). GitHub's logins are case-insensitive.
  const candidates = await db
    .select()
    .from(githubOrganizations)
    .where(
      or(
        eq(githubOrganizations.githubOrgId, inst.githubOrgId),
        sql`lower(${githubOrganizations.login}) = lower(${inst.login})`,
      ),
    );
  const known = candidates.find((r) => r.githubOrgId === inst.githubOrgId) ?? candidates[0];
  let row: OrgRow;
  if (!known) {
    const [created] = await db
      .insert(githubOrganizations)
      .values({
        id: randomUUID(),
        githubOrgId: inst.githubOrgId,
        login: inst.login,
        installationId: inst.installationId,
        status: "active",
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      // Lost a race to another request recording the same organization.
      const [raced] = await db
        .select()
        .from(githubOrganizations)
        .where(eq(githubOrganizations.githubOrgId, inst.githubOrgId));
      if (!raced) throw new Error(`organization ${inst.login}: a conflicting row`);
      return raced;
    }
    row = created;
  } else {
    const current =
      known.installationId === inst.installationId &&
      known.login === inst.login &&
      known.githubOrgId === inst.githubOrgId &&
      known.status === "active";
    row = current
      ? known
      : await patchOrg(db, known.id, {
          installationId: inst.installationId,
          login: inst.login,
          githubOrgId: inst.githubOrgId,
          status: "active",
        });
    if (known.login !== inst.login) {
      await systemAudit(db, "github_org.renamed", row.id, { from: known.login, to: inst.login });
    }
  }
  if (known?.installationId !== inst.installationId) {
    await systemAudit(db, "github_org.installation_resolved", row.id, {
      installationId: inst.installationId,
      via,
    });
  }
  return row;
}

/** Re-reads the plan while it is unknown or `free`, so the warning clears once the organization upgrades. */
async function refreshPlan(config: AppConfig, db: Db, org: OrgRow): Promise<OrgRow> {
  if (org.installationId === null || (org.plan !== null && org.plan !== "free")) return org;
  const plan = await fetchOrgPlan(config, org.installationId, org.login, HTTP_READ);
  return plan && plan !== org.plan ? patchOrg(db, org.id, { plan }) : org;
}

// ---------------------------------------------------------------- listing

/**
 * `GET /app/api/github/orgs`: the organizations where Quiz's App is
 * installed. GitHub's listing is authoritative, and is written back (a new
 * installation recorded, a vanished one cleared) at most once per
 * {@link HEAL_TTL_MS}; when GitHub fails, the stored rows answer.
 */
export async function installedOrgs(
  db: Db,
  config: AppConfig,
  now: Date,
  log: FastifyBaseLogger,
): Promise<GithubOrg[]> {
  if (!listing || now.getTime() - listing.at >= HEAL_TTL_MS) {
    listing = {
      at: now.getTime(),
      done: syncInstallations(db, config).catch((err: unknown) => {
        log.warn({ err }, "listing the GitHub App's installations failed");
      }),
    };
  }
  await listing.done;
  const rows = await db
    .select()
    .from(githubOrganizations)
    .where(
      and(isNotNull(githubOrganizations.installationId), eq(githubOrganizations.status, "active")),
    )
    .orderBy(sql`lower(${githubOrganizations.login})`);
  return rows.map(orgView);
}

async function syncInstallations(db: Db, config: AppConfig): Promise<void> {
  const found = await listInstallations(config, HTTP_READ);
  for (const inst of found) await recordInstallation(db, inst, "listing");
  const listed = found.map((i) => i.installationId);
  const gone = await db
    .update(githubOrganizations)
    .set({ installationId: null })
    .where(
      and(
        isNotNull(githubOrganizations.installationId),
        listed.length > 0 ? notInArray(githubOrganizations.installationId, listed) : undefined,
      ),
    )
    .returning({ id: githubOrganizations.id });
  for (const { id } of gone) {
    await systemAudit(db, "github_org.installation_deleted", id, { via: "listing" });
  }
}

// ---------------------------------------------------------------- healing

/**
 * The lazy healing of a linked organization (§3.1, F-GH-03), once per
 * {@link HEAL_TTL_MS}: whatever GitHub says is written back to the row, and
 * the checks the row does not hold are returned. A GitHub failure leaves
 * the row as stored and the checks unknown.
 */
function checksOf(
  db: Db,
  config: AppConfig,
  org: OrgRow,
  now: Date,
  log: FastifyBaseLogger,
): Promise<GithubChecks> {
  const hit = healed.get(org.id);
  if (hit && now.getTime() - hit.at < HEAL_TTL_MS) return hit.checks;
  const checks = heal(db, config, org).catch((err: unknown) => {
    log.warn({ err, org: org.login }, "healing a GitHub organization failed");
    return UNKNOWN_CHECKS;
  });
  healed.set(org.id, { at: now.getTime(), checks });
  return checks;
}

async function heal(db: Db, config: AppConfig, stored: OrgRow): Promise<GithubChecks> {
  let org = stored;
  // A missing installation is looked for by the organization's login.
  const installationId =
    org.installationId ??
    (await resolveOrgInstallation(config, org.login, HTTP_READ))?.installationId ??
    null;
  const inst =
    installationId === null ? null : await fetchInstallation(config, installationId, HTTP_READ);
  if (!inst) {
    if (org.installationId !== null) {
      org = await patchOrg(db, org.id, { installationId: null });
      await systemAudit(db, "github_org.installation_deleted", org.id, { via: "healing" });
    }
    // Uninstalled, GitHub delivers nothing about the organization: whether it
    // still exists is asked. `null` (rate limit, network) keeps the stored status.
    const exists = await orgExistsOnGithub(org.login, config, HTTP_READ);
    const status = exists === null ? org.status : exists ? "active" : "deleted";
    if (status !== org.status) {
      org = await patchOrg(db, org.id, { status });
      if (status === "deleted") await systemAudit(db, "github_org.deleted", org.id, {});
    }
    return UNKNOWN_CHECKS;
  }
  org = await refreshPlan(config, db, await recordInstallation(db, inst, "healing"));
  const secret = await fetchOrgLlmSecret(config, inst.installationId, org.login, HTTP_READ);
  return {
    allRepositories: inst.allRepositories,
    llmSecret: secret === "ok" ? "present" : (secret ?? "unknown"),
  };
}

// ---------------------------------------------------------------- a classroom's link

interface Room {
  id: string;
  courseId: string;
}

/** `GET /app/api/classrooms/:id/github`: the link, healed, and what the connect sheet offers. */
export async function classroomGithub(
  db: Db,
  config: AppConfig,
  room: Room,
  now: Date,
  log: FastifyBaseLogger,
): Promise<GithubClassroom> {
  const [link] = await db
    .select({ org: githubOrganizations, linkedAt: githubClassroomLinks.linkedAt })
    .from(githubClassroomLinks)
    .innerJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
    .where(eq(githubClassroomLinks.classroomId, room.id))
    .limit(1);
  let view: GithubClassroom["link"] = null;
  if (link) {
    const checks = await checksOf(db, config, link.org, now, log);
    // The healing may have written the row: read it again.
    const [org] = await db
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.id, link.org.id));
    view = { org: orgView(org!), linkedAt: link.linkedAt.toISOString(), checks };
  }
  return {
    link: view,
    suggestedOrgId: await suggestedOrg(db, room),
    installUrl: installUrl(config, room.id),
  };
}

/**
 * The organization of the course's other classrooms (F-GH-02): the one most
 * of them use, the latest linked on a tie, among those the App is
 * installed on — the only ones the sheet can connect.
 */
async function suggestedOrg(db: Db, room: Room): Promise<string | null> {
  const [row] = await db
    .select({ orgId: githubClassroomLinks.orgId })
    .from(githubClassroomLinks)
    .innerJoin(classrooms, eq(classrooms.id, githubClassroomLinks.classroomId))
    .innerJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
    .where(
      and(
        eq(classrooms.courseId, room.courseId),
        ne(classrooms.id, room.id),
        isNotNull(githubOrganizations.installationId),
        eq(githubOrganizations.status, "active"),
      ),
    )
    .groupBy(githubClassroomLinks.orgId)
    .orderBy(desc(sql`count(*)`), desc(sql`max(${githubClassroomLinks.linkedAt})`))
    .limit(1);
  return row?.orgId ?? null;
}

/** The 409 of a connect or a disconnect, a code the web words. */
function refusal(code: (typeof GITHUB_CONNECT_REFUSALS)[number], message: string): DomainError {
  return new DomainError(code, 409, message);
}

/**
 * D28: while the classroom has a journal, its organization does not change.
 * Read by join: the journal module has no service yet (M4-02 moves it).
 */
async function refuseWithJournal(tx: Tx, classroomId: string): Promise<void> {
  const [journal] = await tx
    .select({ id: classroomJournals.classroomId })
    .from(classroomJournals)
    .where(eq(classroomJournals.classroomId, classroomId))
    .limit(1);
  if (journal) throw refusal("journal_attached", "Remove the classroom's journal first");
}

/**
 * Connects the classroom to an installed organization, or moves it to
 * another one (F-GH-01). Null when it already was: nothing written.
 */
export async function connectClassroom(
  db: Db,
  input: { classroomId: string; orgId: string; userId: string; now: Date },
): Promise<{ org: OrgRow; previousOrgId: string | null } | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ orgId: githubClassroomLinks.orgId })
      .from(githubClassroomLinks)
      .where(eq(githubClassroomLinks.classroomId, input.classroomId));
    if (current?.orgId === input.orgId) return null;
    const [org] = await tx
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.id, input.orgId));
    if (!org) throw new DomainError("not_found", 404, "Unknown organization");
    if (org.installationId === null || org.status !== "active") {
      throw refusal("app_not_installed", "Quiz's GitHub App is not installed on this organization");
    }
    await refuseWithJournal(tx, input.classroomId);
    const link = { orgId: org.id, linkedBy: input.userId, linkedAt: input.now };
    await tx
      .insert(githubClassroomLinks)
      .values({ classroomId: input.classroomId, ...link })
      .onConflictDoUpdate({ target: githubClassroomLinks.classroomId, set: link });
    return { org, previousOrgId: current?.orgId ?? null };
  });
}

/** Disconnects the classroom (F-GH-04); nothing on GitHub changes. The org it had, or null. */
export async function disconnectClassroom(db: Db, classroomId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ orgId: githubClassroomLinks.orgId })
      .from(githubClassroomLinks)
      .where(eq(githubClassroomLinks.classroomId, classroomId));
    if (!current) return null;
    await refuseWithJournal(tx, classroomId);
    await tx.delete(githubClassroomLinks).where(eq(githubClassroomLinks.classroomId, classroomId));
    return current.orgId;
  });
}

// ---------------------------------------------------------------- the setup return

/**
 * The App's Setup URL (N-SEC-17): the installation GitHub names is stored
 * only once the App's JWT confirms it; anything else stores nothing. It
 * links no classroom — the `PUT`, under `staffAccess`, does — and only
 * hints the staff of the organization's classrooms and of `state`'s.
 */
export async function completeSetup(
  db: Db,
  config: AppConfig,
  query: GithubSetupQuery,
  log: FastifyBaseLogger,
): Promise<void> {
  if (query.installation_id === undefined) return;
  let inst: AppInstallation | null;
  try {
    inst = await fetchInstallation(config, query.installation_id, HTTP_READ);
  } catch (err) {
    log.warn({ err, installationId: query.installation_id }, "verifying an installation failed");
    return;
  }
  if (!inst) return;
  let org = await recordInstallation(db, inst, "setup_url");
  healed.delete(org.id);
  listing = null;
  try {
    // Read while the installation is fresh: the `free` warning shows at once.
    org = await refreshPlan(config, db, org);
  } catch (err) {
    log.warn({ err, org: org.login }, "reading an organization's plan failed");
  }
  const rooms = await db
    .select({ courseId: classrooms.courseId })
    .from(classrooms)
    .leftJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, classrooms.id))
    .where(
      or(
        eq(githubClassroomLinks.orgId, org.id),
        query.state === undefined ? undefined : eq(classrooms.id, query.state),
      ),
    );
  installationChanged(rooms.map((r) => r.courseId));
}

// ---------------------------------------------------------------- avatar

/**
 * An organization's avatar, served same-origin so that a viewer's IP never
 * reaches GitHub (05-web §5.3, M1-04 `OrgAvatar`).
 *
 * DERIVED, not stored: the address is `avatars.githubusercontent.com/u/<id>`
 * from the immutable `github_org_id`, the image is fetched server-side and
 * kept in memory. No column and no migration; an organization that changes
 * its picture shows the new one within a day, with no refresh job; the
 * cache is bounded (a handful of organizations, a few KB each) and a
 * restart only refetches. A store would need all of that written.
 */
export interface OrgAvatar {
  bytes: Buffer;
  mime: string;
}
/** What is served: the declared type must be one of these AND match the bytes. */
const AVATAR_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_TTL_MS = 24 * 3_600_000;
/** A failed fetch is not retried for this long. */
const AVATAR_MISS_TTL_MS = 10 * 60_000;
const AVATAR_CACHE_MAX = 500;
/** The size asked of GitHub: the largest `OrgAvatar` drawn, at 2x. */
const AVATAR_SIZE = 96;

export async function orgAvatar(
  db: Db,
  orgId: string,
  now: Date,
  log: FastifyBaseLogger,
): Promise<OrgAvatar | null> {
  const [org] = await db
    .select({ githubOrgId: githubOrganizations.githubOrgId })
    .from(githubOrganizations)
    .where(eq(githubOrganizations.id, orgId));
  if (!org || org.githubOrgId === null) return null;
  const key = org.githubOrgId;
  const hit = avatars.get(key);
  if (hit && now.getTime() - hit.at < hit.ttl) return hit.image;
  const entry = {
    at: now.getTime(),
    ttl: AVATAR_TTL_MS,
    image: downloadAvatar(key).catch((err: unknown) => {
      log.warn({ err, githubOrgId: key }, "fetching an organization's avatar failed");
      return null;
    }),
  };
  void entry.image.then((image) => {
    if (!image) entry.ttl = AVATAR_MISS_TTL_MS;
  });
  avatars.delete(key);
  avatars.set(key, entry);
  // Oldest first out: a Map iterates in insertion order.
  if (avatars.size > AVATAR_CACHE_MAX) avatars.delete(avatars.keys().next().value!);
  return entry.image;
}

async function downloadAvatar(githubOrgId: number): Promise<OrgAvatar | null> {
  const res = await fetch(
    `https://avatars.githubusercontent.com/u/${githubOrgId}?s=${AVATAR_SIZE}&v=4`,
    // Never followed elsewhere: the one host, or nothing.
    { redirect: "error", signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok || !res.body) return null;
  const declared = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!AVATAR_TYPES.has(declared)) return null;
  const bytes = await readCapped(res.body, AVATAR_MAX_BYTES);
  // The bytes decide, not the header (as for an uploaded avatar).
  if (!bytes || sniffImage(bytes)?.mime !== declared) return null;
  return { bytes, mime: declared };
}

async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}
