/**
 * The `github` module's own webhook handlers (spec 05 §5.11, M2-04; ported
 * from heig-classroom's `handleInstallation` and `handleOrganization`):
 * what GitHub says about Quiz's App and the organizations it is installed
 * on. They register on the same registry as the other modules
 * (`deliveries.ts`) and write through the service, idempotently (ADR-011).
 *
 * What classroom's organization handler also did to repositories (the
 * `<org>/` prefixes rewritten on a rename) belongs to the modules that own
 * them: they register their own `organization` handler (M3).
 */
import { z } from "zod";

import { orgInstallation, type RawInstallation } from "../../github/app.js";
import { onEvent, type WebhookHandler } from "./deliveries.js";
import {
  clearInstallation,
  markOrgDeleted,
  orgChanged,
  orgOfInstallation,
  recordInstallation,
  renameOrg,
} from "./service.js";

const Installation = z.object({
  id: z.number().int(),
  account: z
    .object({
      id: z.number().int().optional(),
      login: z.string().optional(),
      type: z.string().optional(),
    })
    .nullable(),
  repository_selection: z.string().optional(),
});

const InstallationEvent = z.object({ action: z.string(), installation: Installation });

const OrganizationEvent = z.object({
  action: z.string(),
  organization: z.object({ id: z.number().int(), login: z.string().min(1) }),
});

/**
 * `installation`: created, unsuspended, or its permissions accepted, the
 * organization is recorded through `recordInstallation` (the one writer,
 * matched by id, never a takeover by login); deleted or suspended, the row
 * forgets it. A user's installation is not an organization's: ignored.
 */
const installation: WebhookHandler = async (app, _config, delivery) => {
  const event = InstallationEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const { action, installation: raw } = event.data;
  let orgId: string | undefined;
  if (action === "deleted" || action === "suspend") {
    orgId = (await clearInstallation(app.db, raw.id, action))?.id;
  } else if (["created", "unsuspend", "new_permissions_accepted"].includes(action)) {
    // The schema checked every field; only `exactOptionalPropertyTypes` needs the cast.
    const inst = orgInstallation(raw as RawInstallation);
    if (inst) orgId = (await recordInstallation(app.db, inst, "webhook")).id;
  }
  if (orgId) await orgChanged(app.db, orgId);
};

/**
 * `installation_repositories`: the repositories the App reaches changed.
 * Nothing is stored of them — `allRepositories` is a check of the healing
 * (F-GH-03) — so the organization's healing is dropped and its Settings
 * re-read GitHub.
 */
const installationRepositories: WebhookHandler = async (app, _config, delivery) => {
  const event = InstallationEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const org = await orgOfInstallation(app.db, event.data.installation.id);
  if (org) await orgChanged(app.db, org.id);
};

/** `organization`: renamed, followed by its id; deleted, marked so. */
const organization: WebhookHandler = async (app, _config, delivery) => {
  const event = OrganizationEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const { action, organization: org } = event.data;
  const row =
    action === "renamed"
      ? await renameOrg(app.db, org.id, org.login)
      : action === "deleted"
        ? await markOrgDeleted(app.db, org.id)
        : null;
  if (row) await orgChanged(app.db, row.id);
};

/** Called once per app by the module's plugin; registering twice changes nothing. */
export function registerGithubHandlers(): void {
  onEvent("installation", installation);
  onEvent("installation_repositories", installationRepositories);
  onEvent("organization", organization);
}
