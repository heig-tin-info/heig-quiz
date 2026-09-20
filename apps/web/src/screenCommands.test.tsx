import { render } from "@testing-library/react";
import { Eye } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import type { Command } from "./commands";
import { screenCommands, useScreenCommands } from "./screenCommands";

/*
 * A screen lends its own commands to the palette while it is mounted
 * (docs/spec/08 §8.3). What matters is that they leave with it: a "Publish
 * this question" entry surviving the editor would run against a question
 * nobody is looking at.
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
