import { useConcepts } from "../concepts/useConcepts";
import type { Vocabulary } from "./filters";
import { parseSearch } from "./searchSyntax";

const NONE: Vocabulary = [];

/**
 * The vocabulary a search's concept words resolve against (`resolveFilters`),
 * fetched only once a word is typed, and kept by the shared concepts query
 * after that. `vocabulary` is `undefined` while it is not there, empty when
 * it could not be read (the words then filter nothing rather than the list
 * never loading); `waiting` says a typed word has no answer yet, so the
 * screen holds its question query rather than flash the unfiltered list.
 * `naming`: fetch it too, without holding anything, to name a ticked concept
 * the screen's own list lacks.
 */
export function useFilterVocabulary(q: string, naming = false): { vocabulary: Vocabulary; waiting: boolean } {
  const wanted = parseSearch(q).conceptWords.length > 0;
  const concepts = useConcepts(wanted || naming);
  const vocabulary = concepts.isError ? NONE : concepts.data?.concepts;
  return { vocabulary, waiting: wanted && vocabulary === undefined };
}
