/**
 * The teacher's message to the students (ADR-132 §10), one schema for every
 * place it travels: the sync's request, the student's project page, the
 * workspace portal's assignment. Here because `codespace.ts` is imported by
 * `project.ts`, so neither can own it.
 */
import { z } from "zod";

import { SYNC_MESSAGE_MAX } from "@quiz/domain";

/**
 * What a message to the students never holds: the C0 controls but tab and
 * line feed, DEL, the C1 controls, and the bidirectional overrides and
 * isolates — `CONTROL_CHAR` of `journal.ts`, widened —, and a lone surrogate
 * (its text is no valid JSON for the audit). A NUL would fail the
 * database's write after the distribution moved.
 */
// eslint-disable-next-line no-control-regex
const MESSAGE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\p{Cs}/u;

/**
 * Its text: plain, CRLF and CR made line feeds, trimmed, at most
 * {@link SYNC_MESSAGE_MAX} characters, none of {@link MESSAGE_CONTROL}.
 */
export const MessageText = z
  .string()
  // CRLF and CR are line feeds, before the cap and the check (an API client's text).
  .overwrite((text) => text.replace(/\r\n?/g, "\n"))
  .trim()
  .max(SYNC_MESSAGE_MAX)
  .refine((text) => !MESSAGE_CONTROL.test(text), "no control or direction character");

/** A sync's message as it is shown: its text and the instant of the sync that wrote it. */
export const SyncMessage = z.object({ text: MessageText, at: z.iso.datetime() });
export type SyncMessage = z.infer<typeof SyncMessage>;
