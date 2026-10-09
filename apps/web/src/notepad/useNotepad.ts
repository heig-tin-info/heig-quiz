/**
 * The notepad's state (ADR-090): its pages, the one on screen, and where it
 * is kept.
 *
 * `persist` keeps it in this device's `localStorage` (`store.ts`), so a
 * reload finds the notes again; without it — the teacher's preview, an
 * impersonation session (ADR-034) — it lives in memory only and a reload
 * starts it over.
 *
 * Under `milestones` navigation, crossing a checkpoint empties it
 * (pedagogical, not a security control): `checkpoint` is the furthest one the
 * attempt shows (`furthestCheckpoint`, `@quiz/domain`), the notes carry the
 * one they were written under, and notes written under an earlier one are
 * dropped — on load, on every write, and as soon as the attempt moves on.
 * A second tab of the same attempt follows through the `storage` event.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  emptyNotes,
  loadNotes,
  markNotepadEnded,
  MAX_PAGES,
  MAX_PAGE_LENGTH,
  notepadKey,
  parseNotes,
  purgeStaleNotepads,
  saveNotes,
  type NotepadNotes,
} from "./store";

export interface Notepad {
  pages: string[];
  page: number;
  /** The device refused the last write: the notes are only on screen. */
  saveFailed: boolean;
  setText: (text: string) => void;
  /** Adds an empty page after the last one and shows it; nothing past {@link MAX_PAGES}. */
  newPage: () => void;
  go: (delta: 1 | -1) => void;
  /**
   * Removes the page on screen — the last one leaves one empty page — and
   * returns how to put it back (the undo), or null when it held nothing.
   */
  deletePage: () => (() => void) | null;
}

/** Notes written under an earlier checkpoint than `checkpoint` start over. */
const current = (notes: NotepadNotes, checkpoint: number): NotepadNotes =>
  checkpoint > notes.checkpoint ? emptyNotes(checkpoint) : notes;

export function useNotepad({
  attemptId,
  checkpoint,
  persist,
}: {
  attemptId: string;
  checkpoint: number;
  persist: boolean;
}): Notepad {
  const [notes, setNotes] = useState<NotepadNotes>(() => {
    if (persist) purgeStaleNotepads(Date.now());
    const stored = persist ? loadNotes(attemptId) : null;
    return stored === null ? emptyNotes(checkpoint) : current(stored, checkpoint);
  });
  const [saveFailed, setSaveFailed] = useState(false);
  // The notes as last read from or written to storage: a change that came
  // from another tab is not written back.
  const synced = useRef<NotepadNotes | null>(null);

  // The attempt crossed a checkpoint: the notes written before it go.
  useEffect(() => {
    setNotes((prev) => current(prev, checkpoint));
  }, [checkpoint]);

  useEffect(() => {
    if (!persist || notes === synced.current) return;
    synced.current = notes;
    setSaveFailed(!saveNotes(attemptId, { ...notes, savedAt: Date.now() }));
  }, [persist, attemptId, notes]);

  // Another tab of the same attempt wrote, flushed or purged the notes.
  useEffect(() => {
    if (!persist) return;
    const key = notepadKey(attemptId);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      // Removed there (the attempt ended, or the storage was cleared): no
      // later keystroke here may write the notes back.
      if (event.newValue === null) markNotepadEnded(attemptId);
      const stored = event.key === null ? null : parseNotes(event.newValue);
      const next = stored === null ? emptyNotes(checkpoint) : current(stored, checkpoint);
      synced.current = next;
      setNotes(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [persist, attemptId, checkpoint]);

  /** Every write starts from notes that hold no earlier checkpoint's work. */
  const write = useCallback(
    (change: (notes: NotepadNotes) => NotepadNotes) =>
      setNotes((prev) => change(current(prev, checkpoint))),
    [checkpoint],
  );

  const setText = useCallback(
    (text: string) =>
      write((n) => ({ ...n, pages: n.pages.map((p, i) => (i === n.page ? text.slice(0, MAX_PAGE_LENGTH) : p)) })),
    [write],
  );
  const newPage = useCallback(
    () => write((n) => (n.pages.length >= MAX_PAGES ? n : { ...n, pages: [...n.pages, ""], page: n.pages.length })),
    [write],
  );
  const go = useCallback(
    (delta: 1 | -1) =>
      write((n) => ({ ...n, page: Math.min(Math.max(0, n.page + delta), n.pages.length - 1) })),
    [write],
  );

  const deletePage = useCallback((): (() => void) | null => {
    const base = current(notes, checkpoint);
    const index = base.page;
    const text = base.pages[index] ?? "";
    const only = base.pages.length === 1;
    write((n) => {
      const pages = n.pages.filter((_, i) => i !== n.page);
      return pages.length === 0
        ? { ...n, pages: [""], page: 0 }
        : { ...n, pages, page: Math.min(n.page, pages.length - 1) };
    });
    if (text === "") return null;
    const under = base.checkpoint;
    // The undo puts the page back where it was, unless a checkpoint emptied
    // the notepad meanwhile — then there is nothing to put it back into.
    return () =>
      write((n) => {
        if (n.checkpoint !== under) return n;
        if (only && n.pages.length === 1 && n.pages[0] === "") return { ...n, pages: [text], page: 0 };
        if (n.pages.length >= MAX_PAGES) return n;
        const at = Math.min(index, n.pages.length);
        return { ...n, pages: [...n.pages.slice(0, at), text, ...n.pages.slice(at)], page: at };
      });
  }, [notes, checkpoint, write]);

  return { pages: notes.pages, page: notes.page, saveFailed, setText, newPage, go, deletePage };
}
