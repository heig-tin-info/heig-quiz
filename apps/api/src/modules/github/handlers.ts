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

import { onEvent, type WebhookHandler } from "./deliveries.js";
import {
  markOrgDeleted,
  orgChanged,
  orgOfInstallation,
  renameOrg,
  resyncInstallation,
} from "./service.js";

/** What the installation handlers read of an event: which installation. */
const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int() }),
});

const OrganizationEvent = z.object({
  action: z.string(),
  organization: z.object({ id: z.number().int(), login: z.string().min(1) }),
});

/**
 * `installation` (created, deleted, suspend, unsuspend, ...): the
 * installation is re-read from GitHub and its current state recorded
 * (`resyncInstallation`), never the event's, so a replay out of order
 * cannot undo a later event.
 */
const installation: WebhookHandler = async (app, config, delivery) => {
  const event = InstallationEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const org = await resyncInstallation(app.db, config, event.data.installation.id, event.data.action);
  if (org) await orgChanged(app.db, org.id);
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

/**
 * `organization`: renamed, followed by its id; deleted, marked so. A stale
 * rename replayed after a later one is corrected by the next listing or
 * healing, which follow the login by the same id.
 */
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
