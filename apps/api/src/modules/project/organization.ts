/**
 * The organization a classroom's projects live in, and the App's client on
 * it: what the creation and the repository browser start from. The link
 * and the organization are the `github` module's tables, read by join.
 */
import { eq } from "drizzle-orm";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { githubClassroomLinks, githubOrganizations } from "../../db/schema.js";
import { installationClient, type InstallationClient } from "../../github/app.js";
import { ProjectError } from "./errors.js";

export type OrgRow = typeof githubOrganizations.$inferSelect;

/**
 * The classroom's organization, with Quiz's App installed on it: `409
 * not_connected` without a link (F-GH-01), `409 app_not_installed` when the
 * App is gone or the organization deleted.
 */
export async function classroomOrg(db: Db, classroomId: string): Promise<OrgRow & { installationId: number }> {
  const [row] = await db
    .select({ org: githubOrganizations })
    .from(githubClassroomLinks)
    .innerJoin(githubOrganizations, eq(githubOrganizations.id, githubClassroomLinks.orgId))
    .where(eq(githubClassroomLinks.classroomId, classroomId))
    .limit(1);
  if (!row) throw new ProjectError("not_connected", "The classroom is not connected to an organization");
  const { org } = row;
  if (org.installationId === null || org.status !== "active") {
    throw new ProjectError("app_not_installed", `Quiz's GitHub App is not installed on ${org.login}`);
  }
  return { ...org, installationId: org.installationId };
}

/** The App's client on the classroom's organization (the token in memory only, invariant 15). */
export async function classroomClient(
  db: Db,
  config: AppConfig,
  classroomId: string,
): Promise<{ org: OrgRow; client: InstallationClient }> {
  const org = await classroomOrg(db, classroomId);
  return { org, client: await installationClient(config, org.installationId) };
}
