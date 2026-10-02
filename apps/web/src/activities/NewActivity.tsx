import { ChevronDown, ClipboardList, FolderGit2, Plus } from "lucide-react";

import type { GithubClassroom } from "@quiz/contracts";

import { useT } from "../i18n";
import { routeEnabled, type Navigate } from "../router";
import { Button, Menu, type MenuItem } from "../ui";

/**
 * The classroom's one primary on its activities tab (M3-10, `docs/merge/
 * 05-web.md` §5.3): "New ▾", Evaluation or Project.
 *
 * Stateless: the classroom page holds the GitHub read (F-PROJ-01, F-GH-02)
 * and hands over its answer, `undefined` while it is not a success — still
 * loading, failed, or the 404 of a platform without Quiz's App. Until then,
 * and in a build where the new project does not parse yet (`routeEnabled`,
 * M3-11), the button is the plain "New evaluation" it always was: no menu
 * that turns back into a button, and no door to a page that is not there.
 * On a classroom not connected, Project says so under its label and opens
 * the Settings' "Connect to GitHub" sheet (`?connect=1`, M2-07) — GitHub
 * then returns to the Settings, not to a form (F-GH-02). On a connected one
 * it opens the new project.
 *
 * No Poll: the poll launcher takes no classroom (its audience is a remembered
 * choice of its own), so a Poll item here could not land on this classroom.
 */
export function NewActivity({
  classroomId,
  github,
  navigate,
  onEvaluation,
  onConnect,
}: {
  classroomId: string;
  /** The classroom's GitHub read, once it succeeded. */
  github: GithubClassroom | undefined;
  navigate: Navigate;
  /** Opens the page's "New evaluation" dialog. */
  onEvaluation: () => void;
  /** Opens the Settings' connect sheet (`ClassroomView`'s `openConnect`). */
  onConnect: () => void;
}) {
  const t = useT();
  if (!github || !routeEnabled("projectNew")) {
    return (
      <Button onClick={onEvaluation}>
        <Plus /> {t("eval.new")}
      </Button>
    );
  }
  const connected = github.link !== null;
  const items: MenuItem[] = [
    { label: t("activity.new.evaluation"), icon: ClipboardList, onSelect: onEvaluation },
    {
      label: t("activity.new.project"),
      icon: FolderGit2,
      ...(connected ? {} : { description: t("project.notConnected") }),
      onSelect: () => (connected ? navigate({ view: "projectNew", classroomId }) : onConnect()),
    },
  ];
  return (
    <Menu
      label={t("activity.new")}
      items={items}
      trigger={
        <Button>
          <Plus /> {t("activity.new")} <ChevronDown />
        </Button>
      }
    />
  );
}
