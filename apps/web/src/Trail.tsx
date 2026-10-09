/**
 * The trail of a page, in its `PageHeader` eyebrow (DESIGN.md, Breadcrumb).
 * The primitive (`ui/breadcrumb.tsx`) draws; this file knows the app: it turns
 * a crumb's route into the real address (`routeToPath`) and the router's own
 * `navigate`, and names the ancestors the pages share. The trail is
 * structural — a sidebar section, then each ancestor down to the page — never
 * the browsing history.
 *
 * The hooks return what is KNOWN: an ancestor still loading is simply not in
 * the list (never a placeholder, never a request of its own), so a page
 * spreads them and appends its own page. The last crumb is the current page:
 * the primitive ignores its route.
 */
import { useClassroom, useCourses } from "./course/parts";
import { useT, type Dict } from "./i18n";
import { routeToPath, type Route } from "./router";
import { Breadcrumb } from "./ui";

/** One level of a trail: a name, and where it leads (ignored on the page itself). */
export interface Crumb {
  label: string;
  route?: Route;
}

export function Trail({ navigate, items }: { navigate: (r: Route) => void; items: readonly Crumb[] }) {
  const t = useT();
  return (
    <Breadcrumb
      label={t("breadcrumb.label")}
      backLabel={(name) => t("breadcrumb.back", { name })}
      items={items.map(({ label, route }) =>
        route ? { label, href: routeToPath(route), onNavigate: () => navigate(route) } : { label },
      )}
    />
  );
}

/**
 * The roots of the trails: the sidebar sections a page can belong to, one
 * list (the sidebar reads its labels here too).
 */
export const SECTION_ROOTS = {
  courses: { label: "nav.courses", route: { view: "home" } },
  studentCourses: { label: "nav.courses", route: { view: "studentCourses" } },
  pools: { label: "pools.title", route: { view: "pools" } },
  admin: { label: "nav.admin", route: { view: "admin" } },
} as const satisfies Record<string, { label: keyof Dict; route: Route }>;

export function useRootCrumb(section: keyof typeof SECTION_ROOTS): Crumb {
  const t = useT();
  const root = SECTION_ROOTS[section];
  return { label: t(root.label), route: root.route };
}

/**
 * `Courses › CODE › Classroom` of a classroom the reader staffs (the course
 * by its code, short). The query is the one every classroom screen shares
 * (`classroomKey`): a request only on a cold cache, once, however many
 * crumbs read it.
 */
export function useClassroomCrumbs(classroomId: string | null | undefined): Crumb[] {
  const root = useRootCrumb("courses");
  const room = useClassroom(classroomId || null, { retry: false });
  if (!room.data) return [root];
  return [
    root,
    { label: room.data.course.code, route: { view: "course", id: room.data.course.id } },
    { label: room.data.name, route: { view: "classroom", id: room.data.id } },
  ];
}

/** The classroom's chain, then the evaluation (once its title is known). */
export function useEvaluationCrumbs(
  classroomId: string | null | undefined,
  evaluationId: string,
  title: string | undefined,
): Crumb[] {
  const classroom = useClassroomCrumbs(classroomId);
  return title === undefined ? classroom : [...classroom, { label: title, route: { view: "evaluation", id: evaluationId } }];
}

/** `Courses › CODE › Template`: the course (its Templates tab) and the template, once known. */
export function useTemplateCrumbs(
  courseId: string | undefined,
  templateId: string,
  title: string | undefined,
): Crumb[] {
  const root = useRootCrumb("courses");
  const course = useCourses().data?.find((c) => c.id === courseId);
  return [
    root,
    ...(course ? [{ label: course.code, route: { view: "course", id: course.id, tab: "templates" } as Route }] : []),
    ...(title === undefined ? [] : [{ label: title, route: { view: "template", id: templateId } as Route }]),
  ];
}
