import { FileStack, FolderTree, Library, Plus, School, Settings as SettingsIcon, UserPlus, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CourseSummary } from "@quiz/contracts";

import { CourseTemplates, useCourseTemplates } from "../evaluation/templates";
import { useT } from "../i18n";
import type { CourseTab, Route } from "../router";
import { Trail, useCoursesCrumb } from "../Trail";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  type MenuItem,
  PageError,
  PageHeader,
  type Person,
  PersonCard,
  Skeleton,
  Tabs,
} from "../ui";
import { CourseSettings } from "./CourseSettings";
import { LinkedPools, LinkPoolMenu } from "./CoursePools";
import { ArchivedClassrooms, ClassroomRow, HiddenBadge, useCourseDetail, useCourses } from "./parts";
import { useCourseActions } from "./useCourseActions";

/**
 * The page of one course (F-ORG-12), in tabs as the classroom's: its
 * classrooms (the default), its evaluation templates, which live here and
 * nowhere else (ADR-031), the pools it draws from, its members and its
 * settings. Each tab is a path of its own (`/courses/:id/<tab>`).
 *
 * The header's one primary action is the open tab's: New classroom, New
 * template, Link a pool, Add a staff member; Settings has none. An assistant
 * (ADR-068) is offered only New template there: the classrooms, the linked
 * pools and the staff are the owners' to change. The course's
 * actions are `useCourseActions`, the card's copy, so the two cannot drift —
 * the card keeps them in its menu, the page spreads them over its tabs.
 *
 * The course comes from the course LIST (`GET /courses`), not from its
 * detail: the list is what carries `hidden`, the staff and the headcounts the
 * actions and the rows need, the sidebar already holds it, and an id missing
 * from it is a course the caller does not reach — said as such, never a
 * crash. The detail (`GET /courses/:id`) brings the pools and the archived
 * classrooms, inside the tabs that show them.
 */
export function CoursePage({
  id,
  tab = "classrooms",
  navigate,
}: {
  id: string;
  tab?: CourseTab | undefined;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const courses = useCourses();

  if (courses.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (courses.isError) {
    return (
      <PageError
        title={t("courses.title")}
        error={courses.error}
        onRetry={() => void courses.refetch()}
        retrying={courses.isFetching}
      />
    );
  }
  const course = courses.data?.find((c) => c.id === id);
  if (!course) {
    return (
      <EmptyState
        icon={Library}
        titleAs="h1"
        title={t("courses.notFound")}
        action={
          <Button variant="secondary" onClick={() => navigate({ view: "home" })}>
            {t("courses.backToList")}
          </Button>
        }
      />
    );
  }
  // Keyed on the id: a move from one course page to another (the sidebar,
  // the palette) starts the next one with its own dialogs and toggles closed.
  return <Course key={course.id} course={course} tab={tab} navigate={navigate} />;
}

function Course({
  course,
  tab,
  navigate,
}: {
  course: CourseSummary;
  tab: CourseTab;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const coursesRoot = useCoursesCrumb();
  const actions = useCourseActions(course, { onGone: () => navigate({ view: "home" }) });
  const { isOwner } = actions;
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const templates = useCourseTemplates(course.id);
  const pools = useCourseDetail(course.id).data?.pools;
  const open = (next: CourseTab) => navigate({ view: "course", id: course.id, tab: next });

  // The open tab's one primary action. New template is every member's; the
  // other three are the owners' (ADR-068), and an assistant gets none there.
  const newTemplate = (
    <Button onClick={() => setCreatingTemplate(true)}>
      <Plus /> {t("templates.new")}
    </Button>
  );
  const ownerPrimary: Partial<Record<CourseTab, ReactNode>> = {
    classrooms: (
      <Button onClick={actions.newClassroom}>
        <Plus /> {t("classrooms.new")}
      </Button>
    ),
    pools: <LinkPoolMenu course={course} />,
    members: (
      <Button onClick={actions.addStaff}>
        <UserPlus /> {t("courses.staffAdd")}
      </Button>
    ),
  };
  const primary = tab === "templates" ? newTemplate : isOwner ? ownerPrimary[tab] : null;

  return (
    <div className="space-y-6">
      <PageHeader
        help="courses"
        eyebrow={
          <Trail navigate={navigate} items={[coursesRoot, { label: course.code }]} />
        }
        title={
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            {course.name}
            <span className="text-base font-normal text-fg-muted">{course.code}</span>
            <HiddenBadge course={course} />
          </span>
        }
        actions={primary}
      />

      <div className="space-y-4">
        <Tabs
          value={tab}
          onChange={open}
          label={t("courses.tabs")}
          items={[
            // No number while a list is loading or failed: a "0" that means
            // "not known yet" is worse than no count at all.
            { value: "classrooms", label: t("classrooms.title"), count: course.classrooms.length, icon: School },
            { value: "templates", label: t("courses.tab.templates"), count: templates.data?.length, icon: FileStack },
            { value: "pools", label: t("courses.tab.pools"), count: pools?.length, icon: FolderTree },
            { value: "members", label: t("courses.tab.members"), count: course.staff.length, icon: Users },
            { value: "settings", label: t("courses.tab.settings"), icon: SettingsIcon },
          ]}
        />

        {tab === "classrooms" ? (
          <Card className="space-y-1 p-3">
            {course.classrooms.length === 0 ? (
              // Words, not a second button: "New classroom" is in the header,
              // and two accent fills of the same action is noise (W19).
              <p className="px-2.5 py-2 text-sm text-fg-muted">{t("classrooms.empty")}</p>
            ) : (
              course.classrooms.map((room) => (
                <ClassroomRow key={room.id} room={room} students={room.students} navigate={navigate} />
              ))
            )}
            <ArchivedClassrooms course={course} navigate={navigate} />
          </Card>
        ) : tab === "templates" ? (
          <CourseTemplates
            courseId={course.id}
            classrooms={course.classrooms}
            navigate={navigate}
            creating={creatingTemplate}
            onCreating={setCreatingTemplate}
          />
        ) : tab === "pools" ? (
          <LinkedPools course={course} navigate={navigate} />
        ) : tab === "members" ? (
          <CourseMembers course={course} staffActions={actions.staffActions} />
        ) : (
          <CourseSettings course={course} actions={actions} />
        )}
      </div>

      {actions.dialogs}
    </div>
  );
}

/**
 * The staff of the course, one row each, with its role (ADR-068) and what may
 * be done to the seat (`useCourseActions`: the owners change roles and
 * remove, an assistant leaves). Every member reaches the whole course (D04);
 * the line under the list says what an owner does more, and how one is added.
 */
function CourseMembers({
  course,
  staffActions,
}: {
  course: CourseSummary;
  staffActions: ReturnType<typeof useCourseActions>["staffActions"];
}) {
  const t = useT();
  return (
    <div className="max-w-3xl space-y-3">
      <Card className="divide-y divide-line px-4">
        {course.staff.map((person) => (
          <div key={person.userId} className="py-3">
            <PersonCard
              person={person}
              actions={staffActions(person)}
              badge={
                <Badge tone="zinc">
                  {t(person.role === "owner" ? "courses.role.owner" : "courses.role.assistant")}
                </Badge>
              }
            />
          </div>
        ))}
      </Card>
      <p className="text-[13px] text-fg-muted">{t("courses.members.hint")}</p>
    </div>
  );
}
