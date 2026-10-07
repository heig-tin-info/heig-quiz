import { z } from "zod";

import { ASSIST_LOCALES, ASSIST_MAX_MESSAGE_CHARS } from "@quiz/domain";

/**
 * The teacher assistant (ADR-080, F-LLM-07), under `/app/api/assist`:
 * teacher and administrator portal sessions only.
 */

/**
 * Where the teacher stands, and nothing else (ADR-080 §2): the route
 * PATTERN, every id a `:param` (`/pools/:id`, `/admin?tab=llm`), the
 * screen's help topic and the UI language. The pattern admits literal
 * lower-case segments and parameters only, so an id, a title or a name
 * cannot ride along.
 */
export const AssistContext = z
  .object({
    route: z
      .string()
      .max(200)
      .regex(/^\/(?:(?:[a-z][a-z-]*|:[a-zA-Z]+)(?:\/(?:[a-z][a-z-]*|:[a-zA-Z]+))*)?(?:\?tab=[a-z-]+)?$/),
    helpTopic: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,59}$/)
      .nullable(),
    locale: z.enum(ASSIST_LOCALES),
  })
  .strict();
export type AssistContext = z.infer<typeof AssistContext>;

/** `POST /app/api/assist/ask`: a question, in a conversation of the asker's or in a new one. */
export const AssistAsk = z
  .object({
    conversationId: z.uuid().optional(),
    message: z.string().trim().min(1).max(ASSIST_MAX_MESSAGE_CHARS),
    context: AssistContext,
  })
  .strict();
export type AssistAsk = z.infer<typeof AssistAsk>;

export const AssistMessage = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  /** Markdown for the assistant's, as typed for the user's. */
  content: z.string(),
  createdAt: z.iso.datetime(),
});
export type AssistMessage = z.infer<typeof AssistMessage>;

/** The answer to a question: the conversation it went into, and the assistant's message. */
export const AssistReply = z.object({
  conversationId: z.uuid(),
  question: AssistMessage,
  answer: AssistMessage,
});
export type AssistReply = z.infer<typeof AssistReply>;

/** `GET /app/api/assist/conversations`: the asker's own, newest first; the preview is the first question. */
export const AssistConversationSummary = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  preview: z.string(),
});
export type AssistConversationSummary = z.infer<typeof AssistConversationSummary>;

/** `GET /app/api/assist/conversations/:id`: the owner's, or any for an administrator (audited). */
export const AssistConversation = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(AssistMessage),
});
export type AssistConversation = z.infer<typeof AssistConversation>;

/** `GET /app/api/assist/conversations` query: `userId` is an administrator's, to read another person's list. */
export const AssistListQuery = z.object({ userId: z.uuid().optional() }).strict();

/**
 * `GET /app/api/assist/availability`: whether the assistant can answer now
 * — a model, or the development stub — and whether it is the stub.
 */
export const AssistAvailability = z.object({
  available: z.boolean(),
  stub: z.boolean(),
});
export type AssistAvailability = z.infer<typeof AssistAvailability>;
