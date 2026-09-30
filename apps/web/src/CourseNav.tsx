import type { UseQueryResult } from "@tanstack/react-query";

import type { ClassroomSummary, CourseSummary } from "@quiz/contracts";

import { useT } from "./i18n";
import { NavTree, navRowClass, useNavCycle, type NavCycle } from "./navTree";
import type { Route } from "./router";
import { cx, Tip, useTruncated } from "./ui";

/**
 * The "Courses" section of the application sidebar (#154): the course →
 * classroom hierarchy, walked from the sidebar the way the pools are
 * (pool/PoolNav.tsx), with the same two states and the same click rule
 * (`useNavCycle`):
 *
 *   active → the course being read (its page, or one of its classrooms),
 *            with its classrooms;
 *   all    → every course the teacher is on the staff of, the one being
 *            read unfolded.
 *
 * A course row OPENS the course page (F-ORG-12), like a pool row opens the
 * pool: the page lists the course's classrooms, and once it is up the course
 * is the one being read and unfolds here as well. So a row is a link and
 * never a disclosure, and the tree has no second control to fold a course.
 *
 * It comes IN ADDITION to the flat Classrooms section of the sidebar, which
 * stays the "right now" list: with "all" open, the classroom being read shows
 * twice, once in each view, and that is deliberate — two views, two purposes.
 *
 * The data is the course list the sidebar already reads for its Classrooms
 * section (`GET /courses`, on `coursesKey`), handed down by `Nav`: every
 * course of the caller's staff, each with its classrooms. The server leaves
 * the archived classrooms out of that list, so the tree never shows one; it
 * is reached from the course's page or card ("Show archived"). A course the teacher
 * hid (#155) is left out of "all" too — except the one being read, because
 * the tree says where the reader is before it offers where to go.
 */

export function useCourseNavState(): NavCycle {
  return useNavCycle("quiz-courses-nav");
}

/**
 * The course being read — the one whose page or classroom is up — or `null`
 * anywhere else, and for an id that is in no course of the caller's.
 */
export function activeCourseOf(courses: CourseSummary[], route: Route): string | null {
  if (route.view === "course") return courses.find((c) => c.id === route.id)?.id ?? null;
  if (route.view !== "classroom") return null;
  return courses.find((c) => c.classrooms.some((r) => r.id === route.id))?.id ?? null;
}

/**
 * THE navigation rule of a hidden course (#155, ADR-032): the course list,
 * both sidebar sections and the palette leave out a course the caller hid —
 * except `activeId`, the course being read, because the navigation says
 * where the reader is before it offers where to go. Pickers never ask.
 */
export function inNavigation(course: CourseSummary, activeId?: string | null): boolean {
  return !course.hidden || course.id === activeId;
}

/**
 * A classroom under its course: indented by the list around it, its name
 * alone — the course is the row above. The whole name in a `Tip` when the
 * ellipsis cut it, like the flat section's rows. Rows are plain buttons in a
 * nested list, the roles and the Tab order of `PoolNavTree`.
 */
function ClassroomRow({
  room,
  current,
  onOpen,
}: {
  room: ClassroomSummary;
  current: boolean;
  onOpen: () => void;
}) {
  const [nameRef, truncated] = useTruncated<HTMLSpanElement>();
  return (
    <Tip label={truncated ? room.name : null} className="block">
      <button
        type="button"
        onClick={onOpen}
        aria-current={current ? "page" : undefined}
        className={cx(
          navRowClass,
          // Weight, not the accent: the one `accent-soft` chip of the column
          // is the same classroom's row in the flat section below, which the
          // sidebar always shows (`cappedClassrooms`) — two red chips for one
          // page would read as two selections.
          current ? "font-semibold text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
        )}
      >
        <span ref={nameRef} className="min-w-0 flex-1 truncate">
          {room.name}
        </span>
      </button>
    </Tip>
  );
}

/** The classrooms of one course, as the nested list under its row. */
function Classrooms({
  course,
  route,
  navigate,
}: {
  course: CourseSummary;
  route: Route;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  if (course.classrooms.length === 0) {
    return <p className="ml-4 px-2.5 py-1.5 text-[13px] text-fg-faint">{t("classrooms.empty")}</p>;
  }
  return (
    <ul className="ml-4 space-y-0.5 border-l border-line pl-1.5">
      {course.classrooms.map((room) => (
        <li key={room.id}>
          <ClassroomRow
            room={room}
            current={route.view === "classroom" && route.id === room.id}
            onOpen={() => navigate({ view: "classroom", id: room.id })}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * A course: its code, the full name in a `Tip` (and in the row's
 * `aria-description`, the bubble being `aria-hidden`). The row opens the
 * course page; `aria-current` marks it while that page is up. The course
 * being read otherwise (one of its classrooms) is in weight only, like a
 * pool whose question is open.
 */
function CourseRow({
  course,
  active,
  current,
  onOpen,
}: {
  course: CourseSummary;
  active: boolean;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <Tip label={course.name} className="block">
      <button
        type="button"
        onClick={onOpen}
        aria-current={current ? "page" : undefined}
        aria-description={course.name}
        className={cx(
          navRowClass,
          active ? "font-semibold text-fg" : "text-fg-muted",
          "hover:bg-surface-2 hover:text-fg",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{course.code}</span>
      </button>
    </Tip>
  );
}

/**
 * What hangs under the "Courses" row. `collapsed` draws nothing; the row
 * itself exists only in the teacher UI, so neither does any of this.
 */
export function CourseNavTree({
  state,
  courses,
  route,
  navigate,
}: {
  state: NavCycle["state"];
  /** `Nav`'s query of the course list: one request for the tree and the flat section. */
  courses: UseQueryResult<CourseSummary[]>;
  route: Route;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const activeId = activeCourseOf(courses.data ?? [], route);
  const row = (course: CourseSummary) => (
    <CourseRow
      course={course}
      active={course.id === activeId}
      current={route.view === "course" && route.id === course.id}
      onOpen={() => navigate({ view: "course", id: course.id })}
    />
  );

  if (state === "active") {
    // Nothing to show off a course or classroom page, or once the list says
    // the page is in no course of the caller's: the course list is in the
    // section, but it is no ONE course to unfold.
    if ((route.view !== "course" && route.view !== "classroom") || (courses.data && !activeId)) {
      return null;
    }
    return (
      <NavTree query={courses}>
        {(list) => {
          const course = list.find((c) => c.id === activeId)!;
          return (
            <>
              {row(course)}
              <Classrooms course={course} route={route} navigate={navigate} />
            </>
          );
        }}
      </NavTree>
    );
  }

  const shown = {
    isLoading: courses.isLoading,
    isError: courses.isError,
    data: courses.data?.filter((c) => inNavigation(c, activeId)),
  };
  return (
    <NavTree
      query={shown}
      empty={courses.data?.length ? t("courses.allHidden") : t("courses.empty.title")}
    >
      {(list) => (
        <ul className="space-y-0.5">
          {list.map((course) => (
            <li key={course.id}>
              {row(course)}
              {/* The course being read keeps its classrooms: "all courses"
                  widens the list, it does not take the current tree away. */}
              {course.id === activeId ? (
                <Classrooms course={course} route={route} navigate={navigate} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </NavTree>
  );
}
