/**
 * The teacher assistant's writes (ADR-080, P3 amendment, decisions 4 and
 * 7): a write the model asks for is NOT executed. The server freezes its
 * arguments as a pending write of the teacher and the conversation, and the
 * panel shows a card the SERVER rendered from those arguments — never the
 * model's prose; the write runs, exactly as frozen and once, only when the
 * teacher confirms it. Pure vocabulary and bounds, no I/O.
 */

/**
 * The writes the assistant may prepare (decision 4), a CLOSED list.
 * `create_question` always creates a draft. Never `update_question` (a
 * question changes only in its own editor), `update_evaluation`,
 * `add_questions_to_evaluation`, `create_evaluation`, `instantiate_template`,
 * `create_pool`, `create_classroom`, `create_poll` nor `create_course`.
 */
export const ASSIST_WRITE_TOOLS = [
  "create_question",
  "create_category",
  "create_template",
  "add_questions_to_template",
  "link_pool_to_course",
] as const;
export type AssistWriteTool = (typeof ASSIST_WRITE_TOOLS)[number];

/** The lines a confirmation card may show, each labelled by the browser in the UI language. */
export const ASSIST_WRITE_FIELDS = [
  "course",
  "pool",
  "category",
  "parent",
  "template",
  "type",
  "name",
  "title",
  "mode",
  "statement",
  "questions",
  "access",
] as const;
export type AssistWriteField = (typeof ASSIST_WRITE_FIELDS)[number];

/** One line of a confirmation card: resolved by the server from the frozen arguments. */
export interface AssistWriteLine {
  field: AssistWriteField;
  /** One value, or several (the questions, the staff who gain access). */
  values: string[];
}

/** A prepared write, as the browser receives it (an `AssistAction`). */
export interface AssistPendingWrite {
  kind: "pending_write";
  /** The pending write's id: what Confirm and Cancel name. */
  id: string;
  tool: AssistWriteTool;
  lines: AssistWriteLine[];
  /** When the server forgets it unconfirmed. */
  expiresAt: string;
}

/** How long a prepared write waits for its confirmation (decision 7). */
export const ASSIST_PENDING_TTL_MS = 10 * 60_000;
/** The most writes one answer may prepare: each is a card the teacher confirms on its own. */
export const ASSIST_MAX_WRITES = 3;
/** The most characters of a statement a card shows. */
export const ASSIST_CARD_EXCERPT_CHARS = 300;

/** A statement cut for a card, on one line. */
export function cardExcerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ASSIST_CARD_EXCERPT_CHARS ? `${line.slice(0, ASSIST_CARD_EXCERPT_CHARS - 1).trimEnd()}…` : line;
}
