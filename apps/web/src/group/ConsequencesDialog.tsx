import { Snowflake, TriangleAlert, UserMinus, UserPlus } from "lucide-react";

import type { GroupConsequences } from "@quiz/contracts";

import { useT } from "../i18n";
import { Alert, Badge, Button, Modal } from "../ui";
import { consequencesByProject, resyncSections, type RepoConsequences } from "./groupRules";

/**
 * A confirmation asked by the server (`409 needs_confirmation`): what it
 * named and its digest, and whether it names them again because the digest
 * sent was stale (`changedSince`).
 */
export type Asked = GroupConsequences & { changedSince: boolean };

/** A list's caption: the 12 px uppercase eyebrow of a note (DESIGN.md, NotePanel). */
const eyebrow = "text-xs font-semibold uppercase tracking-wide text-fg-faint";

/** Each side of a repository's consequences: its words and its icon. */
const COPY = {
  lose: { label: "groups.confirm.lose", icon: UserMinus },
  join: { label: "groups.confirm.join", icon: UserPlus },
} as const;

/** One repository a confirmation names: its name (or "being created"), its group, who loses it, who joins it. */
function RepoBlock({ repo }: { repo: RepoConsequences }) {
  const t = useT();
  return (
    <li className="space-y-1 py-2.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {repo.repo ? (
          <span className="font-mono text-[13px] break-all">{repo.repo}</span>
        ) : (
          <span className="text-[13px] text-fg-muted italic">{t("groups.confirm.creating")}</span>
        )}
        <span className="text-[13px] text-fg-muted">{repo.groupName}</span>
        {repo.frozen ? (
          <Badge tone="zinc" icon={Snowflake}>
            {t("groups.confirm.frozen")}
          </Badge>
        ) : null}
      </p>
      {(["lose", "join"] as const).map((kind) => {
        const { label, icon: Glyph } = COPY[kind];
        return repo[kind].length > 0 ? (
          <p key={kind} className="flex items-start gap-2 text-sm">
            <Glyph aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-faint" />
            <span>
              <span className="text-fg-muted">{t(label)} · </span>
              {repo[kind].join(", ")}
            </span>
          </p>
        ) : null;
      })}
    </li>
  );
}

const RepoList = ({ repos }: { repos: RepoConsequences[] }) => (
  <ul className="divide-y divide-line">
    {repos.map((repo) => (
      <RepoBlock key={repo.key} repo={repo} />
    ))}
  </ul>
);

/**
 * The confirmation of a write that reaches GitHub (ADR-070 §6; M3-16b):
 * the consequences the server named with its `409 needs_confirmation`,
 * never guessed. A set's move lists them by project, then by repository —
 * one being created has no name yet —, then the students who lose it and
 * join it. *Resync with the set* (`kind="resync"`) names first the
 * distinct frozen repositories it touches after their deadline, then the
 * students who will have no repository (Accept being closed, R3), then the
 * rest by repository. `changedSince`: the digest sent was stale — the
 * server named them again, and the dialog says so.
 *
 * A modal, not a banner: it never competes with the set's opening banner
 * for the top of the board (M3-17), and the board behind it takes no
 * input. Confirm is its one primary; Cancel (or Escape) is the way out.
 */
export function ConsequencesDialog({
  kind,
  asked: { consequences, changedSince },
  confirming,
  onConfirm,
  onCancel,
}: {
  kind: "move" | "resync";
  asked: Asked;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const resync = kind === "resync" ? resyncSections(consequences) : null;
  const projects = resync ? [] : consequencesByProject(consequences);

  return (
    <Modal
      title={t(resync ? "project.resync.title" : "groups.confirm.title")}
      // Escape cancels, except while the confirmation is in flight: its answer decides.
      onClose={confirming ? () => undefined : onCancel}
      scroll
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={confirming}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm} loading={confirming}>
            {t(resync ? "project.resync.submit" : "groups.confirm.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {changedSince ? <Alert tone="warning" icon={TriangleAlert} title={t("groups.confirm.changed")} /> : null}
        <p className="text-sm text-fg-muted">{t(resync ? "project.resync.intro" : "groups.confirm.intro")}</p>
        {resync ? (
          <>
            {resync.frozenRepos.length > 0 ? (
              <Alert tone="warning" icon={Snowflake} title={t("project.resync.frozen")}>
                <p>{t("project.resync.frozen.body")}</p>
                <ul className="mt-1 space-y-0.5">
                  {resync.frozenRepos.map((name) => (
                    <li key={name} className="font-mono text-[13px] break-all">
                      {name}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {resync.noRepo.length > 0 ? (
              <section className="space-y-1.5">
                <h3 className={eyebrow}>{t("project.resync.noRepo")}</h3>
                <ul className="space-y-0.5 text-sm">
                  {resync.noRepo.map((s) => (
                    <li key={`${s.name}:${s.groupName}`}>
                      {s.name} <span className="text-fg-muted">· {s.groupName}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {resync.rest.length > 0 ? (
              <section>
                <h3 className={eyebrow}>{t("project.resync.repos")}</h3>
                <RepoList repos={resync.rest} />
              </section>
            ) : null}
          </>
        ) : (
          projects.map((project) => (
            <section key={project.projectId}>
              <h3 className={eyebrow}>{project.projectName}</h3>
              <RepoList repos={project.repos} />
            </section>
          ))
        )}
      </div>
    </Modal>
  );
}
