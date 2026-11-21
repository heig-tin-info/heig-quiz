import type { Dict } from "./en";
import { account } from "./fr/account";
import { admin } from "./fr/admin";
import { assist } from "./fr/assist";
import { common } from "./fr/common";
import { course } from "./fr/course";
import { discover } from "./fr/discover";
import { drill } from "./fr/drill";
import { evaluation } from "./fr/evaluation";
import { gradebook } from "./fr/gradebook";
import { grading } from "./fr/grading";
import { journal } from "./fr/journal";
import { live } from "./fr/live";
import { pool } from "./fr/pool";
import { project } from "./fr/project";
import { qt } from "./fr/qt";
import { question } from "./fr/question";
import { shell } from "./fr/shell";
import { student } from "./fr/student";

/**
 * The French dictionary. Typed `Record<keyof Dict, string>`: a key missing
 * here, or one English no longer has, is a compile error. Keep it that way.
 * Each file of `fr/` is typed by its twin of `en/`, so the error names the
 * file to fix. One lazy chunk, loaded by `index.tsx` as a whole.
 */
export const fr: Record<keyof Dict, string> = {
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
