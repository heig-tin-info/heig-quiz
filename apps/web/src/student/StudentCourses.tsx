/**
 * The student's Courses (F-ORG-14, D07): the classrooms where they hold a
 * claimed seat, archived ones excepted, each card opening the classroom's
 * page — the home's "My classrooms" list (`ClassroomList`).
 *
 * The four decisions:
 *   - Type: the classroom's name is the 15 px line of each card; the course
 *     and the teachers are 13–14 px under it.
 *   - Color: no primary. The page is a list of doors; a card is pressed, and
 *     the time bonus is the one accent (a soft badge, as on the home).
 *   - Space: 24 under the header, 12 between cards.
 *   - Finish: cards on the canvas, hairlines, the hover of an interactive card.
 */
import { useT } from "../i18n";
import type { Route } from "../router";
import { PageHeader } from "../ui";
import { ClassroomList } from "./cards";

export function StudentCourses({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  return (
    <div className="space-y-6">
      <PageHeader title={t("nav.courses")} description={t("scourses.subtitle")} />
      <div className="space-y-3">
        <ClassroomList navigate={navigate} />
      </div>
    </div>
  );
}
