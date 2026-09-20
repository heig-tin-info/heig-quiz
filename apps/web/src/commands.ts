import {
  BookOpen,
  CircleHelp,
  ClipboardList,
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
} from "lucide-react";

import type { CourseSummary, Me, PoolSummary } from "@quiz/contracts";

import { fuzzyFilter } from "./fuzzy";
import { DOCS_URL, SOURCES_URL } from "./Header";
import { LOCALES, type Locale, type TFunction } from "./i18n";
import type { Route } from "./router";
import type { Theme, ThemeChoice } from "./theme";
import type { IconType } from "./ui";

/*
 * What the command palette can do, as data. No JSX and no hook here on
 * purpose: the list is the part worth testing (which command shows up for
 * which viewer, what the fuzzy match sees), and a plain function of an
 * explicit context is testable by writing that context down.
 */

export type CommandGroupId = "navigate" | "action" | "help";

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
  themeChoice: ThemeChoice;
  resolvedTheme: Theme;
  setThemeChoice: (c: ThemeChoice) => void;
  openHelp: (topic: string) => void;
  helpTopics: { topic: string; title: string }[];
  signOut: () => void;
}

/** Id prefix of the per-classroom commands; the cap below recognizes them by it. */
export const CLASSROOM_COMMAND_PREFIX = "classroom:";

/** Id prefix of the per-pool commands (WP7). */
export const POOL_COMMAND_PREFIX = "pool:";

/**
 * How many classrooms the palette lists while nothing is typed. A teacher can
 * have thirty of them (the sidebar caps at twelve for the same reason): all of
 * them on an empty query would be a wall pushing the actions and the help out
 * of sight, and the palette would open on the one thing the reader did not
 * come for. Typing searches every classroom, so none is out of reach.
 */
export const EMPTY_QUERY_CLASSROOM_CAP = 6;

/** Opens an external page without handing it a reference to this one. */
function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Every command the viewer of `ctx` can run, in group order. */
export function buildCommands(ctx: CommandContext): Command[] {
  const { t, navigate } = ctx;
  const commands: Command[] = [
    {
      id: "nav:home",
      // Same label and icon as the first row of the sidebar: the palette must
      // name things the way the screen behind it does.
      // WP9: student player — same label as the sidebar row it duplicates.
      label: ctx.teacherUi ? t("nav.courses") : t("shome.title"),
      icon: ctx.teacherUi ? Library : ClipboardList,
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

  if (ctx.teacherUi) {
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
    for (const course of ctx.courses) {
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

  return commands;
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
