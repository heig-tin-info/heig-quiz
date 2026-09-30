/**
 * The name "Create a journal" proposes for a classroom's repository
 * (F-JRN-02), built on the generic repository naming of `@quiz/domain`
 * (ported from heig-classroom's `repoName.ts`).
 */
import { repoName, slugify } from "@quiz/domain";

/**
 * `<classroom-slug>-journal`. The discriminating part comes first, like every
 * other repository the platform creates, so the repositories of one classroom
 * sort together in the organization's listing; `disambiguator` is appended
 * when the name is taken (creation never adopts an existing repository).
 *
 * The name records where the journal was CREATED, not who reads it: a
 * repository another classroom later uses keeps it. That is why the creation
 * form offers it as a proposal the teacher may rewrite — someone who knows
 * the journal will outlive one cohort calls it `prog-c-journal`.
 */
export function journalRepoName(classroomName: string, disambiguator?: string): string {
  return repoName(`${slugify(classroomName) || "classroom"}-journal`, disambiguator);
}
