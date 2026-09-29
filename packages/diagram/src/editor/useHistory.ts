/**
 * Undo / redo for a CONTROLLED editor, the circuit canvas's: the history is
 * a stack of previous VALUES, and undoing is handing one back to the host.
 * There is no internal copy that could drift from what the host stored.
 */
import { useCallback, useRef, useState } from "react";

const LIMIT = 200;

export interface History<T> {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  push: (previous: T) => void;
  undo: (current: T) => T | undefined;
  redo: (current: T) => T | undefined;
}

export function useHistory<T>(): History<T> {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
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
  return { canUndo: past.current.length > 0, canRedo: future.current.length > 0, push, undo, redo };
}

/** One focus of a field, one undo step: every field of the editor draws its session number here. */
let sessions = 0;
export const nextSession = (): number => (sessions += 1);
