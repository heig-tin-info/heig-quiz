// @vitest-environment jsdom
import { ClipboardList, Library } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import {
  buildCommands,
  capClassrooms,
  filterCommands,
  groupCommands,
  CLASSROOM_COMMAND_PREFIX,
  EMPTY_QUERY_CLASSROOM_CAP,
  type Command,
  type CommandContext,
} from "./commands";
import { DICTS, type Locale, type TFunction } from "./i18n";
import { makeClassroomSummary, makeCourseSummary, makeMe } from "./test/fixtures";

/*
 * The registry behind the command palette: which command exists for which
 * viewer, what it is called, and what it does when it runs. Nothing renders
 * here — the whole point of `buildCommands` being a function of an explicit
 * context is that the context can be written down.
 */

/** The real dictionaries, so a missing `fr` string fails a test instead of
 *  falling back silently. */
function makeT(locale: Locale): TFunction {
  return (key, vars) => {
    const raw = DICTS[locale][key as string] ?? String(key);
    return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
  };
}

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const locale = overrides.locale ?? "en";
  return {
    t: makeT(locale),
    locale,
    setLocale: vi.fn(),
    route: { view: "home" },
    navigate: vi.fn(),
    me: makeMe(),
    teacherUi: true,
    studentView: false,
    onToggleStudentView: vi.fn(),
    courses: [makeCourseSummary()],
    themeChoice: "system",
    resolvedTheme: "light",
    setThemeChoice: vi.fn(),
    openHelp: vi.fn(),
    helpTopics: [{ topic: "roster", title: "Roster" }],
    signOut: vi.fn(),
    ...overrides,
  };
}

const ids = (commands: Command[]) => commands.map((c) => c.id);
const pick = (commands: Command[], id: string) => commands.find((c) => c.id === id);
const need = (commands: Command[], id: string) => {
  const found = pick(commands, id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
};

/** One course carrying `n` classrooms. */
const courses = (n: number) => [
  makeCourseSummary({
    classrooms: Array.from({ length: n }, (_, i) =>
      makeClassroomSummary({ id: `c${i + 1}`, name: `Classroom ${i + 1}` }),
    ),
  }),
];

describe("buildCommands: who sees what", () => {
  it("names the home row the way the sidebar does, per viewer", () => {
    const teacher = need(buildCommands(makeContext()), "nav:home");
    expect(teacher.label).toBe("Courses");
    expect(teacher.icon).toBe(Library);

    const student = need(
      buildCommands(makeContext({ me: makeMe({ role: "student" }), teacherUi: false })),
      "nav:home",
    );
    expect(student.label).toBe("Home");
    expect(student.icon).toBe(ClipboardList);
  });

  it("offers Administration to an admin in the teacher UI, and to nobody else", () => {
    const admin = makeMe({ role: "admin" });
    expect(pick(buildCommands(makeContext({ me: admin })), "nav:admin")).toBeDefined();
    expect(
      pick(buildCommands(makeContext({ me: admin, teacherUi: false })), "nav:admin"),
    ).toBeUndefined();
    expect(pick(buildCommands(makeContext()), "nav:admin")).toBeUndefined();
  });

  it("lists the classrooms of every course, and none outside the teacher UI", () => {
    const withRooms = buildCommands(makeContext({ courses: courses(3) }));
    expect(ids(withRooms).filter((id) => id.startsWith(CLASSROOM_COMMAND_PREFIX))).toEqual([
      "classroom:c1",
      "classroom:c2",
      "classroom:c3",
    ]);
    const student = buildCommands(
      makeContext({ me: makeMe({ role: "student" }), teacherUi: false, courses: [] }),
    );
    expect(ids(student).some((id) => id.startsWith(CLASSROOM_COMMAND_PREFIX))).toBe(false);
  });

  it("opens the classroom it names", () => {
    const navigate = vi.fn();
    const commands = buildCommands(makeContext({ navigate, courses: courses(3) }));
    need(commands, "classroom:c2").run();
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "c2" });
  });

  it("hangs the course on the classroom row, as hint and as search material", () => {
    const commands = buildCommands(makeContext({ courses: courses(1) }));
    const room = need(commands, "classroom:c1");
    expect(room.hint).toBe("PRG1 — Programmation C");
    // The displayed name says nothing about the course; typing the code must
    // still find the row.
    expect(ids(filterCommands("prg1", commands))).toContain("classroom:c1");
  });

  it("offers the student-view switch only when there is one", () => {
    expect(pick(buildCommands(makeContext()), "action:student-view")).toBeDefined();
    const plainStudent = buildCommands(
      makeContext({ me: makeMe({ role: "student" }), teacherUi: false }),
    );
    // A `Partial` cannot express "absent", so the context is rebuilt without it.
    const ctx = makeContext({ me: makeMe({ role: "student" }), teacherUi: false });
    delete (ctx as { onToggleStudentView?: unknown }).onToggleStudentView;
    expect(pick(buildCommands(ctx), "action:student-view")).toBeUndefined();
    expect(pick(plainStudent, "action:student-view")).toBeDefined();
  });
});

describe("buildCommands: the theme and language actions", () => {
  it("flips the theme that is on screen", () => {
    const setThemeChoice = vi.fn();
    const dark = buildCommands(makeContext({ resolvedTheme: "dark", setThemeChoice }));
    const toggle = need(dark, "action:theme");
    expect(toggle.label).toBe("Light theme");
    toggle.run();
    expect(setThemeChoice).toHaveBeenCalledWith("light");
  });

  it("offers the way back to the system theme only when it was left", () => {
    expect(pick(buildCommands(makeContext()), "action:theme-system")).toBeUndefined();
    expect(
      pick(buildCommands(makeContext({ themeChoice: "dark" })), "action:theme-system"),
    ).toBeDefined();
  });

  it("names the other language in that language", () => {
    const setLocale = vi.fn();
    const en = need(buildCommands(makeContext({ setLocale })), "action:locale");
    expect(en.label).toBe("Switch to Français");
    en.run();
    expect(setLocale).toHaveBeenCalledWith("fr");

    const fr = need(buildCommands(makeContext({ locale: "fr" })), "action:locale");
    expect(fr.label).toBe("Passer en English");
  });
});

describe("buildCommands: help", () => {
  it("turns each topic into a command that opens it", () => {
    const openHelp = vi.fn();
    const commands = buildCommands(
      makeContext({ openHelp, helpTopics: [{ topic: "roster", title: "Roster" }] }),
    );
    const help = need(commands, "help:roster");
    expect(help.label).toBe("Roster");
    help.run();
    expect(openHelp).toHaveBeenCalledWith("roster");
  });
});

describe("capClassrooms", () => {
  it("caps the classrooms on an empty query and nothing else", () => {
    const commands = buildCommands(makeContext({ courses: courses(20) }));
    const capped = capClassrooms(commands, "");
    expect(capped.filter((c) => c.id.startsWith(CLASSROOM_COMMAND_PREFIX))).toHaveLength(
      EMPTY_QUERY_CLASSROOM_CAP,
    );
    // Everything that is not a classroom survives the cap untouched.
    expect(capped.filter((c) => !c.id.startsWith(CLASSROOM_COMMAND_PREFIX))).toEqual(
      commands.filter((c) => !c.id.startsWith(CLASSROOM_COMMAND_PREFIX)),
    );
  });

  it("lifts the cap as soon as something is typed", () => {
    const commands = buildCommands(makeContext({ courses: courses(20) }));
    expect(capClassrooms(commands, "class")).toHaveLength(commands.length);
  });
});

describe("groupCommands", () => {
  it("keeps a fixed group order and drops the empty ones", () => {
    const groups = groupCommands(buildCommands(makeContext({ courses: [] })));
    expect(groups.map((g) => g.group)).toEqual(["navigate", "action", "help"]);
    expect(groups.every((g) => g.commands.length > 0)).toBe(true);
  });
});
