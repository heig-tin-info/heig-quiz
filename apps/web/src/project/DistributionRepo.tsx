/**
 * The distribution repository's link and the caller's own access to it
 * (F-PROJ-02 as amended 2026-10-26, #899). The repository is private and
 * Quiz grants nobody access at creation: a staff member asks, and is
 * invited with `pull` on the account they linked. A tertiary action under
 * the link, never the page's primary. Without a linked account, a note
 * leads to the Settings card (F-GH-05) instead of the button. On a
 * platform without the App, or while the account loads, the link alone.
 * Beside the link, an owner's *Open in workspace* (ADR-147); while the
 * repository is not built, the word that says so.
 */
import { useMutation } from "@tanstack/react-query";

import type { ProjectDetail, ProjectDistributionAccess } from "@quiz/contracts";

import { api, refusedWith, wordedRefusal } from "../api";
import { useGithubAccount } from "../github/api";
import { useT, type Dict } from "../i18n";
import { routeToPath } from "../router";
import { Button, RepoLink } from "../ui";
import { OpenDistributionIcon } from "./OpenInWorkspace";

/** The refusals the tile words itself; any other is the server's message. */
const REFUSALS: Partial<Record<string, keyof Dict>> = {
  github_account_stale: "project.distribution.stale",
  staff_seat_required: "project.distribution.seatRequired",
  distribution_missing: "project.refusal.distributionMissing",
  invite_refused: "project.distribution.refused",
  invite_failed: "sproj.refusal.provisionFailed",
};

const settingsHref = routeToPath({ view: "settings" });

/** The project's *Distribution repository* fact: its link and actions once built, else that it is being built. */
export function DistributionRepo({ project }: { project: ProjectDetail }) {
  const t = useT();
  if (project.distribution === null) return <span className="text-fg-muted">{t("project.distribution.building")}</span>;
  return <BuiltDistribution project={project} fullName={project.distribution.fullName} />;
}

function BuiltDistribution({ project, fullName }: { project: ProjectDetail; fullName: string }) {
  const projectId = project.id;
  const t = useT();
  const account = useGithubAccount();
  const access = useMutation({
    mutationFn: () => api<ProjectDistributionAccess>(`/app/api/projects/${projectId}/distribution/access`, { method: "POST" }),
  });

  let below = null;
  if (access.data) {
    below =
      access.data.status === "pending" ? (
        <a
          href={access.data.invitationsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent hover:underline"
          data-testid="distribution-invited"
        >
          {t("project.distribution.invited")}
        </a>
      ) : (
        <span className="text-xs text-fg-muted" data-testid="distribution-in">
          {t("project.distribution.hasAccess")}
        </span>
      );
  } else if (account.data?.account === null || refusedWith(access.error, "github_not_linked")) {
    below = (
      <a href={settingsHref} className="text-xs text-fg-muted hover:underline" data-testid="distribution-link-first">
        {t("project.distribution.linkFirst")}
      </a>
    );
  } else if (account.data) {
    below = (
      <>
        {/* The ghost's padding pulled back, so its word lines up with the link above. */}
        <Button variant="ghost" size="sm" className="-me-3" loading={access.isPending} onClick={() => access.mutate()}>
          {t("project.distribution.requestAccess")}
        </Button>
        {access.isError ? (
          <span role="alert" className="text-xs text-danger">
            {wordedRefusal(access.error, REFUSALS, t)}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <span className="inline-flex max-w-full flex-col items-end gap-1">
      <span className="inline-flex max-w-full items-center gap-1">
        {/* The link truncates before the icon is pushed out of a narrow tile. */}
        <RepoLink fullName={fullName} className="min-w-0" />
        <OpenDistributionIcon project={project} />
      </span>
      {below}
    </span>
  );
}
