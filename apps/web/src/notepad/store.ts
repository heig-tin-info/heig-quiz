/**
 * Where the notepad's pages live between two loads of the player (ADR-090
 * §4): this device's `localStorage`, one key per attempt. Nothing of it ever
 * reaches the server — no request, no event, no audit.
 *
 * Every access is wrapped: storage may throw (a private window, blocked site
 * data, a full quota). A read that fails is "nothing stored"; a write that
 * fails says so, and the notepad tells the student rather than losing their
 * notes in silence.
 *
 * The notes are deleted with the attempt: at every end `useAttempt` sees
 * (submitted, deadline, evaluation closed), at sign-out, when a kiosk
 * station or the pairing page loads (every notepad), and — on a player's
 * load — those of attempts left untouched for a day. Never the recent notes
 * of another attempt: a student may have an exercise open in another tab.
 */

/** The prefix of every notepad key; the attempt's id follows. */
export const NOTEPAD_KEY_PREFIX = "quiz.notepad.";
/** At most this many pages. */
export const MAX_PAGES = 20;
/** At most this many characters on one page. */
export const MAX_PAGE_LENGTH = 10_000;
/** Notes older than this are removed when a player loads: no attempt runs that long unattended. */
export const STALE_MS = 24 * 60 * 60_000;

/** What is stored: the pages, the one on screen, the checkpoint they were written under, and when. */
export interface NotepadNotes {
  pages: string[];
  page: number;
  /**
   * The furthest checkpoint crossed when the notes were written
   * (`furthestCheckpoint`, `@quiz/domain`): a further one empties them.
   */
  checkpoint: number;
  /** `Date.now()` of the last write. */
  savedAt: number;
}

export const notepadKey = (attemptId: string) => `${NOTEPAD_KEY_PREFIX}${attemptId}`;

/** One empty page, written under `checkpoint`. */
export const emptyNotes = (checkpoint: number): NotepadNotes => ({ pages: [""], page: 0, checkpoint, savedAt: 0 });

/**
 * Attempts that ended in this page: a late write (a keystroke's effect after
 * the purge) must not bring their notes back.
 */
const ended = new Set<string>();

/** Parses a stored value; anything malformed is "nothing stored". */
export function parseNotes(raw: string | null): NotepadNotes | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<NotepadNotes>;
    if (
      !Array.isArray(value.pages) ||
      value.pages.length === 0 ||
      !value.pages.every((page) => typeof page === "string") ||
      typeof value.checkpoint !== "number" ||
      typeof value.savedAt !== "number"
    ) {
      return null;
    }
    const pages = value.pages.slice(0, MAX_PAGES).map((page) => page.slice(0, MAX_PAGE_LENGTH));
    const page = typeof value.page === "number" ? Math.min(Math.max(0, Math.trunc(value.page)), pages.length - 1) : 0;
    return { pages, page, checkpoint: value.checkpoint, savedAt: value.savedAt };
  } catch {
    return null;
  }
}

export function loadNotes(attemptId: string): NotepadNotes | null {
  try {
    return parseNotes(localStorage.getItem(notepadKey(attemptId)));
  } catch {
    return null;
  }
}

/** Writes the notes; false when the device refused them (the caller tells the student). */
export function saveNotes(attemptId: string, notes: NotepadNotes): boolean {
  if (ended.has(attemptId)) return true;
  try {
    localStorage.setItem(notepadKey(attemptId), JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

/** The attempt is over: its notes go, and stay gone. */
export function purgeNotepad(attemptId: string): void {
  ended.add(attemptId);
  try {
    localStorage.removeItem(notepadKey(attemptId));
  } catch {
    // Nothing to clean in a storage that cannot be read either.
  }
}

/** Every notepad key on this device, read defensively. */
function notepadKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(NOTEPAD_KEY_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // As above.
  }
}

/** Sign-out, a kiosk station, the pairing page: no student's notes stay on this device. */
export function purgeAllNotepads(): void {
  for (const key of notepadKeys()) remove(key);
}

/** On a player's load: the notes of attempts untouched for {@link STALE_MS} (or unreadable) go. */
export function purgeStaleNotepads(now: number): void {
  for (const key of notepadKeys()) {
    let notes: NotepadNotes | null = null;
    try {
      notes = parseNotes(localStorage.getItem(key));
    } catch {
      notes = null;
    }
    if (notes === null || now - notes.savedAt > STALE_MS) remove(key);
  }
}
