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
 * The routes exist only when Quiz's App is configured (`app.ts`).
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { and, desc, eq, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";

import {
  AvatarMime,
  type GITHUB_CONNECT_REFUSALS,
  type GithubChecks,
  type GithubClassroom,
  type GithubOrg,
  type GithubSetupQuery,
} from "@quiz/contracts";

import { audit } from "../../audit.js";
import { readCapped } from "../../cappedBody.js";
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
  listInstalledOrgs,
  orgExistsOnGithub,
  resolveOrgInstallation,
  type AppInstallation,
} from "../../github/app.js";
import { DomainError } from "../http.js";
import { sniffImage } from "../pool/assets.js";
import { installationChanged } from "./events.js";

type OrgRow = typeof githubOrganizations.$inferSelect;

/**
 * How long a healing stands before GitHub is asked again (03 §3.1). The
 * classroom's Settings are opened, refreshed by every SSE hint and
 * re-opened; one minute keeps that from costing GitHub round trips (and
 * writes) each time, while a teacher who just fixed something on GitHub
 * sees it on the next open after a minute. The setup return drops the
 * cache of the organization it touched.
 */
export const HEAL_TTL_MS = 60_000;

const UNKNOWN_CHECKS: GithubChecks = { allRepositories: null, llmSecret: "unknown" };

interface Healed {
  org: OrgRow;
  checks: GithubChecks;
}

// ---------------------------------------------------------------- caches

/** The last healing of each organization, by row id; the promise is shared by concurrent reads. */
const healed = new Map<string, { at: number; result: Promise<Healed> }>();
/** Avatars by GitHub's organization id (below). */
const avatars = new Map<number, { at: number; image: Promise<OrgAvatar | null> }>();

/** Test hook: every cache of this module emptied. */
export function resetGithubCaches(): void {
  healed.clear();
  avatars.clear();
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

/** Where a fact about an organization was learnt, as its audit says (`payload.via`). */
type Via = "setup_url" | "listing" | "healing" | "webhook";

function systemAudit(
  db: Db | Tx,
  action:
    | "github_org.installation_resolved"
    | "github_org.installation_deleted"
    | "github_org.renamed"
    | "github_org.deleted",
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

const sameLogin = (login: string) => sql`lower(${githubOrganizations.login}) = lower(${login})`;

/**
 * Every OTHER row holding `login` gives it up. A login is not an identity:
 * GitHub frees the login of a deleted or renamed organization, and another
 * organization may take it. The row that held it is therefore never
 * re-pointed at the newcomer — its classrooms would silently follow an
 * organization their staff never chose. It is marked `deleted`, its
 * installation cleared, and its login moved aside (`<login>~<row id>`) so
 * the UNIQUE lets the newcomer have its own row. Its links stay on it; if
 * it was only renamed, its next installation (matched by id) brings it back
 * under its new login.
 */
async function retireLoginHolders(db: Db, login: string, keep: string | null): Promise<void> {
  const holders = await db
    .select()
    .from(githubOrganizations)
    .where(and(sameLogin(login), keep === null ? undefined : ne(githubOrganizations.id, keep)));
  for (const holder of holders) {
    await patchOrg(db, holder.id, {
      login: `${holder.login}~${holder.id}`,
      status: "deleted",
      installationId: null,
    });
    await systemAudit(db, "github_org.deleted", holder.id, {
      reason: "login_reused",
      login: holder.login,
      installationId: holder.installationId,
    });
  }
}

/**
 * An organization renamed on GitHub, followed by its immutable id: a row
 * already holding the new login under another id is retired first, never
 * taken over ({@link retireLoginHolders}). Audited with where it was learnt.
 */
async function followRename(db: Db, row: OrgRow, login: string, via: Via): Promise<OrgRow> {
  await retireLoginHolders(db, login, row.id);
  const renamed = await patchOrg(db, row.id, { login });
  await systemAudit(db, "github_org.renamed", row.id, { from: row.login, to: login, via });
  return renamed;
}

/**
 * The rows matching `where` forget their installation, each audited
 * `installation_deleted` with `via` and `extra`. Only rows that still held
 * one are written, so a replay writes and audits nothing.
 */
async function forgetInstallation(
  db: Db,
  where: SQL | undefined,
  via: Via,
  extra: Record<string, unknown> = {},
): Promise<OrgRow[]> {
  const rows = await db
    .update(githubOrganizations)
    .set({ installationId: null })
    .where(and(isNotNull(githubOrganizations.installationId), where))
    .returning();
  for (const row of rows) {
    await systemAudit(db, "github_org.installation_deleted", row.id, { via, ...extra });
  }
  return rows;
}

/**
 * The row of an organization GitHub has just shown installed, created or
 * brought up to date: the installation, the login (a rename is followed by
 * the immutable id), `active`. Idempotent: a second call with the same
 * installation writes and audits nothing.
 *
 * Matched by `github_org_id`; by login only for a row that has no id yet
 * (imported by M8-01). A row holding the login under ANOTHER id is never
 * taken over ({@link retireLoginHolders}).
 */
export async function recordInstallation(
  db: Db,
  inst: AppInstallation,
  via: Via,
): Promise<OrgRow> {
  const [byId] = await db
    .select()
    .from(githubOrganizations)
    .where(eq(githubOrganizations.githubOrgId, inst.githubOrgId));
  const [imported] = byId
    ? []
    : await db
        .select()
        .from(githubOrganizations)
        .where(and(isNull(githubOrganizations.githubOrgId), sameLogin(inst.login)));
  let known = byId ?? imported;
  if (known && known.login !== inst.login) known = await followRename(db, known, inst.login, via);
  else await retireLoginHolders(db, inst.login, known?.id ?? null);
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
      known.githubOrgId === inst.githubOrgId &&
      known.status === "active";
    row = current
      ? known
      : await patchOrg(db, known.id, {
          installationId: inst.installationId,
          githubOrgId: inst.githubOrgId,
          status: "active",
        });
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
 * installed. GitHub's listing is authoritative and is written back on each
 * call (a new installation recorded, a vanished one cleared); when GitHub
 * fails, the stored rows answer.
 */
export async function installedOrgs(
  db: Db,
  config: AppConfig,
  log: FastifyBaseLogger,
): Promise<GithubOrg[]> {
  try {
    await syncInstallations(db, config);
  } catch (err) {
    log.warn({ err }, "listing the GitHub App's installations failed");
  }
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
  const found = await listInstalledOrgs(config, HTTP_READ);
  for (const inst of found) await recordInstallation(db, inst, "listing");
  const listed = found.map((i) => i.installationId);
  await forgetInstallation(
    db,
    listed.length > 0 ? notInArray(githubOrganizations.installationId, listed) : undefined,
    "listing",
  );
}

// ---------------------------------------------------------------- webhook events

/**
 * What the `installation`, `installation_repositories` and `organization`
 * handlers (`handlers.ts`, M2-04) write. Each is idempotent (ADR-011): a
 * replay writes and audits nothing more.
 */

/**
 * An `installation` event, whatever its action: the event says only WHICH
 * installation changed, and GitHub's CURRENT state of it is what is
 * recorded (`GET /app/installations/{id}` with the App's JWT) — installed,
 * through {@link recordInstallation}; gone or suspended, forgotten. So a
 * delivery replayed out of order (a failed `created` replayed after the
 * `deleted` that followed it) can never bring back an installation GitHub
 * no longer has. A GitHub failure throws: the delivery is retried. The
 * organization touched, or null.
 */
export async function resyncInstallation(
  db: Db,
  config: AppConfig,
  installationId: number,
  action: string,
): Promise<OrgRow | null> {
  const inst = await fetchInstallation(config, installationId);
  if (inst) return recordInstallation(db, inst, "webhook");
  const [forgotten] = await forgetInstallation(
    db,
    eq(githubOrganizations.installationId, installationId),
    "webhook",
    { action, installationId },
  );
  return forgotten ?? null;
}

/**
 * An organization renamed on GitHub ({@link followRename}). Null when the
 * organization is unknown.
 */
export async function renameOrg(db: Db, githubOrgId: number, login: string): Promise<OrgRow | null> {
  const [row] = await db
    .select()
    .from(githubOrganizations)
    .where(eq(githubOrganizations.githubOrgId, githubOrgId));
  if (!row || row.login === login) return row ?? null;
  return followRename(db, row, login, "webhook");
}

/**
 * An organization deleted on GitHub: `deleted`, its installation gone with
 * it. The row and its links stay (they are the history of its classrooms).
 */
export async function markOrgDeleted(db: Db, githubOrgId: number): Promise<OrgRow | null> {
  const [row] = await db
    .select()
    .from(githubOrganizations)
    .where(eq(githubOrganizations.githubOrgId, githubOrgId));
  if (!row || (row.status === "deleted" && row.installationId === null)) return row ?? null;
  const deleted = await patchOrg(db, row.id, { status: "deleted", installationId: null });
  await systemAudit(db, "github_org.deleted", row.id, {
    via: "webhook",
    installationId: row.installationId,
  });
  return deleted;
}

/**
 * An organization changed outside a request (a webhook, the setup return):
 * its healing is dropped, so the next open reads GitHub again, and the staff
 * of its classrooms — and of `alsoClassroomId`'s, the setup return's
 * `state` — get the hint that turns their Settings (F-GH-02).
 */
export async function orgChanged(db: Db, orgId: string, alsoClassroomId?: string): Promise<void> {
  healed.delete(orgId);
  const rooms = await db
    .select({ courseId: classrooms.courseId })
    .from(classrooms)
    .leftJoin(githubClassroomLinks, eq(githubClassroomLinks.classroomId, classrooms.id))
    .where(
      or(
        eq(githubClassroomLinks.orgId, orgId),
        alsoClassroomId === undefined ? undefined : eq(classrooms.id, alsoClassroomId),
      ),
    );
  installationChanged(rooms.map((r) => r.courseId));
}

/** The organization row holding an installation, if any. */
export async function orgOfInstallation(db: Db, installationId: number): Promise<OrgRow | null> {
  const [row] = await db
    .select()
    .from(githubOrganizations)
    .where(eq(githubOrganizations.installationId, installationId));
  return row ?? null;
}

// ---------------------------------------------------------------- healing

/**
 * The lazy healing of a linked organization (§3.1, F-GH-03), once per
 * {@link HEAL_TTL_MS}: whatever GitHub says is written back to the row, and
 * the checks the row does not hold are returned. A GitHub failure leaves
 * the row as stored and the checks unknown. Within the TTL the row is the
 * one just read, the checks those of the last healing.
 */
async function healedOrg(
  db: Db,
  config: AppConfig,
  org: OrgRow,
  now: Date,
  log: FastifyBaseLogger,
): Promise<Healed> {
  const hit = healed.get(org.id);
  if (hit && now.getTime() - hit.at < HEAL_TTL_MS) return { org, checks: (await hit.result).checks };
  const result = heal(db, config, org).catch((err: unknown) => {
    log.warn({ err, org: org.login }, "healing a GitHub organization failed");
    return { org, checks: UNKNOWN_CHECKS };
  });
  healed.set(org.id, { at: now.getTime(), result });
  return result;
}

async function heal(db: Db, config: AppConfig, stored: OrgRow): Promise<Healed> {
  let org = stored;
  // One call: the stored installation, else one looked for by the login.
  const inst =
    org.installationId !== null
      ? await fetchInstallation(config, org.installationId, HTTP_READ)
      : await resolveOrgInstallation(config, org.login, HTTP_READ);
  if (inst && org.githubOrgId !== null && inst.githubOrgId !== org.githubOrgId) {
    // The login now names ANOTHER organization: ours was deleted or renamed
    // away. The newcomer is recorded under its own row, which retires ours;
    // ours is never re-pointed.
    await recordInstallation(db, inst, "healing");
    const [retired] = await db
      .select()
      .from(githubOrganizations)
      .where(eq(githubOrganizations.id, org.id));
    return { org: retired!, checks: UNKNOWN_CHECKS };
  }
  if (!inst) {
    const [forgotten] = await forgetInstallation(db, eq(githubOrganizations.id, org.id), "healing");
    org = forgotten ?? org;
    // Uninstalled, GitHub delivers nothing about the organization: whether it
    // still exists is asked. `null` (rate limit, network) keeps the stored status.
    const exists = await orgExistsOnGithub(org.login, config, HTTP_READ);
    const status = exists === null ? org.status : exists ? "active" : "deleted";
    if (status !== org.status) {
      org = await patchOrg(db, org.id, { status });
      if (status === "deleted") await systemAudit(db, "github_org.deleted", org.id, {});
    }
    return { org, checks: UNKNOWN_CHECKS };
  }
  org = await refreshPlan(config, db, await recordInstallation(db, inst, "healing"));
  const secret = await fetchOrgLlmSecret(config, inst.installationId, org.login, HTTP_READ);
  return {
    org,
    checks: {
      allRepositories: inst.allRepositories,
      llmSecret: secret === "ok" ? "present" : (secret ?? "unknown"),
    },
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
    const { org, checks } = await healedOrg(db, config, link.org, now, log);
    view = { org: orgView(org), linkedAt: link.linkedAt.toISOString(), checks };
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
  try {
    // Read while the installation is fresh: the `free` warning shows at once.
    org = await refreshPlan(config, db, org);
  } catch (err) {
    log.warn({ err, org: org.login }, "reading an organization's plan failed");
  }
  await orgChanged(db, org.id, query.state);
}

// ---------------------------------------------------------------- avatar

/**
 * An organization's avatar, served same-origin so that a viewer's IP never
 * reaches GitHub (05-web §5.3, M1-04 `OrgAvatar`).
 *
 * DERIVED, not stored: the address is `avatars.githubusercontent.com/u/<id>`
 * from the immutable `github_org_id`, the image is fetched server-side and
 * kept in memory. No column and no migration; an organization that changes
 * its picture shows the new one within a day, with no refresh job; the keys
 * are the organizations' rows, a handful, and a restart only refetches. A
 * failed fetch is not kept: the next request tries again.
 */
export interface OrgAvatar {
  bytes: Buffer;
  mime: string;
}
/** What is served: the uploaded avatars' list (`AvatarMime`), the bytes matching the declared type. */
const AVATAR_TYPES: ReadonlySet<string> = new Set<string>(AvatarMime.options);
export const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_TTL_MS = 24 * 3_600_000;
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
  if (hit && now.getTime() - hit.at < AVATAR_TTL_MS) return hit.image;
  const entry = {
    at: now.getTime(),
    image: downloadAvatar(key).catch((err: unknown) => {
      log.warn({ err, githubOrgId: key }, "fetching an organization's avatar failed");
      return null;
    }),
  };
  avatars.set(key, entry);
  const image = await entry.image;
  if (!image && avatars.get(key) === entry) avatars.delete(key);
  return image;
}

async function downloadAvatar(githubOrgId: number): Promise<OrgAvatar | null> {
  const res = await fetch(
    `https://avatars.githubusercontent.com/u/${githubOrgId}?s=${AVATAR_SIZE}&v=4`,
    // Never followed elsewhere: the one host, or nothing.
    { redirect: "error", signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) return null;
  const declared = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!AVATAR_TYPES.has(declared)) return null;
  const bytes = await readCapped(res, AVATAR_MAX_BYTES);
  // The bytes decide, not the header (as for an uploaded avatar).
  if (!bytes || sniffImage(bytes)?.mime !== declared) return null;
  return { bytes, mime: declared };
}

// ---------------------------------------------------------------- the webhook registry

/**
 * What other modules register on the webhook intake (M2-04): the journal
 * its push handler (M4-02), projects their receipts (M3). Defined in
 * `deliveries.ts`; reached through this entry, like the rest of the module.
 */
export {
  onEvent,
  onReceipt,
  type ReceiptTracker,
  type WebhookDelivery,
  type WebhookHandler,
} from "./deliveries.js";
