import {
  BarChart3,
  BookOpen,
  CalendarRange,
  GitBranch,
  Users,
  ClipboardCheck,
  CircleHelp,
  Code2,
  FolderTree,
  GraduationCap,
  Languages,
  Library,
  LogOut,
  Monitor,
  Moon,
  School,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Vote,
} from "lucide-react";

import type { CourseSummary, Me, PoolSummary } from "@quiz/contracts";

import { inNavigation } from "./CourseNav";
import { fuzzyFilter } from "./fuzzy";
import { gradingLinks } from "./grading";
import { DOCS_URL, SOURCES_URL } from "./Header";
import { LOCALES, type Locale, type TFunction } from "./i18n";
import type { PaletteProject } from "./paletteProjects";
import { evaluationInView, type Route } from "./router";
import { screenCommands } from "./screenCommands";
import { homeLook } from "./student/BottomNav";
import type { Theme, ThemeChoice } from "./theme";
import type { IconType } from "./ui";

/*
 * What the command palette can do, as data. No JSX and no hook here on
 * purpose: the list is the part worth testing (which command shows up for
 * which viewer, what the fuzzy match sees), and a plain function of an
 * explicit context is testable by writing that context down.
 */

type CommandGroupId = "navigate" | "action" | "help";

export interface Command {
  /** Stable id: used as the React key, the option DOM id and in tests. */
  id: string;
  /** Already localized by the builder. */
  label: string;
  /** Second, muted line (org login, "External link", …). Optional. */
  hint?: string;
  icon: IconType;
  group: CommandGroupId;
  /** Extra text the fuzzy match sees but the row does not show. */
  keywords?: string;
  run: () => void;
}

/** Everything a command needs to exist and to run, gathered by the Shell. */
export interface CommandContext {
  t: TFunction;
  locale: Locale;
  setLocale: (l: Locale, persist?: boolean) => void;
  route: Route;
  navigate: (r: Route) => void;
  me: Me;
  /** The teacher UI is on (false in student view and for students). */
  teacherUi: boolean;
  studentView: boolean;
  /** Absent for a plain student: they have no other view to switch to. */
  onToggleStudentView?: () => void;
  courses: CourseSummary[];
  /** The teacher's question pools; absent for a student (WP7). */
  pools?: PoolSummary[];
  /**
   * The projects the viewer may open: the staff's from their Activities, a
   * student's from their own home (`paletteProjects.ts`), never the other's.
   */
  projects?: PaletteProject[];
  themeChoice: ThemeChoice;
  resolvedTheme: Theme;
  setThemeChoice: (c: ThemeChoice) => void;
  openHelp: (topic: string) => void;
  helpTopics: { topic: string; title: string }[];
  signOut: () => void;
  /**
   * Opens the poll launcher (F-LIVE-13). A callback and not a route: a poll
   * is STARTED from wherever the teacher stands, and the launcher is a sheet
   * the Shell owns — the palette has no sheet of its own to open.
   */
  onStartPoll?: () => void;
}

/** Id prefix of the per-classroom commands; the cap below recognizes them by it. */
export const CLASSROOM_COMMAND_PREFIX = "classroom:";

/** Id prefix of the per-course commands. */
const COURSE_COMMAND_PREFIX = "course:";

/** Id prefix of the per-pool commands (WP7). */
const POOL_COMMAND_PREFIX = "pool:";

/**
 * How many classrooms the palette lists while nothing is typed. A teacher can
 * have thirty of them (the sidebar caps at twelve for the same reason): all of
 * them on an empty query would be a wall pushing the actions and the help out
 * of sight, and the palette would open on the one thing the reader did not
 * come for. Typing searches every classroom, so none is out of reach.
 */
export const EMPTY_QUERY_CLASSROOM_CAP = 6;

/** Id prefix of the per-project commands (M7-01). */
const PROJECT_COMMAND_PREFIX = "project:";

/** The classroom a classroom screen shows, or null: the Journal and Groups jumps are about it. */
function classroomInView(route: Route): string | null {
  switch (route.view) {
    case "classroom":
    case "classroomSettings":
    case "classroomJournal":
    case "classroomGroups":
    case "classroomGrades":
      return route.id;
    case "groupSet":
    case "projectNew":
      return route.classroomId;
    default:
      return null;
  }
}

/** Opens an external page without handing it a reference to this one. */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** The mounted screen's own commands first, then every command the viewer of `ctx` can run. */
export function buildCommands(ctx: CommandContext): Command[] {
  const { t, navigate } = ctx;
  const commands: Command[] = [
    {
      id: "nav:home",
      // Same label and icon as the sidebar row it duplicates: the palette must
      // name things the way the screen behind it does.
      // A student's home is their Activities, the first row of their sidebar.
      label: t(homeLook(ctx.teacherUi).label),
      icon: homeLook(ctx.teacherUi).icon,
      group: "navigate",
      run: () => navigate({ view: "home" }),
    },
    {
      id: "nav:settings",
      label: t("menu.settings"),
      icon: SettingsIcon,
      group: "navigate",
      run: () => navigate({ view: "settings" }),
    },
  ];

  if (ctx.me.role === "admin" && ctx.teacherUi) {
    commands.push({
      id: "nav:admin",
      label: t("nav.admin"),
      icon: ShieldCheck,
      group: "navigate",
      run: () => navigate({ view: "admin" }),
    });
  }

  if (ctx.teacherUi && ctx.onStartPoll) {
    const startPoll = ctx.onStartPoll;
    commands.push({
      id: "action:poll",
      label: t("poll.start"),
      hint: t("poll.launcherHint"),
      icon: Vote,
      group: "action",
      keywords: "poll vote sondage question live",
      run: () => startPoll(),
    });
  }

  if (ctx.teacherUi) {
    commands.push({
      id: "nav:activities",
      label: t("nav.activities"),
      icon: CalendarRange,
      group: "navigate",
      keywords: "activities activités schedule planning live exams polls",
      run: () => navigate({ view: "activities" }),
    });
    commands.push({
      id: "nav:pools",
      label: t("pools.title"),
      icon: FolderTree,
      group: "navigate",
      run: () => navigate({ view: "pools" }),
    });
    for (const pool of ctx.pools ?? []) {
      commands.push({
        id: `${POOL_COMMAND_PREFIX}${pool.id}`,
        label: t("palette.openPool", { name: pool.name }),
        hint: t(pool.questionCount === 1 ? "pools.questions.one" : "pools.questions", {
          n: pool.questionCount,
        }),
        icon: FolderTree,
        group: "navigate",
        run: () => navigate({ view: "pool", id: pool.id }),
      });
    }
    // A course the teacher hid is out of their navigation, the palette
    // included (#155); it and its classrooms stay one click away on the
    // course list.
    for (const course of ctx.courses.filter((c) => inNavigation(c))) {
      // "Go to the course" (08 §8.4): the course page, where its classrooms,
      // pools and templates are. The code rides in the hint, where the fuzzy
      // match sees it: it is what the sidebar row shows and what a teacher
      // types.
      commands.push({
        id: `${COURSE_COMMAND_PREFIX}${course.id}`,
        label: t("palette.openCourse", { name: course.name }),
        hint: course.code,
        icon: Library,
        group: "navigate",
        run: () => navigate({ view: "course", id: course.id }),
      });
      for (const room of course.classrooms) {
        commands.push({
          id: `${CLASSROOM_COMMAND_PREFIX}${room.id}`,
          label: t("palette.openClassroom", { name: room.name }),
          hint: `${course.code} — ${course.name}`,
          // The course code is how a teacher names a classroom out loud, and
          // it is shorter to type than the display name.
          keywords: `${course.code} ${course.name} ${room.period}`,
          icon: School,
          group: "navigate",
          run: () => navigate({ view: "classroom", id: room.id }),
        });
      }
    }
  }

  // M7-01: the projects the viewer may open, by name, and the Journal and
  // Groups tabs of the classroom on screen. Not one jump per classroom: that
  // would be a wall of rows for tabs that exist only when a journal or a group
  // set does, and the tab's own page falls back to the classroom when it is
  // absent. A student has no Groups jump: their page of it exists only while
  // a set is open to them.
  for (const project of ctx.projects ?? []) {
    commands.push({
      id: `${PROJECT_COMMAND_PREFIX}${project.id}`,
      label: t("palette.openProject", { name: project.title }),
      hint: project.hint,
      keywords: "project projet github",
      icon: GitBranch,
      group: "navigate",
      run: () => navigate({ view: "project", id: project.id }),
    });
  }
  const roomInView = classroomInView(ctx.route);
  if (roomInView !== null) {
    commands.push({
      id: "nav:journal",
      label: t("palette.openJournal"),
      icon: BookOpen,
      group: "navigate",
      keywords: "journal notes pages",
      run: () => navigate({ view: "classroomJournal", id: roomInView }),
    });
    if (ctx.teacherUi) {
      commands.push({
        id: "nav:groups",
        label: t("palette.openGroups"),
        icon: Users,
        group: "navigate",
        keywords: "groups groupes teams équipes",
        run: () => navigate({ view: "classroomGroups", id: roomInView }),
      });
    }
  }

  // WP10: grading + results. Derived from the route and nothing else — the
  // palette has no evaluation list to walk, but a teacher standing on ANY
  // screen of one evaluation must be able to reach its other three without
  // going back through the classroom.
  //
  // Teacher-only, twice over: the student UI never mounts these screens, and
  // in the teacher's own student view `teacherUi` is false, so the palette
  // there offers exactly what a student's does.
  const evaluationId = evaluationInView(ctx.route);
  if (ctx.teacherUi && evaluationId !== null) {
    const links = gradingLinks(evaluationId);
    commands.push(
      {
        id: "nav:grading",
        label: t("palette.openGrading"),
        icon: ClipboardCheck,
        group: "navigate",
        run: () => navigate(links.grading),
      },
      {
        id: "nav:results",
        label: t("palette.openResults"),
        icon: BarChart3,
        group: "navigate",
        run: () => navigate(links.results),
      },
    );
  }

  const dark = ctx.resolvedTheme === "dark";
  commands.push({
    id: "action:theme",
    // Flips what is on screen and stores that as an explicit choice, exactly
    // like the account menu: a toggle with two labels cannot express "system".
    label: dark ? t("menu.lightTheme") : t("menu.darkTheme"),
    icon: dark ? Sun : Moon,
    group: "action",
    run: () => ctx.setThemeChoice(dark ? "light" : "dark"),
  });
  if (ctx.themeChoice !== "system") {
    // The only way back to "system" outside the Settings page: the two-label
    // toggle above can never return there on its own.
    commands.push({
      id: "action:theme-system",
      label: t("palette.themeSystem"),
      icon: Monitor,
      group: "action",
      run: () => ctx.setThemeChoice("system"),
    });
  }

  const other = LOCALES.find((l) => l.code !== ctx.locale);
  if (other) {
    commands.push({
      id: "action:locale",
      // The target language is named in its own language, so the command is
      // readable by someone who cannot read the interface it sits in.
      label: t("palette.switchLocale", { language: other.label }),
      icon: Languages,
      group: "action",
      run: () => ctx.setLocale(other.code),
    });
  }

  if (ctx.onToggleStudentView) {
    const toggle = ctx.onToggleStudentView;
    commands.push({
      id: "action:student-view",
      label: ctx.studentView ? t("menu.teacherView") : t("menu.studentView"),
      icon: ctx.studentView ? School : GraduationCap,
      group: "action",
      run: () => toggle(),
    });
  }

  commands.push({
    id: "action:signout",
    label: t("menu.signout"),
    icon: LogOut,
    group: "action",
    run: () => ctx.signOut(),
  });

  commands.push(
    {
      id: "help:docs",
      label: t("header.docs"),
      hint: t("palette.external"),
      icon: BookOpen,
      group: "help",
      run: () => openExternal(DOCS_URL),
    },
    {
      id: "help:sources",
      label: t("header.sources"),
      hint: t("palette.external"),
      icon: Code2,
      group: "help",
      run: () => openExternal(SOURCES_URL),
    },
  );

  for (const { topic, title } of ctx.helpTopics) {
    commands.push({
      id: `help:${topic}`,
      label: title,
      hint: t("palette.helpHint"),
      icon: CircleHelp,
      group: "help",
      run: () => ctx.openHelp(topic),
    });
  }

  // WP8: the commands the MOUNTED SCREEN lends to the palette — the live
  // dashboard's start / pause / +5 min / close, the editor's "Publish this
  // question". They come FIRST, and `groupCommands` keeps that order inside
  // each group: the screen under the palette is what the reader is working
  // on, so its own actions outrank the generic ones. `screenCommands.ts`
  // holds the registry and the rule.
  return [...screenCommands(), ...commands];
}

/**
 * Applies `EMPTY_QUERY_CLASSROOM_CAP`. It is a separate step, run by the
 * caller after the filter, rather than a `query` parameter of `buildCommands`:
 * the cap is about what an untouched list looks like, not about which commands
 * exist, and keeping `buildCommands` a function of the context alone is what
 * makes it readable as the registry it is.
 */
export function capClassrooms(commands: Command[], query: string): Command[] {
  if (query.trim() !== "") return commands;
  let shown = 0;
  return commands.filter((c) => {
    if (!c.id.startsWith(CLASSROOM_COMMAND_PREFIX)) return true;
    shown += 1;
    return shown <= EMPTY_QUERY_CLASSROOM_CAP;
  });
}

/**
 * Fuzzy match over the label, the hint and the hidden keywords at once, so
 * typing an org login finds a classroom whose displayed name shares nothing
 * with it.
 */
export function filterCommands(query: string, commands: Command[]): Command[] {
  return fuzzyFilter(query, commands, (c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`);
}

/** The fixed order of the groups; see `groupCommands`. */
const GROUP_ORDER: CommandGroupId[] = ["navigate", "action", "help"];

/**
 * Groups the visible commands, in a fixed order, skipping the empty groups.
 *
 * The order is fixed and not driven by the best score in each group: the
 * reader types one more letter while their finger is already on Enter, and a
 * list that reshuffles its sections between two keystrokes runs the wrong
 * command. Within a group the filter's score still decides.
 */
export function groupCommands(
  commands: Command[],
): { group: CommandGroupId; commands: Command[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    commands: commands.filter((c) => c.group === group),
  })).filter((g) => g.commands.length > 0);
}
