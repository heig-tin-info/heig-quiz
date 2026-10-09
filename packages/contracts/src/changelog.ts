/**
 * What's new on the platform (ADR-087): the entries of `changes/<slug>.md`,
 * bundled at the API's build, each dated by the first boot that served it.
 *
 * `GET /app/api/changelog` (every entry the reader may see, newest first) and
 * `GET /app/api/changelog/unseen` (those live since the reader's last
 * acknowledgement) answer a {@link ChangelogList}; `POST
 * /app/api/me/changelog` acknowledges them, with no body. A student is sent
 * the `student` entries only, staff both audiences. The unseen list and the
 * acknowledgement are the account's own portal session's only.
 */
import { z } from "zod";

/** Who sees an entry. The files' third audience, `none`, never leaves the build. */
export const ChangelogAudience = z.enum(["student", "teacher"]);
export type ChangelogAudience = z.infer<typeof ChangelogAudience>;

export const ChangelogKind = z.enum(["new", "changed", "moved", "deprecated", "removed"]);
export type ChangelogKind = z.infer<typeof ChangelogKind>;

/** One entry as the bundle holds it (`apps/api/dist/changelog.json`). */
export const ChangelogSource = z.object({
  id: z.string(),
  audience: ChangelogAudience,
  kind: ChangelogKind,
  en: z.string(),
  fr: z.string(),
});
export type ChangelogSource = z.infer<typeof ChangelogSource>;

/**
 * One entry as a reader gets it. `text` is bilingual content, picked by the
 * reader's locale (ADR-087, N-I18N-03); `liveAt` and `commitSha` label its
 * release: the first boot that served it, and that boot's commit (null when
 * the build carried none).
 */
export const ChangelogEntry = z.object({
  id: z.string(),
  kind: ChangelogKind,
  text: z.object({ en: z.string(), fr: z.string() }),
  liveAt: z.string(),
  commitSha: z.string().nullable(),
});
export type ChangelogEntry = z.infer<typeof ChangelogEntry>;

export const ChangelogList = z.array(ChangelogEntry);
export type ChangelogList = z.infer<typeof ChangelogList>;
