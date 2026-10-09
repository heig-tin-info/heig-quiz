/**
 * The changelog's texts (ADR-087), as the build bundled them from
 * `changes/<slug>.md` into `dist/changelog.json` (`scripts/changelog.mjs`,
 * which also checks them against `ChangelogSource`). Read once per process.
 * No bundle — a development server never built, or a test — is an empty
 * changelog. An unreadable one is an empty changelog too: the first call
 * (the boot's sync, whose `step` logs it) throws once, every later call
 * serves nothing rather than a 500.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ChangelogSource } from "@quiz/contracts";

/** `apps/api/dist/changelog.json`, from `src/modules/changelog` or `dist/modules/changelog` alike. */
const BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/changelog.json");

let bundled: ChangelogSource[] | undefined;

export function bundledChangelog(): ChangelogSource[] {
  if (bundled) return bundled;
  bundled = [];
  if (existsSync(BUNDLE)) {
    try {
      bundled = ChangelogSource.array().parse(JSON.parse(readFileSync(BUNDLE, "utf8")));
    } catch (cause) {
      throw new Error(`changelog: ${BUNDLE} is unreadable; serving no entry`, { cause });
    }
  }
  return bundled;
}
