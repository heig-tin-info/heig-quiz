import { account } from "./en/account";
import { admin } from "./en/admin";
import { assist } from "./en/assist";
import { common } from "./en/common";
import { course } from "./en/course";
import { discover } from "./en/discover";
import { drill } from "./en/drill";
import { evaluation } from "./en/evaluation";
import { gradebook } from "./en/gradebook";
import { grading } from "./en/grading";
import { journal } from "./en/journal";
import { live } from "./en/live";
import { pool } from "./en/pool";
import { project } from "./en/project";
import { qt } from "./en/qt";
import { question } from "./en/question";
import { shell } from "./en/shell";
import { student } from "./en/student";

/**
 * The English dictionary: the reference locale and the fallback of every
 * other one. `Dict` is its type, so a key added in `en/` without its French
 * twin in `fr/` is a compile error (N-I18N-01). The keys live in one file
 * per domain, chosen by its first segment in `domains.ts`; this file only
 * joins them.
 */
export const en = {
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

export type Dict = typeof en;
