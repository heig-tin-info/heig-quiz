import { Eye, EyeOff, Library, Plus } from "lucide-react";
import { useState } from "react";

import type { CourseSummary } from "@quiz/contracts";

import { CourseCard, CourseRow } from "./course/CourseSummary";
import { NewCourseModal } from "./course/modals";
import { useCourses } from "./course/parts";
import { inNavigation } from "./CourseNav";
import { useT } from "./i18n";
import type { Route } from "./router";
import {
  Button,
  Card,
  cx,
  EmptyState,
  PageHeader,
  QueryError,
  Skeleton,
  Spinner,
  T,
  TableHead,
  ToggleChip,
  type Column,
  usePersistentChoice,
  useSortableTable,
  ViewSwitch,
} from "./ui";

/**
 * Teacher home: the courses.
 *
 * The ONE primary action of this page is "New course"; everything a course
 * card offers (a classroom, a colleague, deletion) is secondary, because a
 * teacher arriving here with nothing must be shown one door, not five.
 *
 * A card is a course's SUMMARY: its classrooms and its pools, and its name
 * as the link to the course page (course/CoursePage.tsx, F-ORG-12), which is
 * the one place its evaluation templates are listed. A second list of them
 * here would be two surfaces to keep in step, and an empty one on every card
 * a burden on the novice home (08).
 *
 * Two readings of the same list: cards, which give each course room for its
 * classrooms and its pools, and a table, which answers "which classroom, in
 * which course" in one scan once a teacher has a dozen of them and sorts by
 * any of its three columns. The choice is the reader's and is remembered,
 * because it is a habit and not a state of the data.
 *
 * The staff is read on the title line, as a row of discs, and everything
 * about ONE colleague — their address, their seat — waits inside the disc's
 * card. The course itself offers three things (a colleague, hiding it,
 * deletion), so they sit in a menu; `Actions` is what decides that.
 *
 * A course the teacher no longer teaches can be hidden (#155, ADR-032): for
 * them alone, out of this list, the sidebar and the palette. "Show hidden"
 * brings those courses back here, each one badged and with "Show again" in
 * its menu. The toggle is not remembered — hidden is meant to stay out of
 * sight — and it only exists while something is hidden.
 */

const VIEW_KEY = "quiz-courses-view";
const VIEWS = ["cards", "list"] as const;

/** What the table may be sorted on: the identity column and the two counts. */
type CourseSortKey = "name" | "classrooms" | "staff";

export function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "cards");
  const [showHidden, setShowHidden] = useState(false);
  const courses = useCourses();
  const all = courses.data ?? [];
  const hiddenCount = all.filter((c) => c.hidden).length;
  const rows = showHidden ? all : all.filter((c) => inNavigation(c));
  /**
   * The table sorts, the cards do not: a card list is read in the order it
   * was given, while a table is scanned down one column. Three keys, the
   * three things a column can be worth here — the name, and the two counts.
   */
  const { sorted, sort, toggle } = useSortableTable<CourseSummary, CourseSortKey>(
    rows,
    (course, key) =>
      key === "classrooms"
        ? course.classrooms.length
        : key === "staff"
          ? course.staff.length
          : course.name,
    { key: "name", dir: 1 },
  );
  const columns: Column<CourseSortKey>[] = [
    { key: "name", label: t("courses.name"), stack: "main" },
    { key: "classrooms", label: t("classrooms.title"), stack: "sub" },
    { key: "staff", label: t("courses.staff"), stack: "sub" },
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: "w-10", stack: "end" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("courses.title")}
        description={t("courses.subtitle")}
        help="courses"
        primary={
          // Not while the list is empty: the empty state below carries the
          // same action, and two accent fills of the SAME action on one
          // screen is noise, not emphasis (W19). One button, in the place
          // the reader is already looking.
          all.length > 0
            ? { icon: Plus, label: t("courses.new"), onClick: () => setCreating(true), coach: "home.new-course" }
            : undefined
        }
      />

      {/* Under the header and hard right: it changes how the list below is
          drawn, so it belongs to the list, not to the title. */}
      {all.length > 0 && !courses.isError ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Not while every course is hidden: the empty state below carries
              the same action, once. */}
          {hiddenCount > 0 && rows.length > 0 ? (
            <ToggleChip
              icon={EyeOff}
              tone="neutral"
              label={t("courses.showHidden", { n: hiddenCount })}
              pressed={showHidden}
              onToggle={() => setShowHidden((v) => !v)}
            />
          ) : null}
          <ViewSwitch name="courses-view" views={["cards", "list"]} value={view} onChange={setView} />
        </div>
      ) : null}

      {courses.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : courses.isError ? (
        <QueryError title={t("courses.title")} query={courses} />
      ) : all.length > 0 && rows.length === 0 ? (
        // Every course is hidden: the list is not empty, it is folded away.
        <EmptyState
          icon={EyeOff}
          title={t("courses.allHidden")}
          action={
            <Button variant="secondary" onClick={() => setShowHidden(true)}>
              <Eye /> {t("courses.showHidden", { n: hiddenCount })}
            </Button>
          }
        >
          {t("courses.allHiddenBody")}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Library}
          title={t("courses.empty.title")}
          action={
            <Button data-coach="home.new-course" onClick={() => setCreating(true)}>
              <Plus /> {t("courses.new")}
            </Button>
          }
        >
          {t("courses.empty.body")}
        </EmptyState>
      ) : view === "list" ? (
        <Card className={cx(T.container, "overflow-hidden")}>
          <table role="table" className={cx(T.table, T.stack.table)}>
            <TableHead columns={columns} sort={sort} onToggle={toggle} />
            <tbody role="rowgroup">
              {sorted.map((c) => (
                <CourseRow key={c.id} course={c} navigate={navigate} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        // Two columns once each card keeps ~500 px: at `xl` the sidebar is
        // there and the page is capped, so `lg` would leave a card too narrow
        // for its title line and its classroom rows. A grid row stretches its
        // cards to one height, and the card pins its pools to the bottom.
        <div className="grid gap-4 xl:grid-cols-2">
          {rows.map((c) => (
            <CourseCard key={c.id} course={c} navigate={navigate} />
          ))}
        </div>
      )}

      {courses.isFetching && !courses.isLoading ? <Spinner className="py-2" /> : null}
      {creating ? <NewCourseModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
