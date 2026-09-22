/**
 * Undo / redo for a CONTROLLED editor.
 *
 * The editor does not own the schematic — the host does — so the history is a
 * stack of previous VALUES, and undoing is just `onChange(previous)`. That
 * keeps one source of truth: there is no internal copy that could drift from
 * what the host stored, and a value the host pushes in from outside simply
 * becomes the next thing that lands on the stack.
 */
import { useCallback, useRef, useState } from "react";

/** Two hundred steps is about a session of drawing; beyond that the oldest go. */
const LIMIT = 200;

export interface History<T> {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Records `previous` as an undo step and clears the redo stack. */
  push: (previous: T) => void;
  /**
   * Pops one step. `current` goes on the redo stack; the value to hand back to
   * the host is returned, or `undefined` when there is nothing to undo.
   */
  undo: (current: T) => T | undefined;
  redo: (current: T) => T | undefined;
  clear: () => void;
}

export function useHistory<T>(): History<T> {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  /* The stacks are refs so a push during a pointer drag does not re-render;
     this counter is the one bit of state the toolbar's disabled flags read. */
  const [, bump] = useState(0);

  const push = useCallback((previous: T) => {
    past.current.push(previous);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
  }, []);

  const undo = useCallback((current: T): T | undefined => {
    const previous = past.current.pop();
    if (previous === undefined) return undefined;
    future.current.push(current);
    bump((n) => n + 1);
    return previous;
  }, []);

  const redo = useCallback((current: T): T | undefined => {
    const next = future.current.pop();
    if (next === undefined) return undefined;
    past.current.push(current);
    bump((n) => n + 1);
    return next;
  }, []);

  const clear = useCallback(() => {
    past.current = [];
    future.current = [];
    bump((n) => n + 1);
  }, []);

  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    push,
    undo,
    redo,
    clear,
  };
}
