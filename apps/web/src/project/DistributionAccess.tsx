/**
 * The distribution repository's link and the caller's own access to it
 * (F-PROJ-02 as amended 2026-10-26, #899). The repository is private and
 * Quiz grants nobody access at creation: a staff member asks, and is
 * invited with `pull` on the account they linked. A tertiary action under
 * the link, never the page's primary. Without a linked account, a note
 * leads to the Settings card (F-GH-05) instead of the button. On a
 * platform without the App, or while the account loads, the link alone.
 */
import { useMutation } from "@tanstack/react-query";

import type { ProjectDistributionAccess } from "@quiz/contracts";

import { api, refusedWith, wordedRefusal } from "../api";
import { useGithubAccount } from "../github/api";
import { useT, type Dict } from "../i18n";
import { routeToPath } from "../router";
import { Button } from "../ui";
import { RepoLink } from "./parts";

/** The refusals the tile words itself; any other is the server's message. */
const REFUSALS: Partial<Record<string, keyof Dict>> = {
  github_account_stale: "project.distribution.stale",
  invite_failed: "project.distribution.failed",
};

const settingsHref = routeToPath({ view: "settings" });

export function DistributionRepo({ projectId, fullName }: { projectId: string; fullName: string }) {
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
      <RepoLink fullName={fullName} />
      {below}
    </span>
  );
}
