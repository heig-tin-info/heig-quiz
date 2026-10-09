import { ChevronDown, ClipboardList, FolderGit2, Plus } from "lucide-react";

import type { GithubClassroom } from "@quiz/contracts";

import { useT, type TFunction } from "../i18n";
import type { Navigate } from "../router";
import { Button, Menu, type MenuItem } from "../ui";

/**
 * The classroom's one primary on its activities tab (M3-10, `docs/merge/
 * 05-web.md` §5.3): "New ▾", Evaluation or Project.
 *
 * Stateless: the classroom page holds the GitHub read (F-PROJ-01, F-GH-02)
 * and hands over its answer, `undefined` while it is not a success — still
 * loading, failed, or the 404 of a platform without Quiz's App. Until then,
 * the button is the plain "New evaluation" it always was: no menu that turns
 * back into a button.
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
  const project = newProjectAction(classroomId, github, navigate, onConnect, t);
  if (!project) {
    return (
      <Button onClick={onEvaluation}>
        <Plus /> {t("eval.new")}
      </Button>
    );
  }
  const items: MenuItem[] = [
    { label: t("activity.new.evaluation"), icon: ClipboardList, onSelect: onEvaluation },
    { label: t("activity.new.project"), icon: FolderGit2, ...project },
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

/**
 * Where "New project" leads, shared by the menu above and the evaluations'
 * empty state: `null` while it has no door (see `NewActivity`), the
 * Settings' connect sheet on a classroom not connected — saying so in
 * `description` — and the new project otherwise.
 */
export function newProjectAction(
  classroomId: string,
  github: GithubClassroom | undefined,
  navigate: Navigate,
  onConnect: () => void,
  t: TFunction,
): { description?: string; onSelect: () => void } | null {
  if (!github) return null;
  return github.link !== null
    ? { onSelect: () => navigate({ view: "projectNew", classroomId }) }
    : { description: t("project.notConnected"), onSelect: onConnect };
}
