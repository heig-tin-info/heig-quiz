/**
 * The two codes a student types by hand, and the one thing that tells them
 * apart: their length (ADR-045).
 *
 * - A poll's session code (ADR-014 §2, F-LIVE-13, F-AUTH-05) is read off a
 *   projector and typed on a phone: short, and alive for a lecture.
 * - A classroom's join code (F-ORG-06) is printed on a handout and kept for
 *   a semester: long enough that guessing one is out of reach.
 *
 * The student's single "Enter a code" field dispatches on the length alone,
 * client-side, so the two must never be the same: a poll code is never
 * `JOIN_CODE_LENGTH` long and a join code never `POLL_CODE_LENGTH`. Both
 * server generators draw exactly these lengths.
 */
export const POLL_CODE_LENGTH = 6;
export const JOIN_CODE_LENGTH = 8;
