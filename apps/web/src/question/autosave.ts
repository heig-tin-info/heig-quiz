import { useCallback, useEffect, useRef, useState } from "react";

import type { SyncState } from "../ui";

/**
 * Draft autosave (F-QST-02): 500 ms after the last change, one request in
 * flight at a time, and a visible state.
 *
 * Two rules make it trustworthy rather than merely automatic:
 *
 * - **single flight**. While a `PUT /draft` is on the wire, further edits
 *   only mark the draft dirty; the next request leaves when the first comes
 *   back, carrying the LATEST value. Two overlapping saves would let the
 *   slower one land last and resurrect an older config.
 * - **a failure is not silence**. The badge turns `offline` and the value
 *   stays dirty, so the next change — or `Ctrl+S` — tries again.
 *
 * The hook owns no value: it watches one, which the editor holds.
 */
export const AUTOSAVE_DELAY_MS = 500;

export interface Autosave {
  /** What `SyncBadge` shows: saved / saving / offline. */
  state: SyncState;
  /** `Ctrl+S`: sends what is pending now instead of waiting for the delay. */
  flush: () => void;
  /** True while something is typed but not yet acknowledged. */
  dirty: boolean;
}

/** What the owner of the watched value gets on top of what the header shows. */
export interface AutosaveControl<T> extends Autosave {
  /**
   * "This value came FROM the server": call it with the very reference about
   * to be handed back as `value`, and that change is not saved. A draft the
   * server sent is already stored; writing it back is not an edit — it only
   * moves the draft's `updatedAt` past the publication and makes a question
   * published a second ago show "unpublished changes" (#72, #74).
   */
  adopt: (value: T) => void;
}

export function useAutosave<T>({
  value,
  save,
  delay = AUTOSAVE_DELAY_MS,
  enabled = true,
}: {
  /** The draft. A new reference means "the teacher changed something". */
  value: T;
  save: (value: T) => Promise<unknown>;
  delay?: number;
  /** False while the question is still loading, or read-only. */
  enabled?: boolean;
}): AutosaveControl<T> {
  const [state, setState] = useState<SyncState>("saved");
  const [dirty, setDirty] = useState(false);
  const latest = useRef(value);
  const pending = useRef(false);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  // Refs, not dependencies: the effect below must fire on a value change and
  // on nothing else, or a new `save` closure would restart the debounce.
  saveRef.current = save;
  latest.current = value;

  const run = useCallback(() => {
    if (!pending.current || inFlight.current) return;
    pending.current = false;
    inFlight.current = true;
    setState("saving");
    void saveRef.current(latest.current).then(
      () => {
        inFlight.current = false;
        if (pending.current) run();
        else {
          setDirty(false);
          setState("saved");
        }
      },
      () => {
        inFlight.current = false;
        // Still dirty: the value was never acknowledged, so the next edit or
        // Ctrl+S sends it again rather than losing it.
        pending.current = true;
        setState("offline");
      },
    );
  }, []);

  // The last value the server handed over (`adopt`): matched by reference.
  const adopted = useRef<{ value: T } | null>(null);
  const adopt = useCallback((next: T) => {
    adopted.current = { value: next };
  }, []);

  const first = useRef(true);
  useEffect(() => {
    // Nothing is watched until the editor has a draft to watch: the values
    // seen while `enabled` is false are placeholders, and the first one after
    // it flips is what the SERVER sent. Saving that back would write a draft
    // nobody edited and would show "saving" on a freshly opened question.
    if (!enabled) return;
    if (first.current) {
      first.current = false;
      return;
    }
    if (adopted.current !== null && adopted.current.value === value) {
      adopted.current = null;
      return;
    }
    pending.current = true;
    setDirty(true);
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      run();
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay, enabled, run]);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    run();
  }, [run]);

  return { state, flush, dirty, adopt };
}
