import { useEffect, useState } from "react";

/** The pause after the last keystroke before a search is sent. */
const TYPING_MS = 250;

/** A value as typed, delayed: one request per pause, not one per letter. */
export function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), TYPING_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}
