/**
 * The translator of the mounted `I18nProvider`, for the one caller outside
 * React that needs the reader's language: `apiErrorMessage`, which words the
 * refusals it knows by their code rather than print the server's English
 * (N-I18N-01). A leaf module, so `api.ts` does not import the provider, which
 * imports `api.ts`. English until the provider mounts.
 */
import { type Dict, en } from "./en";

let current: (key: keyof Dict) => string = (key) => en[key];

export const translateNow = (key: keyof Dict): string => current(key);

/** Called by the provider whenever its language changes. */
export function setTranslator(t: (key: keyof Dict) => string): void {
  current = t;
}
