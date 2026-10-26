import { useState } from "react";

/**
 * The wands of one editor (ADR-059): one request at a time, keyed by the
 * part it writes (an MCQ row, an essay criterion). The host words a failure
 * (`EditorProps.onGenerateItem`, `onGenerateTarget`), so a wand only stops
 * waiting. Every wand of the editor is disabled while `running` is not null.
 */
export function useWandRunner<K>(): { running: K | null; run: (key: K, ask: () => Promise<void>) => void } {
  const [running, setRunning] = useState<K | null>(null);
  const run = (key: K, ask: () => Promise<void>) => {
    setRunning(key);
    ask()
      .catch(() => undefined)
      .finally(() => setRunning(null));
  };
  return { running, run };
}
