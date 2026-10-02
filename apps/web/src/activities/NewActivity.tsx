import { ChevronDown, ClipboardList, FolderGit2, Plus } from "lucide-react";

import { useClassroomGithub } from "../github/api";
import { useT } from "../i18n";
import type { Navigate } from "../router";
import { Button, Menu, type MenuItem } from "../ui";

/**
 * The classroom's one primary on its activities tab (M3-10, `docs/merge/
 * 05-web.md` §5.3): "New ▾", Evaluation or Project.
 *
 * Project follows the classroom's GitHub link (F-PROJ-01, F-GH-02): on a
 * platform without Quiz's App (`githubAbsent`) it is not offered, and the
 * button is the plain "New evaluation" it always was; while the link is
 * loading the item is greyed; when the read failed it is left out rather than
 * guessed. On a classroom not connected it says so under its label and opens
 * the Settings' "Connect to GitHub" sheet (`?connect=1`, M2-07) — GitHub then
 * returns to the Settings, not to a form (F-GH-02). On a connected one it opens
 * the new project (`projectNew`, M3-11's).
 *
 * No Poll: the poll launcher takes no classroom (its audience is a remembered
 * choice of its own), so a Poll item here could not land on this classroom.
 */
export function NewActivity({
  classroomId,
  navigate,
  onEvaluation,
  onConnect,
}: {
  classroomId: string;
  navigate: Navigate;
  /** Opens the page's "New evaluation" dialog. */
  onEvaluation: () => void;
  /** Opens the Settings' connect sheet (`ClassroomView`'s `openConnect`). */
  onConnect: () => void;
}) {
  const t = useT();
  const github = useClassroomGithub(classroomId);

  // A 404 (`githubAbsent`: no App, no projects) and any other failure alike:
  // Project is not offered, and the button is the one it was before.
  if (github.isError) {
    return (
      <Button onClick={onEvaluation}>
        <Plus /> {t("eval.new")}
      </Button>
    );
  }

  const connected = github.data ? github.data.link !== null : null;
  const items: MenuItem[] = [
    { label: t("activity.new.evaluation"), icon: ClipboardList, onSelect: onEvaluation },
    {
      label: t("activity.new.project"),
      icon: FolderGit2,
      ...(connected === false ? { description: t("project.notConnected") } : {}),
      disabled: connected === null,
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
