/**
 * `readMath` as a hook: the editor echoes a key and the player echoes the
 * answer as it is typed. The review never reads — it says what the server
 * decided — so this file, which pulls the parser in, stays out of its chunk.
 */
import { useMemo } from "react";

import { readMath, type ReadOptions } from "@quiz/domain/math";

/** Memoised on the text and the options' content: a parse per keystroke, never per render. */
export function useMathReading(latex: string, options: ReadOptions) {
  const key = JSON.stringify([options.symbols, options.forbidden, options.maxLength]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `options`
  return useMemo(() => readMath(latex, options), [latex, key]);
}
