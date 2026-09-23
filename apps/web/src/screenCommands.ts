import { useEffect } from "react";

import type { Command } from "./commands";

/**
 * The ONE registry of "the commands of the mounted screen"
 * (`docs/spec/08-experience-deux-niveaux.md` §8.4: "the actions are provided
 * by the mounted screens, through a command registry […] the palette knows
 * nothing about the modules").
 *
 * `buildCommands` stays a function of an explicit context — it cannot know
 * that a pool screen is open, or which question the editor holds. So a screen
 * declares its own commands here while it is mounted, and `buildCommands`
 * reads them when the palette opens, which is why a stale closure is not a
 * thing. They come FIRST within their group, before the generic ones: the
 * screen under the palette is what the reader is working on.
 *
 * One slot and not a set of sources: exactly one screen is mounted under the
 * palette at a time, and two of them would mean two "Publish" entries.
 */
let current: Command[] = [];

/** Registers `commands` for as long as the calling component is mounted. */
export function useScreenCommands(commands: Command[]): void {
  // No dependency array: the commands close over the screen's current state
  // (the selected category, the draft being published, the live controls),
  // and re-registering them on every render is one assignment.
  useEffect(() => {
    current = commands;
    return () => {
      current = [];
    };
  });
}

/** What `buildCommands` folds into the global list. */
export function screenCommands(): Command[] {
  return current;
}
