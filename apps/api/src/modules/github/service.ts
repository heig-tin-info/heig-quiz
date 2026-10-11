/**
 * The `github` module (ADR-035, spec 05 §5.11, docs/merge/03-github-projects.md
 * §3.1 "Org onboarding"): the organizations where Quiz's App (D23) is
 * installed, a classroom's link to one of them, the App's setup return, the
 * lazy healing of an organization, and its avatar. Ported from
 * heig-classroom's `modules/classrooms.ts` (sync point `ab98cc0`).
 *
 * This module owns `github_organizations`, `github_classroom_links` and
 * `github_org_grants` (ADR-100); it reads `classroom_journals` by join (D28),
 * inside its own transaction:
 * `github` never imports the `journal` module, which registers on it.
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
  GITHUB_ORG_NOT_ALLOWED,
  type GITHUB_CONNECT_REFUSALS,
  type GithubChecks,
  type GithubClassroom,
  type GithubOrg,
  type GithubSetupQuery,
} from "@quiz/contracts";

import { audit } from "../../audit.js";
import { linkedLogin } from "../../auth/linkedLogin.js";
import { readCapped } from "../../cappedBody.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import {
  classroomJournals,
  classrooms,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  githubOrgGrants,
  pushReceipts,
} from "../../db/schema.js";
import {
  fetchInstallation,
  fetchOrgLlmSecret,
  fetchOrgPlan,
  githubStatus,
  HTTP_READ,
  installationClient,
  isOrgOwner,
  listInstalledOrgs,
  orgExistsOnGithub,
  resolveOrgInstallation,
  type AppInstallation,
} from "../../github/app.js";
import { DomainError } from "../http.js";
import { notifyUsers } from "../notifications/service.js";
import { accessWhere, classroomStaffIds, staffAccess, type Caller } from "../guards.js";
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
    // Installed, not suspended, active (`actsOn`): a suspended installation
    // shows as none. A deleted row never holds an installation (`markOrgDeleted`,
    // `retireLoginHolders`), so `installed` and `status` stay the two
    // independent facts the contract shows.
    installed: actsOn(row),
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
    | "github_org.installation_suspended"
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
      suspendedAt: null,
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
 * The organization is LOST to its classrooms (F-PROJ-18, F-NOTIF-13
 * `github_org_lost`; M3-09b): GitHub no longer has the installation it held
 * — uninstalled, or the organization deleted with it. The course staff of
 * each of its non-archived classrooms are told, one entry per classroom,
 * which opens that classroom's Settings. Called on the row's actual
 * transition only (the installation it held forgotten), so a replay, a
 * suspension (the installation stays, `suspended_at` set) and the status of
 * an organization never installed tell nobody; GitHub's sender is no Quiz
 * account, so F-NOTIF-11's "own action" cannot apply. Best-effort, after
 * the write: a failure is logged.
 */
async function orgLost(db: Db, org: OrgRow): Promise<void> {
  try {
    const rooms = await db
      .select({ classroomId: classrooms.id, classroomName: classrooms.name })
      .from(githubClassroomLinks)
      .innerJoin(classrooms, eq(classrooms.id, githubClassroomLinks.classroomId))
      .where(and(eq(githubClassroomLinks.orgId, org.id), isNull(classrooms.archivedAt)));
    for (const room of rooms) {
      await notifyUsers(db, await classroomStaffIds(db, room.classroomId), {
        kind: "github_org_lost",
        classroomId: room.classroomId,
        classroomName: room.classroomName,
        orgLogin: org.login,
      });
    }
  } catch (err) {
    // The service layer has no logger (as `realtime/bus.ts`): stderr.
    console.error(`github: telling the staff that ${org.login} is lost failed`, err);
  }
}

/**
 * The rows matching `where` forget their installation — GitHub no longer has
 * it (a suspended one it still has: {@link recordInstallation}) —, each
 * audited `installation_deleted` with `via` and `extra`, and their
 * classrooms' staff told ({@link orgLost}). Only rows that still held one
 * are written, so a replay writes, audits and tells nothing.
 */
async function forgetInstallation(
  db: Db,
  where: SQL | undefined,
  via: Via,
  extra: Record<string, unknown> = {},
): Promise<OrgRow[]> {
  const rows = await db
    .update(githubOrganizations)
    .set({ installationId: null, suspendedAt: null })
    .where(and(isNotNull(githubOrganizations.installationId), where))
    .returning();
  for (const row of rows) {
    await systemAudit(db, "github_org.installation_deleted", row.id, { via, ...extra });
    await orgLost(db, row);
  }
  return rows;
}

/**
 * The row of an organization GitHub has just shown installed, created or
 * brought up to date: the installation, its suspension (`suspended_at`,
 * audited `installation_suspended` when it changes), the login (a rename
 * is followed by the immutable id), `active`. Idempotent: a second call
 * with the same installation writes and audits nothing.
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
  // When Quiz first saw the suspension, by its own clock (GitHub's own
  // moment is not kept): the rule reads the column's presence, not its time.
  const suspendedAt = inst.suspended ? (known?.suspendedAt ?? new Date()) : null;
  if (!known) {
    const [created] = await db
      .insert(githubOrganizations)
      .values({
        id: randomUUID(),
        githubOrgId: inst.githubOrgId,
        login: inst.login,
        installationId: inst.installationId,
        suspendedAt,
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
      known.status === "active" &&
      (known.suspendedAt !== null) === inst.suspended;
    row = current
      ? known
      : await patchOrg(db, known.id, {
          installationId: inst.installationId,
          githubOrgId: inst.githubOrgId,
          suspendedAt,
          status: "active",
        });
  }
  if (known?.installationId !== inst.installationId) {
    await systemAudit(db, "github_org.installation_resolved", row.id, {
      installationId: inst.installationId,
      via,
    });
  } else if ((known.suspendedAt !== null) !== inst.suspended) {
    await systemAudit(db, "github_org.installation_suspended", row.id, { suspended: inst.suspended, via });
  }
  return row;
}

/** Re-reads the plan while it is unknown or `free`, so the warning clears once the organization upgrades. */
async function refreshPlan(config: AppConfig, db: Db, org: OrgRow): Promise<OrgRow> {
  const acting = installed(org);
  if (!acting || (org.plan !== null && org.plan !== "free")) return org;
  const plan = await fetchOrgPlan(config, acting.installationId, org.login, HTTP_READ);
  return plan && plan !== org.plan ? patchOrg(db, org.id, { plan }) : org;
}

// ---------------------------------------------------------------- listing

/**
 * `GET /app/api/classrooms/:id/github/orgs`, what the connect sheet of a
 * classroom offers (F-GH-02, ADR-100): the organizations Quiz's App acts on
 * that are granted to the classroom's course, plus those the caller's
 * linked GitHub account owns (who may grant them by connecting); all of
 * them to a caller with Super Powers. Read when the sheet opens: GitHub's
 * listing of the installations is authoritative and written back on each
 * call; when GitHub fails, the stored rows answer, and an ownership GitHub
 * could not confirm is not offered.
 */
export async function connectableOrgs(
  db: Db,
  config: AppConfig,
  room: Room,
  caller: Caller,
  log: FastifyBaseLogger,
): Promise<GithubOrg[]> {
  try {
    await syncInstallations(db, config);
  } catch (err) {
    log.warn({ err }, "listing the GitHub App's installations failed");
  }
  const rows = await db
    .select({ org: githubOrganizations, grantedTo: githubOrgGrants.courseId })
    .from(githubOrganizations)
    .leftJoin(
      githubOrgGrants,
      and(eq(githubOrgGrants.orgId, githubOrganizations.id), eq(githubOrgGrants.courseId, room.courseId)),
    )
    .where(ACTS)
    .orderBy(sql`lower(${githubOrganizations.login})`);
  if (caller.reach === "all") return rows.map((r) => orgView(r.org));
  const [account] = rows.every((r) => r.grantedTo !== null)
    ? []
    : await db.select().from(githubAccounts).where(eq(githubAccounts.userId, caller.id));
  const offered = await Promise.all(
    rows.map(
      (r) => r.grantedTo !== null || (account !== undefined && ownsOrg(db, config, installed(r.org)!, account, log)),
    ),
  );
  return rows.filter((_, i) => offered[i]).map((r) => orgView(r.org));
}

/** Whether the organization is granted to the course (ADR-100); inside a connect, the row share-locked. */
async function isGranted(db: Db | Tx, orgId: string, courseId: string, lock = false): Promise<boolean> {
  const query = db
    .select({ orgId: githubOrgGrants.orgId })
    .from(githubOrgGrants)
    .where(and(eq(githubOrgGrants.orgId, orgId), eq(githubOrgGrants.courseId, courseId)))
    .limit(1);
  return (await (lock ? query.for("share") : query)).length > 0;
}

/**
 * Does the linked GitHub `account` (F-GH-05) own the organization? Its
 * login as GitHub knows it today (`linkedLogin`, which follows a rename by
 * the immutable id), then {@link isOrgOwner}, both through the
 * installation. Any GitHub failure is a no, logged: an ownership GitHub did
 * not confirm grants nothing (ADR-100).
 */
async function ownsOrg(
  db: Db,
  config: AppConfig,
  org: InstalledOrg,
  account: typeof githubAccounts.$inferSelect,
  log: FastifyBaseLogger,
): Promise<boolean> {
  try {
    const { octokit } = await installationClient(config, org.installationId);
    const login = await linkedLogin(db, octokit, account.userId, account);
    return typeof login === "string" && (await isOrgOwner(octokit, org, { githubUserId: account.githubUserId, login }));
  } catch (err) {
    log.warn({ status: githubStatus(err), org: org.login }, "reading an organization's ownership failed");
    return false;
  }
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
 * recorded (`GET /app/installations/{id}` with the App's JWT) — installed
 * or suspended, through {@link recordInstallation}; gone, forgotten and the
 * staff told it is lost. So a delivery replayed out of order (a failed
 * `created` replayed after the `deleted` that followed it) can never bring
 * back an installation GitHub no longer has, and the webhook's `action`
 * decides nothing (it only goes to the audit). A GitHub failure throws: the
 * delivery is retried. The organization touched, or null.
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
 * Its staff are told once, when the installation goes with it ({@link
 * orgLost}): an organization whose App was already gone told them then.
 */
export async function markOrgDeleted(db: Db, githubOrgId: number): Promise<OrgRow | null> {
  const [row] = await db
    .select()
    .from(githubOrganizations)
    .where(eq(githubOrganizations.githubOrgId, githubOrgId));
  if (!row || (row.status === "deleted" && row.installationId === null)) return row ?? null;
  const deleted = await patchOrg(db, row.id, { status: "deleted", installationId: null, suspendedAt: null });
  await systemAudit(db, "github_org.deleted", row.id, {
    via: "webhook",
    installationId: row.installationId,
  });
  if (row.installationId !== null) await orgLost(db, deleted);
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
  if (inst?.suspended) {
    // Still there, acting as none: nothing more is asked of GitHub.
    return { org: await recordInstallation(db, inst, "healing"), checks: UNKNOWN_CHECKS };
  }
  if (!inst) {
    // The installation GitHub no longer has (a 404 the webhooks never told
    // of) is forgotten, and its classrooms' staff told it is lost.
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

/** `GET /app/api/classrooms/:id/github`: the link, healed, and what the connect sheet needs beside its list. */
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
 * installed on — the only ones the sheet can connect. (Granted to the
 * course by construction: each of those classrooms was connected under a
 * grant, ADR-100.)
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
        ACTS,
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
 * D28: while the classroom has a GitHub-mode journal, its organization does
 * not change; a Quiz-mode one needs no GitHub at all (ADR-057, F-GH-04).
 * Read in the connect's transaction; `github` never imports `journal`.
 */
async function refuseWithJournal(tx: Tx, classroomId: string): Promise<void> {
  const [journal] = await tx
    .select({ id: classroomJournals.classroomId })
    .from(classroomJournals)
    .where(and(eq(classroomJournals.classroomId, classroomId), eq(classroomJournals.mode, "github")))
    .limit(1);
  if (journal) throw refusal("journal_attached", "Remove the classroom's journal first");
}

/** How a connect granted its organization to the course (ADR-100), as `github_org.grant` says. */
export type GrantVia = "owner" | "super_powers";

/** A connect that wrote: the organization, the one it replaced, and the grant it wrote, if any. */
export interface Connected {
  org: OrgRow;
  previousOrgId: string | null;
  granted: GrantVia | null;
}

/**
 * Connects the classroom to an installed organization, or moves it to
 * another one (F-GH-01). Null when it already was: nothing written.
 *
 * The organization must be granted to the classroom's course (ADR-100). A
 * connect writes that grant itself when the caller holds Super Powers
 * (ADR-054), or when the caller's linked GitHub account owns the
 * organization — asked of GitHub now, outside the transaction. Otherwise
 * `403 org_not_allowed`, nothing written; to a caller who may not grant,
 * that one answer covers an organization missing, uninstalled or not
 * theirs alike. The grant is read again, share-locked, in the transaction
 * that writes the link, so a revocation cannot slip in between.
 */
export async function connectClassroom(
  db: Db,
  config: AppConfig,
  input: { room: Room; orgId: string; caller: Caller; now: Date },
  log: FastifyBaseLogger,
): Promise<Connected | null> {
  const { room, orgId, caller } = input;
  const linked = async (tx: Db | Tx) =>
    (
      await tx
        .select({ orgId: githubClassroomLinks.orgId })
        .from(githubClassroomLinks)
        .where(eq(githubClassroomLinks.classroomId, room.id))
    )[0];
  if ((await linked(db))?.orgId === orgId) return null;
  const [org] = await db.select().from(githubOrganizations).where(eq(githubOrganizations.id, orgId));
  const acting = org ? installed(org) : null;
  let via: GrantVia | null = null;
  if (!org || !(await isGranted(db, org.id, room.courseId))) {
    if (caller.reach === "all") via = "super_powers";
    else if (acting && (await callerOwns(db, config, acting, caller.id, log))) via = "owner";
    else throw notAllowed();
  }
  if (!org) throw new DomainError("not_found", 404, "Unknown organization");
  if (!acting) throw refusal("app_not_installed", "Quiz's GitHub App is not installed on this organization");

  return db.transaction(async (tx) => {
    const current = await linked(tx);
    if (current?.orgId === orgId) return null;
    if (via === null && !(await isGranted(tx, org.id, room.courseId, true))) throw notAllowed();
    await refuseWithJournal(tx, room.id);
    const link = { orgId: org.id, linkedBy: caller.id, linkedAt: input.now };
    await tx
      .insert(githubClassroomLinks)
      .values({ classroomId: room.id, ...link })
      .onConflictDoUpdate({ target: githubClassroomLinks.classroomId, set: link });
    let granted: GrantVia | null = null;
    if (via !== null) {
      const grant = { orgId: org.id, courseId: room.courseId, grantedBy: caller.id, grantedAt: input.now };
      const wrote = await tx.insert(githubOrgGrants).values(grant).onConflictDoNothing().returning({ orgId: githubOrgGrants.orgId });
      if (wrote.length > 0) granted = via;
      // Another connect wrote it meanwhile: it must still be there, share-locked
      // until this link commits; a revocation that took it away first is
      // undone by this grant, so a link never stands without one.
      else if (!(await isGranted(tx, org.id, room.courseId, true))) {
        await tx.insert(githubOrgGrants).values(grant);
        granted = via;
      }
    }
    return { org, previousOrgId: current?.orgId ?? null, granted };
  });
}

/** The `403` of a connect to an organization the caller may not use (ADR-100). */
function notAllowed(): DomainError {
  return new DomainError(
    GITHUB_ORG_NOT_ALLOWED,
    403,
    "This organization is not granted to this course: ask one of its owners or an administrator",
  );
}

/** Does the caller's linked GitHub account, if any, own the organization ({@link ownsOrg})? */
async function callerOwns(
  db: Db,
  config: AppConfig,
  org: InstalledOrg,
  userId: string,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  return account !== undefined && ownsOrg(db, config, org, account, log);
}

/**
 * Removes an organization's grant to a course (ADR-100; an admin with Super
 * Powers, the route's guard): `409 classroom_connected` while a classroom of
 * the course is connected to it, as D28 holds a link with its journal.
 * False when there was no such grant. The row is deleted first, so a
 * connect holding it share-locked finishes before the links are read, and
 * one that comes after finds no grant.
 */
export async function revokeGrant(db: Db, courseId: string, orgId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gone = await tx
      .delete(githubOrgGrants)
      .where(and(eq(githubOrgGrants.orgId, orgId), eq(githubOrgGrants.courseId, courseId)))
      .returning({ orgId: githubOrgGrants.orgId });
    if (gone.length === 0) return false;
    const [held] = await tx
      .select({ id: classrooms.id })
      .from(githubClassroomLinks)
      .innerJoin(classrooms, eq(classrooms.id, githubClassroomLinks.classroomId))
      .where(and(eq(githubClassroomLinks.orgId, orgId), eq(classrooms.courseId, courseId)))
      .limit(1);
    if (held) {
      throw new DomainError("classroom_connected", 409, "Disconnect the course's classrooms from this organization first");
    }
    return true;
  });
}

/**
 * The GitHub repositories, among `ids`, that Quiz knows as a course's and
 * that the caller may not reach (ADR-100 §5): a repository is known as a
 * course's when it is a project's source, distribution or student
 * repository, or a journal's, in one of the course's classrooms; it is off
 * limits when every course it is known for is one where the caller holds no
 * seat. A repository Quiz does not know is not: inside a granted
 * organization the grant is the boundary. Nothing is off limits to a caller
 * with Super Powers. Reads `project` and `journal` tables by join, as
 * {@link purgeProjectReceipts} does.
 */
export async function offLimitsRepos(db: Db, caller: Caller, ids: number[]): Promise<Set<number>> {
  if (caller.reach === "all" || ids.length === 0) return new Set();
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    SELECT k.repo_id FROM (
      SELECT p.repo_id, p.classroom_id FROM (${PROJECT_REPO_REFS}) p WHERE p.repo_id IN (${list})
      UNION SELECT j.github_repo_id, j.classroom_id FROM classroom_journals j WHERE j.github_repo_id IN (${list})
    ) k
    JOIN classrooms c ON c.id = k.classroom_id
    GROUP BY k.repo_id
    HAVING NOT bool_or(${staffAccess(caller.id, sql`c.course_id`)})`);
  return new Set((result as unknown as { rows: { repo_id: number | string }[] }).rows.map((r) => Number(r.repo_id)));
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
 * links no classroom and grants no course (ADR-100): it has no session,
 * and `state` and `installation_id` are whatever the browser sent — the
 * `PUT`, under `staffAccess`, does both — and only
 * hints the staff of the organization's classrooms and of `state`'s.
 * Returns Quiz's id of the organization it recorded, or null when nothing
 * was (no installation, or one GitHub does not confirm).
 */
export async function completeSetup(
  db: Db,
  config: AppConfig,
  query: GithubSetupQuery,
  log: FastifyBaseLogger,
): Promise<string | null> {
  if (query.installation_id === undefined) return null;
  let inst: AppInstallation | null;
  try {
    inst = await fetchInstallation(config, query.installation_id, HTTP_READ);
  } catch (err) {
    log.warn({ err, installationId: query.installation_id }, "verifying an installation failed");
    return null;
  }
  if (!inst) return null;
  let org = await recordInstallation(db, inst, "setup_url");
  try {
    // Read while the installation is fresh: the `free` warning shows at once.
    org = await refreshPlan(config, db, org);
  } catch (err) {
    log.warn({ err, org: org.login }, "reading an organization's plan failed");
  }
  await orgChanged(db, org.id, query.state);
  return org.id;
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
/**
 * The caller sees the organization (ADR-100): it is granted to a course
 * where they hold a seat, or a classroom of such a course is connected to
 * it. On a query with `github_organizations` in scope.
 */
function seesOrg(userId: string): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${githubOrgGrants} g WHERE g.org_id = ${githubOrganizations.id} AND ${staffAccess(userId, sql`g.course_id`)})
    OR EXISTS (SELECT 1 FROM ${githubClassroomLinks} l JOIN ${classrooms} c ON c.id = l.classroom_id
      WHERE l.org_id = ${githubOrganizations.id} AND ${staffAccess(userId, sql`c.course_id`)}))`;
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
  caller: Caller,
  now: Date,
  log: FastifyBaseLogger,
): Promise<OrgAvatar | null> {
  const [org] = await db
    .select({ githubOrgId: githubOrganizations.githubOrgId })
    .from(githubOrganizations)
    .where(and(eq(githubOrganizations.id, orgId), accessWhere(caller, seesOrg(caller.id))));
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

// ---------------------------------------------------------------- what projects read of a classroom's link

/** An organization row with Quiz's App installed on it. */
export type InstalledOrg = OrgRow & { installationId: number };

/** The three facts of an organization row the rule below reads (null: the row was not there, a left join). */
export interface OrgFacts {
  installationId: number | null;
  suspendedAt: Date | null;
  status: OrgRow["status"] | null;
}

/**
 * THE rule of an organization Quiz's App acts on: installed, not suspended,
 * and active. Pure; the one place the three conditions are spelled — the
 * listing's and the sheet's `installed`, the projects' {@link installed},
 * the journal's reads (`journal/ingest.ts`, `journal/writes.ts`) all call
 * it. {@link ACTS} is its SQL twin for the scans.
 */
export function actsOn(org: OrgFacts): boolean {
  return org.installationId !== null && org.suspendedAt === null && org.status === "active";
}

/** {@link actsOn}, narrowed to the row with its installation; null otherwise. */
function installed(org: OrgRow): InstalledOrg | null {
  return actsOn(org) ? { ...org, installationId: org.installationId! } : null;
}

/** {@link installed}, over a `github_organizations` row in SQL. */
const ACTS = and(
  isNotNull(githubOrganizations.installationId),
  isNull(githubOrganizations.suspendedAt),
  eq(githubOrganizations.status, "active"),
)!;

/**
 * A project's organization (`projects.org_id`, kept when its classroom is
 * disconnected) when Quiz's App acts on it ({@link installed}); null
 * otherwise, the `app_not_installed` of a student's Accept (M3-03).
 */
export async function projectInstallation(db: Db, orgId: string): Promise<InstalledOrg | null> {
  const [org] = await db.select().from(githubOrganizations).where(eq(githubOrganizations.id, orgId));
  return org ? installed(org) : null;
}

/**
 * The classroom's organization when Quiz's App is installed there and the
 * organization is active, else why not: `not_connected` without a link,
 * `app_not_installed` otherwise. What a project's creation and the
 * repository browser start from. (The journal's `targetOf`,
 * `journal/writes.ts`, reads the same link its own way: a follow-up may
 * move it here.)
 */
export async function classroomInstallation(
  db: Db,
  classroomId: string,
): Promise<{ org: InstalledOrg } | { refused: "not_connected" | "app_not_installed"; login: string | null }> {
  const [row] = await db
    .select({ org: githubOrganizations })
    .from(githubClassroomLinks)
    .innerJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
    .where(eq(githubClassroomLinks.classroomId, classroomId))
    .limit(1);
  if (!row) return { refused: "not_connected", login: null };
  const org = installed(row.org);
  return org ? { org } : { refused: "app_not_installed", login: row.org.login };
}

// ---------------------------------------------------------------- push receipts of a deletion

/**
 * Every GitHub repository a project references, with the project and its
 * classroom (`repo_id`, `project_id`, `classroom_id`): its students' and
 * groups' repositories, its distribution, its source. One list for what a
 * deletion purges and for what a course's staff alone may read (ADR-100).
 */
const PROJECT_REPO_REFS = sql`
  SELECT r.github_repo_id AS repo_id, p.id AS project_id, p.classroom_id FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE r.github_repo_id IS NOT NULL
  UNION SELECT p.distribution_repo_id, p.id, p.classroom_id FROM projects p WHERE p.distribution_repo_id IS NOT NULL
  UNION SELECT p.source_repo_id, p.id, p.classroom_id FROM projects p`;

/** The projects a deletion takes with it: one project, a classroom's, or a course's. */
export type ProjectsGone = { projectId: string } | { classroomId: string } | { courseId: string };

/**
 * The push receipts of the repositories the projects a deletion takes with
 * it touched (N-DATA-03, D19, F-PROJ-16, F-ORG-09): their students' and
 * groups' repositories, their distribution repositories, their sources —
 * each only if no project that stays still references it (a source another
 * project hands out). Called in the deletion's own transaction, BEFORE the
 * rows go: `push_receipts` is keyed on GitHub's repository id, with no
 * foreign key a cascade could follow. Reads the `project` tables by join, as
 * this module reads the journal's (D28); writes only its own. Nothing on
 * GitHub is touched. Returns the number of receipts deleted.
 */
export async function purgeProjectReceipts(tx: Db | Tx, gone: ProjectsGone): Promise<number> {
  const goneIds =
    "projectId" in gone
      ? sql`SELECT ${gone.projectId}::uuid`
      : "classroomId" in gone
        ? sql`SELECT p.id FROM projects p WHERE p.classroom_id = ${gone.classroomId}`
        : sql`SELECT p.id FROM projects p JOIN classrooms c ON c.id = p.classroom_id WHERE c.course_id = ${gone.courseId}`;
  /** Every repository id the projects `ids` reference. */
  const referenced = (ids: SQL) => sql`SELECT k.repo_id FROM (${PROJECT_REPO_REFS}) k WHERE k.project_id IN (${ids})`;
  const staying = sql`SELECT p.id FROM projects p WHERE p.id NOT IN (${goneIds})`;
  const deleted = await tx
    .delete(pushReceipts)
    .where(
      sql`${pushReceipts.githubRepoId} IN (${referenced(goneIds)}) AND ${pushReceipts.githubRepoId} NOT IN (${referenced(staying)})`,
    )
    .returning({ id: pushReceipts.id });
  return deleted.length;
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
  pushAuthor,
  pushedBy,
  type WebhookHandler,
} from "./deliveries.js";
