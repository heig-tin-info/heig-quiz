/**
 * Where the documents panel keeps what the student set (ADR-144 §7): open or
 * not, full screen or not, the document on screen, the panel's width, and
 * each document's reading state — position, zoom, search, outline — so the
 * panel comes back as it was after a switch, a close, a pause or a reload.
 *
 * This tab's `sessionStorage`, one key per attempt; memory only for the
 * teacher's stateless preview and an impersonation session (as the
 * notepad, ADR-090). Nothing of it reaches the server: not the search
 * query, not the position.
 *
 * A document's state is kept as the viewer reported it and read back only
 * by the viewer itself, through `readViewState` (`documents/viewState.ts`),
 * which trusts nothing of its shape. The rest is read here, field by field.
 *
 * Gone with the attempt: at every end `useAttempt` sees (beside the notepad's
 * `endNotepad`), at sign-out and when a kiosk station loads
 * (`purgeAllDocumentStates`).
 */
import { z } from "zod";

export const DOCUMENTS_KEY_PREFIX = "quiz.documents.";

export const documentsKey = (attemptId: string) => `${DOCUMENTS_KEY_PREFIX}${attemptId}`;

const PanelState = z.object({
  open: z.boolean().catch(false),
  full: z.boolean().catch(false),
  /** The id of the document on screen; an id the list no longer holds falls back to the first. */
  active: z.string().max(64).nullable().catch(null),
  /** The panel's width in pixels, clamped where it is used; null is the default. */
  width: z.number().finite().nullable().catch(null),
  /** Each document's reading state, by id, as the viewer reported it (read back by `readViewState`). */
  docs: z.record(z.string().max(64), z.unknown()).catch({}),
});
export type PanelState = z.infer<typeof PanelState>;

export const emptyPanel = (): PanelState => ({ open: false, full: false, active: null, width: null, docs: {} });

/** What the preview and an impersonation keep, for this page's life only. */
const memory = new Map<string, PanelState>();
/** Attempts that ended in this page: a late write must not bring their state back. */
const ended = new Set<string>();

/** Reads a stored value; anything malformed is a field at its default. */
export function parsePanel(raw: string | null): PanelState {
  if (raw === null) return emptyPanel();
  try {
    const value: unknown = JSON.parse(raw);
    const read = PanelState.safeParse(value ?? {});
    return read.success ? read.data : emptyPanel();
  } catch {
    return emptyPanel();
  }
}

export function loadPanel(attemptId: string, persist: boolean): PanelState {
  if (!persist) return memory.get(attemptId) ?? emptyPanel();
  try {
    return parsePanel(sessionStorage.getItem(documentsKey(attemptId)));
  } catch {
    return emptyPanel();
  }
}

export function savePanel(attemptId: string, persist: boolean, state: PanelState): void {
  if (ended.has(attemptId)) return;
  if (!persist) {
    memory.set(attemptId, state);
    return;
  }
  try {
    sessionStorage.setItem(documentsKey(attemptId), JSON.stringify(state));
  } catch {
    // A full or blocked storage: the panel still works, it forgets on reload.
  }
}

/** The attempt is over: what was kept of its documents goes, and stays gone. */
export function endDocumentStates(attemptId: string): void {
  ended.add(attemptId);
  memory.delete(attemptId);
  try {
    sessionStorage.removeItem(documentsKey(attemptId));
  } catch {
    // Nothing to clean in a storage that cannot be read either.
  }
}

/** Sign-out, a kiosk station: no student's reading state stays on this device. */
export function purgeAllDocumentStates(): void {
  memory.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(DOCUMENTS_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // As above.
  }
}
