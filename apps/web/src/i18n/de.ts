import type { Dict } from "./en";
import { account } from "./de/account";
import { admin } from "./de/admin";
import { assist } from "./de/assist";
import { common } from "./de/common";
import { course } from "./de/course";
import { discover } from "./de/discover";
import { drill } from "./de/drill";
import { evaluation } from "./de/evaluation";
import { gradebook } from "./de/gradebook";
import { grading } from "./de/grading";
import { journal } from "./de/journal";
import { live } from "./de/live";
import { pool } from "./de/pool";
import { project } from "./de/project";
import { qt } from "./de/qt";
import { question } from "./de/question";
import { shell } from "./de/shell";
import { student } from "./de/student";

/**
 * The German dictionary, a translated language (ADR-140 §2): machine-drafted
 * from the English, each value stamped in `de.status.json` with the English
 * it was drafted from (§7, `i18n/status.test.ts`). Typed
 * `Record<keyof Dict, string>` like `fr.ts`: a key missing here, or one
 * English no longer has, is a compile error.
 *
 * Drafted, not yet selectable: the app does not import this file (its tests
 * do). German becomes
 * selectable in the pull request that adds it to `LOCALES`
 * (`@quiz/domain`) and its loader to `index.tsx`.
 */
export const de: Record<keyof Dict, string> = {
  ...common,
  ...shell,
  ...discover,
  ...account,
  ...admin,
  ...assist,
  ...course,
  ...student,
  ...evaluation,
  ...live,
  ...pool,
  ...question,
  ...qt,
  ...grading,
  ...gradebook,
  ...drill,
  ...project,
  ...journal,
};
