import { render } from "@testing-library/react";
import { Eye } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { buildCommands, groupCommands, type Command, type CommandContext } from "./commands";
import type { TFunction } from "./i18n";
import { screenCommands, useScreenCommands } from "./screenCommands";
import { makeMe } from "./test/fixtures";

/*
 * A screen lends its own commands to the palette while it is mounted
 * (docs/spec/08 §8.4). What matters is that they leave with it: a "Publish
 * this question" entry surviving the editor would run against a question
 * nobody is looking at — and that `buildCommands`, the single list the
 * palette walks, is where they land.
 */
function Screen({ commands }: { commands: Command[] }) {
  useScreenCommands(commands);
  return null;
}

describe("useScreenCommands", () => {
  it("registers while mounted and clears on unmount", () => {
    const run = vi.fn();
    const commands: Command[] = [
      { id: "question:publish", label: "Publish this question", icon: Eye, group: "action", run },
    ];
    const { unmount } = render(<Screen commands={commands} />);
    expect(screenCommands().map((c) => c.id)).toEqual(["question:publish"]);
    screenCommands()[0]!.run();
    expect(run).toHaveBeenCalled();
    unmount();
    expect(screenCommands()).toEqual([]);
  });

  it("keeps the latest registration when the screen re-renders", () => {
    const first: Command[] = [{ id: "a", label: "A", icon: Eye, group: "action", run: vi.fn() }];
    const second: Command[] = [{ id: "b", label: "B", icon: Eye, group: "action", run: vi.fn() }];
    const { rerender } = render(<Screen commands={first} />);
    rerender(<Screen commands={second} />);
    expect(screenCommands().map((c) => c.id)).toEqual(["b"]);
  });
});

/** A teacher standing on the home screen. */
const context = (): CommandContext => ({
  t: ((key: string) => key) as TFunction,
  locale: "en",
  setLocale: vi.fn(),
  route: { view: "home" },
  navigate: vi.fn(),
  me: makeMe(),
  teacherUi: true,
  studentView: false,
  courses: [],
  themeChoice: "system",
  resolvedTheme: "light",
  setThemeChoice: vi.fn(),
  openHelp: vi.fn(),
  helpTopics: [{ topic: "roster", title: "Roster" }],
  signOut: vi.fn(),
});

describe("buildCommands and the mounted screen", () => {
  it("puts the screen's commands first within their group, before the generic ones", () => {
    const commands: Command[] = [
      { id: "question:publish", label: "Publish", icon: Eye, group: "action", run: vi.fn() },
    ];
    const { unmount } = render(<Screen commands={commands} />);
    const actions = groupCommands(buildCommands(context())).find((g) => g.group === "action");
    expect(actions?.commands.map((c) => c.id)).toEqual([
      "question:publish",
      "action:theme",
      "action:locale",
      "action:signout",
    ]);
    unmount();
    expect(buildCommands(context()).map((c) => c.id)).not.toContain("question:publish");
  });
});
