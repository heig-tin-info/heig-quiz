/**
 * The last text copied or cut from the notepad (ADR-090 §6) — the contract
 * the paste step of the integrity journal (ADR-088) will read, not yet the
 * detection itself.
 *
 * The rule it serves: a paste into an ANSWER is exempt from the journal only
 * when its text equals the last copy out of the notepad, which is the
 * student's own scratch work on this page; any other paste into an answer
 * counts as coming from outside. A paste INTO the notepad from outside is
 * journaled like any outside paste (the notepad is not a way to launder one).
 *
 * In memory only, on purpose: never persisted, never sent. A reload forgets
 * it, and a paste after a reload is then journaled — the safe direction.
 */

let lastCopy: string | null = null;

/** The notepad's copy or cut handler records what left it. An empty selection records nothing. */
export function recordNotepadCopy(text: string): void {
  if (text !== "") lastCopy = text;
}

/** Whether a pasted text is exactly the last one copied or cut from the notepad. */
export function isFromNotepad(text: string): boolean {
  return lastCopy !== null && text === lastCopy;
}

/** Forgets the last copy: the attempt ended, or a test starts afresh. */
export function forgetNotepadCopy(): void {
  lastCopy = null;
}
