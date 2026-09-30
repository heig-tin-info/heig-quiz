/**
 * The French (and English) half of the question-type components.
 *
 * A `qt-*` package ships a complete ENGLISH dictionary and accepts a typed
 * partial override (`StringOverrides`, deviation W2-3): it cannot import
 * `apps/web`, and `apps/web` owns the translations (N-I18N-01). Every string
 * a student reads inside a question comes from `i18n/` through here.
 *
 * The dictionaries themselves are built ONCE, in `questionTypes.tsx`, under
 * the key-by-key test of `questionTypes.test.tsx`: a second copy here once
 * drifted and left the negative-marking notice of `mcq` in English.
 */
import type { TFunction } from "../i18n";
import { playerStrings } from "../questionTypes";

/** The dictionary a given type's player expects, or `undefined` for an unknown one. */
export function playerStringsFor(type: string, t: TFunction): unknown {
  return Object.hasOwn(playerStrings, type)
    ? playerStrings[type as keyof typeof playerStrings](t)
    : undefined;
}
