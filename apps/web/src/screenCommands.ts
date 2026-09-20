import { useEffect } from "react";

import type { Command } from "./commands";

/**
 * The commands a MOUNTED screen adds to the palette
 * (`docs/spec/08-experience-deux-niveaux.md` §8.3: "les actions sont fournies
 * par les écrans montés").
 *
 * `buildCommands` stays a pure function of an explicit context — it cannot
 * know that a pool screen is open, or which question the editor holds. So a
 * screen registers its own commands while it is mounted, and the palette,
 * which is opened from the same page, reads them at build time.
 *
 * One screen at a time on purpose: two of them would mean two "Publish"
 * entries, and there is only ever one page under the palette.
 */
let current: Command[] = [];

/** Registers `commands` for as long as the calling component is mounted. */
export function useScreenCommands(commands: Command[]): void {
  // No dependency array: the commands close over the screen's current state
  // (the selected category, the draft being published), and re-registering
  // them on every render is one assignment.
  useEffect(() => {
    current = commands;
    return () => {
      current = [];
    };
  });
}

/** What the palette appends to the global list. */
export function screenCommands(): Command[] {
  return current;
}
