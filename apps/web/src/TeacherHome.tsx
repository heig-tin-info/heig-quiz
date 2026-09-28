import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, LayoutGrid, Library, List, Plus, School } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CourseSummary } from "@quiz/contracts";

import { api } from "./api";
import {
  ArchivedClassrooms,
  ClassroomRow,
  CoursePools,
  HiddenBadge,
  useCourseActions,
} from "./course/parts";
import { inNavigation } from "./CourseNav";
import { useT } from "./i18n";
import type { Route } from "./router";
import {
  Actions,
  Button,
  Card,
  EmptyState,
  Field,
  FormDialog,
  FormError,
  PageHeader,
  PeopleStack,
  QueryError,
  SectionHeading,
  Segmented,
  Skeleton,
  Spinner,
  T,
  TableHead,
  ToggleChip,
  type Column,
  usePersistentChoice,
  useSortableTable,
} from "./ui";
import { coursesKey } from "./queryKeys";

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

function NewCourseModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", code: "" });
  const create = useMutation({
    mutationFn: () =>
      api("/app/api/courses", { method: "POST", body: JSON.stringify(form) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: coursesKey });
      onClose();
    },
  });
  return (
    <FormDialog
      title={t("courses.new")}
      onClose={onClose}
      onSubmit={() => create.mutate()}
      submitLabel={t("courses.newAction")}
      submitting={create.isPending}
      canSubmit={form.name.trim() !== "" && form.code.trim() !== ""}
      error={<FormError error={create.error} fallback={t("courses.createFailed")} />}
    >
      <Field
        label={t("courses.name")}
        required
        fullWidth
        autoFocus
        placeholder={t("courses.namePlaceholder")}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <Field
        label={t("courses.code")}
        required
        fullWidth
        placeholder={t("courses.codePlaceholder")}
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
      />
    </FormDialog>
  );
}

/**
 * The course's name, as the way into its page: the card and the table row
 * are summaries, the page is where the whole course is read. The name keeps
 * the weight of the heading it sits in and underlines on hover, like a
 * `ParentLink`: the grey of a link at rest is not a signal on its own.
 */
function CourseLink({ course, navigate }: { course: CourseSummary; navigate: (r: Route) => void }) {
  return (
    <button
      type="button"
      onClick={() => navigate({ view: "course", id: course.id })}
      className="text-left transition-colors hover:underline"
    >
      {course.name}
    </button>
  );
}

function CourseCard({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, staffActions, newClassroom, dialogs } = useCourseActions(course);

  return (
    <Card className="p-5">
      {/* The staff belongs to the title line and not to a row of its own: who
          teaches a course is part of naming it, and the hairline-separated
          strip it used to live in said "STAFF" to announce three discs. */}
      <SectionHeading
        icon={Library}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <CourseLink course={course} navigate={navigate} />
            <span className="text-[13px] font-normal text-fg-faint">{course.code}</span>
            <HiddenBadge course={course} />
            <PeopleStack people={course.staff} actions={staffActions} className="ml-2" />
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={newClassroom}>
              <Plus /> {t("classrooms.new")}
            </Button>
            <Actions items={items} label={t("common.actions")} />
          </>
        }
      />

      <div className="mt-4 space-y-1.5">
        {course.classrooms.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("classrooms.empty")}</p>
        ) : (
          course.classrooms.map((room) => (
            <ClassroomRow key={room.id} room={room} students={room.students} navigate={navigate} />
          ))
        )}
        <ArchivedClassrooms course={course} navigate={navigate} />
      </div>

      <CoursePools course={course} navigate={navigate} />

      {dialogs}
    </Card>
  );
}

/**
 * One course as a table row: its identity — the name opens the course page,
 * as on the card — the classrooms it holds — each a link, because that is
 * what a teacher came for — and its staff. The pools of a course are a card
 * and page affair, and so are its archived classrooms ("Show archived"); the
 * table answers "which live classroom, where".
 */
function CourseRow({
  course,
  navigate,
}: {
  course: CourseSummary;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const { items, staffActions, dialogs } = useCourseActions(course);
  return (
    <tr className={T.row}>
      <td className={T.td}>
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="font-semibold">
            <CourseLink course={course} navigate={navigate} />
          </span>
          <span className="text-xs text-fg-faint">{course.code}</span>
          <HiddenBadge course={course} />
        </span>
      </td>
      <td className={T.td}>
        {course.classrooms.length === 0 ? (
          <span className="text-fg-faint">—</span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-1 gap-y-1">
            {course.classrooms.map((room) => (
              <button
                key={room.id}
                type="button"
                onClick={() => navigate({ view: "classroom", id: room.id })}
                className="rounded-field px-1.5 py-0.5 font-medium transition-colors hover:bg-surface-2 hover:underline"
              >
                <School className="mr-1 inline size-3.5 text-fg-faint" />
                {room.name}
              </button>
            ))}
          </span>
        )}
      </td>
      <td className={T.td}>
        {course.staff.length === 0 ? (
          <span className="text-fg-faint">—</span>
        ) : (
          <PeopleStack people={course.staff} actions={staffActions} />
        )}
      </td>
      <td className={`${T.td} w-10 text-right`}>
        <Actions items={items} label={t("common.actions")} />
        {dialogs}
      </td>
    </tr>
  );
}

export function TeacherHome({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "cards");
  const [showHidden, setShowHidden] = useState(false);
  const courses = useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
  });
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
    { key: "name", label: t("courses.name") },
    { key: "classrooms", label: t("classrooms.title") },
    { key: "staff", label: t("courses.staff") },
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: "w-10" },
  ];

  /**
   * Two icons and no words: the choice is between two pictures of the same
   * list, and a pair of labels beside them would weigh more than the switch
   * itself. The name stays, for the pointer and for the screen reader.
   */
  const viewOption = (value: "cards" | "list", icon: ReactNode, label: string) => ({
    value,
    label: (
      <span title={label} className="flex items-center">
        {icon}
        <span className="sr-only">{label}</span>
      </span>
    ),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("courses.title")}
        description={t("courses.subtitle")}
        help="courses"
        actions={
          // Not while the list is empty: the empty state below carries the
          // same action, and two accent fills of the SAME action on one
          // screen is noise, not emphasis (W19). One button, in the place
          // the reader is already looking.
          all.length > 0 ? (
            <Button data-coach="home.new-course" onClick={() => setCreating(true)}>
              <Plus /> {t("courses.new")}
            </Button>
          ) : undefined
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
          <Segmented
            name="courses-view"
            value={view}
            onChange={setView}
            options={[
              viewOption("cards", <LayoutGrid className="size-4" />, t("view.cards")),
              viewOption("list", <List className="size-4" />, t("view.list")),
            ]}
          />
        </div>
      ) : null}

      {courses.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : courses.isError ? (
        <QueryError
          title={t("courses.title")}
          error={courses.error}
          onRetry={() => void courses.refetch()}
          retrying={courses.isFetching}
          fallback={t("error.server")}
        />
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
        <Card className="overflow-hidden">
          <table className={T.table}>
            <TableHead columns={columns} sort={sort} onToggle={toggle} />
            <tbody>
              {sorted.map((c) => (
                <CourseRow key={c.id} course={c} navigate={navigate} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <div className="space-y-4">
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
