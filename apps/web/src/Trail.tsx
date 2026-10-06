/**
 * The trail of a page, in its `PageHeader` eyebrow (DESIGN.md, Breadcrumb).
 * The primitive (`ui/breadcrumb.tsx`) draws; this file knows the app: it turns
 * a crumb's route into the real address (`routeToPath`) and the router's own
 * `navigate`, and names the ancestors the pages share (a classroom's chain).
 * The trail is structural — a sidebar section, then each ancestor down to the
 * page — never the browsing history.
 */
import { useQuery } from "@tanstack/react-query";
import type { ClassroomDetail } from "@quiz/contracts";
import { api } from "./api";
import { useT } from "./i18n";
import { classroomKey } from "./queryKeys";
import { routeToPath, type Route } from "./router";
import { Breadcrumb } from "./ui";

/** One level of a trail: a name, and where it leads (absent on the page itself). */
export interface Crumb {
  label: string;
  route?: Route;
}

export function Trail({
  navigate,
  items,
}: {
  navigate: (r: Route) => void;
  /** The ancestors then the page; an unknown one (still loading) is left out. */
  items: readonly (Crumb | null | undefined | false)[];
}) {
  const t = useT();
  const known = items.filter((c): c is Crumb => !!c);
  return (
    <Breadcrumb
      label={t("breadcrumb.label")}
      items={known.map(({ label, route }) =>
        route ? { label, href: routeToPath(route), onNavigate: () => navigate(route) } : { label },
      )}
    />
  );
}

/** The teacher's root: the Courses section. */
export function useCoursesCrumb(): Crumb {
  const t = useT();
  return { label: t("courses.title"), route: { view: "home" } };
}

/** The question pools' root: the Question pools section. */
export function usePoolsCrumb(): Crumb {
  const t = useT();
  return { label: t("pools.title"), route: { view: "pools" } };
}

/** The student's root: their Courses. */
export function useStudentCoursesCrumb(): Crumb {
  const t = useT();
  return { label: t("nav.courses"), route: { view: "studentCourses" } };
}

/** A course, by its code. */
export function courseCrumb(course: { id: string; code: string }): Crumb {
  return { label: course.code, route: { view: "course", id: course.id } };
}

/** `Courses › CODE › Classroom` of a classroom the reader staffs; the root alone until it is read. */
export function classroomCrumbs(root: Crumb, room: ClassroomDetail | undefined): Crumb[] {
  if (!room) return [root];
  return [
    root,
    courseCrumb(room.course),
    { label: room.name, route: { view: "classroom", id: room.id } },
  ];
}

/**
 * The classroom of a page that only knows its id. The query is the one every
 * classroom screen shares (`classroomKey`): a request only on a cold cache,
 * once, however many crumbs read it.
 */
export function useClassroomCrumbs(classroomId: string | null): Crumb[] {
  const root = useCoursesCrumb();
  const room = useQuery<ClassroomDetail>({
    queryKey: classroomKey(classroomId),
    enabled: classroomId !== null,
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
    retry: false,
  });
  return classroomCrumbs(root, room.data);
}
