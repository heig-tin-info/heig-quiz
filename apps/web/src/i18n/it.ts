import type { Dict } from "./en";
import { account } from "./it/account";
import { admin } from "./it/admin";
import { assist } from "./it/assist";
import { common } from "./it/common";
import { course } from "./it/course";
import { discover } from "./it/discover";
import { drill } from "./it/drill";
import { evaluation } from "./it/evaluation";
import { gradebook } from "./it/gradebook";
import { grading } from "./it/grading";
import { journal } from "./it/journal";
import { live } from "./it/live";
import { pool } from "./it/pool";
import { project } from "./it/project";
import { qt } from "./it/qt";
import { question } from "./it/question";
import { shell } from "./it/shell";
import { student } from "./it/student";

/**
 * The Italian dictionary, a translated language (ADR-140 §2): machine-drafted
 * from the English, each value stamped in `it.status.json` with the English
 * it was drafted from (§7, `i18n/status.test.ts`). Typed
 * `Record<keyof Dict, string>` like `fr.ts`: a key missing here, or one
 * English no longer has, is a compile error.
 *
 * Drafted, not yet selectable: the app does not import this file (its tests
 * do). Italian becomes selectable when it joins `LOCALES` (`@quiz/domain`)
 * and its loader joins `index.tsx`.
 */
export const it: Record<keyof Dict, string> = {
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
