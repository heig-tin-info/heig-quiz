import type { UseQueryResult } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { ClassroomSummary, CourseSummary } from "@quiz/contracts";

import { useT } from "./i18n";
import { NavTree, navRowClass, useNavCycle, type NavCycle } from "./navTree";
import type { Route } from "./router";
import { cx, Tip, useTruncated } from "./ui";

/**
 * The "Courses" section of the application sidebar (#154): the course →
 * classroom hierarchy, walked from the sidebar the way the pools are
 * (pool/PoolNav.tsx), with the same three states and the same click rule
 * (`useNavCycle`):
 *
 *   collapsed → the row alone;
 *   active    → the course being read, with its classrooms;
 *   all       → every course the teacher is on the staff of, the one being
 *               read unfolded, any other one unfolded on demand.
 *
 * It comes IN ADDITION to the flat Classrooms section of the sidebar, which
 * stays the "right now" list: with "all" open, the classroom being read shows
 * twice, once in each view, and that is deliberate — two views, two purposes.
 *
 * The data is the course list the sidebar already reads for its Classrooms
 * section (`GET /courses`, on `coursesKey`), handed down by `Nav`: every
 * course of the caller's staff, each with its classrooms. The server leaves
 * the archived classrooms out of that list, so the tree never shows one; it
 * is reached from the course's card ("Show archived"). A course the teacher
 * hid (#155) is left out of "all" too — except the one being read, because
 * the tree says where the reader is before it offers where to go.
 */

export function useCourseNavState(): NavCycle {
  return useNavCycle("quiz-courses-nav");
}

/**
 * "Inside" the courses section: the course list (the teacher home, where
 * every course is a card — there is no page of one course) and a classroom
 * page, whatever its tab (`?tab=` is not a route of its own). The evaluation
 * screens are not in it: the sidebar cannot name their course without
 * fetching the evaluation, and there a click on "Courses" should take the
 * teacher back to the list anyway.
 */
export function inCourseSection(route: Route): boolean {
  return route.view === "home" || route.view === "classroom";
}

/** The course whose classroom is being read, or `null` off a classroom page. */
function activeCourseOf(courses: CourseSummary[], route: Route): string | null {
  if (route.view !== "classroom") return null;
  return courses.find((c) => c.classrooms.some((r) => r.id === route.id))?.id ?? null;
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
 * `aria-description`, the bubble being `aria-hidden`). In "all" another
 * course's row is the disclosure of its classrooms — there is no page of one
 * course to go to — so it carries `aria-expanded`. The course being read is
 * always unfolded: its row only names where the reader is and is not a
 * control (its chevron, in "all", keeps the column aligned).
 */
function CourseRow({
  course,
  active,
  expanded,
  onToggle,
}: {
  course: CourseSummary;
  active: boolean;
  expanded?: boolean;
  onToggle?: (() => void) | undefined;
}) {
  const body = (
    <>
      {expanded !== undefined ? (
        <ChevronRight
          className={cx("size-3.5 shrink-0 text-fg-faint transition-transform", expanded && "rotate-90")}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{course.code}</span>
    </>
  );
  const weight = active ? "font-semibold text-fg" : "text-fg-muted";
  return (
    <Tip label={course.name} className="block">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-description={course.name}
          className={cx(navRowClass, weight, "hover:bg-surface-2 hover:text-fg")}
        >
          {body}
        </button>
      ) : (
        <div aria-description={course.name} className={cx(navRowClass, weight)}>
          {body}
        </div>
      )}
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
  // The OTHER courses a click unfolded in "all"; the one being read is always
  // unfolded, so opening one of their classrooms keeps it on screen. Not
  // remembered: it is a glance, and the next visit starts folded.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  if (state === "collapsed") return null;
  const activeId = activeCourseOf(courses.data ?? [], route);

  if (state === "active") {
    // Nothing to show off a classroom page, or once the list says the
    // classroom is in no course of the caller's.
    if (route.view !== "classroom" || (courses.data && !activeId)) return null;
    return (
      <NavTree query={courses}>
        {(list) => {
          const course = list.find((c) => c.id === activeId)!;
          return (
            <>
              <CourseRow course={course} active />
              <Classrooms course={course} route={route} navigate={navigate} />
            </>
          );
        }}
      </NavTree>
    );
  }

  const toggle = (id: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const shown = {
    isLoading: courses.isLoading,
    isError: courses.isError,
    data: courses.data?.filter((c) => !c.hidden || c.id === activeId),
  };
  return (
    <NavTree
      query={shown}
      empty={courses.data?.length ? t("courses.allHidden") : t("courses.empty.title")}
    >
      {(list) => (
        <ul className="space-y-0.5">
          {list.map((course) => {
            const active = course.id === activeId;
            const expanded = active || opened.has(course.id);
            return (
              <li key={course.id}>
                <CourseRow
                  course={course}
                  active={active}
                  expanded={expanded}
                  onToggle={active ? undefined : () => toggle(course.id)}
                />
                {expanded ? <Classrooms course={course} route={route} navigate={navigate} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </NavTree>
  );
}
