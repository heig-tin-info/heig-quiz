import { useEffect } from "react";

import type { Command } from "./commands";

/**
 * A command a mounted screen lends, classified where it is written for the
 * teacher assistant (ADR-080 P2b).
 *
 * - `effect`: what running it does to the platform's data — `none` (it
 *   opens, shows, selects, previews, and changes nothing) or `write`. The
 *   assistant is offered, and runs, the `none` ones only.
 * - `gesture`: it needs a real user gesture (`window.open` is blocked as a
 *   pop-up after an asynchronous answer), so the assistant's answer offers
 *   it as a button the teacher clicks instead of running it.
 * - Its `label` reaches the model with its id: it is screen chrome, and
 *   never embeds an entity's name or content (a title, a student, a
 *   question); a command that would need one uses a generic label.
 */
export type ScreenCommand = Command & { effect: "none" | "write"; gesture?: true };

/**
 * The ONE registry of "the commands of the mounted screen"
 * (`docs/spec/08-experience-deux-niveaux.md` §8.4: "the actions are provided
 * by the mounted screens, through a command registry […] the palette knows
 * nothing about the modules").
 *
 * `buildCommands` takes an explicit context and, beside it, reads the one slot
 * below — it cannot know from the context alone that a pool screen is open, or
 * which question the editor holds. So a screen
 * declares its own commands here while it is mounted, and `buildCommands`
 * reads them when the palette opens, which is why a stale closure is not a
 * thing. They come FIRST within their group, before the generic ones: the
 * screen under the palette is what the reader is working on.
 *
 * One slot and not a set of sources: exactly one screen is mounted under the
 * palette at a time, and two of them would mean two "Publish" entries.
 */
let current: ScreenCommand[] = [];

/** Registers `commands` for as long as the calling component is mounted. */
export function useScreenCommands(commands: ScreenCommand[]): void {
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
export function screenCommands(): ScreenCommand[] {
  return current;
}
