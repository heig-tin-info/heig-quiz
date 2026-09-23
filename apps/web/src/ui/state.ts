import { useCallback, useState } from "react";

// --- Remembered choices (a viewer's habit, never a state of the data) ---

/**
 * Reading storage may throw — a private window, blocked site data — and a
 * remembered habit is never worth a crash: `null` is "nothing stored".
 */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writing may throw for the same reasons, and a quota; losing a habit costs one click. */
export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A remembered habit is a convenience, never a requirement.
  }
}

/**
 * A choice the reader makes once and expects to find again — table or cards,
 * the grouping of a list, the classroom of the last poll — remembered per
 * browser in `localStorage` under `key`.
 *
 * `values` says what a stored string may be: the closed list of choices, or a
 * predicate when the set is open (an id). Anything else, nothing stored, or a
 * storage that refuses to be read gives `fallback`. The setter writes then
 * updates, and a storage that refuses the write still updates the screen.
 */
export function usePersistentChoice<T extends string>(
  key: string,
  values: readonly T[] | ((raw: string) => raw is T),
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readStored(key);
    if (raw === null) return fallback;
    const accepted =
      typeof values === "function" ? values(raw) : (values as readonly string[]).includes(raw);
    return accepted ? (raw as T) : fallback;
  });
  const set = useCallback(
    (next: T) => {
      writeStored(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, set];
}
