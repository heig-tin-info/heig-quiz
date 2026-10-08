import { z } from "zod";

import { ASSIST_LOCALES, ASSIST_MAX_MESSAGE_CHARS, type AssistEntityKind } from "@quiz/domain";

/**
 * The teacher assistant (ADR-080, F-LLM-07), under `/app/api/assist`:
 * teacher and administrator portal sessions only.
 */

/**
 * The ids of what is on the screen (ADR-080 P2 amendment, item 3), from the
 * CLOSED list of kinds `ASSIST_ENTITY_KINDS`: `strict`, so a `student`, a
 * `user`, an `enrollment` or an `attempt` is refused, never ignored.
 */
export const AssistEntities = z
  .object({
    course: z.uuid().optional(),
    classroom: z.uuid().optional(),
    pool: z.uuid().optional(),
    question: z.uuid().optional(),
    evaluation: z.uuid().optional(),
    template: z.uuid().optional(),
  } satisfies Record<AssistEntityKind, z.ZodOptional<z.ZodUUID>>)
  .strict();
export type AssistEntities = z.infer<typeof AssistEntities>;

/**
 * Where the teacher stands (ADR-080 §2, amended for P2): the route
 * PATTERN, every id a `:param` (`/pools/:id`, `/admin?tab=llm`), the
 * screen's help topic, the UI language, and the ids of the entities on
 * the screen from the closed list above. The pattern admits literal
 * lower-case segments and parameters only, so a title or a name cannot
 * ride along; the stored exchange keeps the pattern, never the ids.
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
    entities: AssistEntities.optional(),
  })
  .strict();
export type AssistContext = z.infer<typeof AssistContext>;

/** The context as an exchange stores it (`assist_exchanges.context`): the screen, never an id. */
export const assistScreenOf = ({ route, helpTopic, locale }: AssistContext) => ({ route, helpTopic, locale });

/** `POST /app/api/assist/ask`: a question, in a conversation of the asker's or in a new one. */
export const AssistAsk = z
  .object({
    conversationId: z.uuid().optional(),
    message: z.string().trim().min(1).max(ASSIST_MAX_MESSAGE_CHARS),
    context: AssistContext,
  })
  .strict();
export type AssistAsk = z.infer<typeof AssistAsk>;

/** One question and its answer (Markdown), written together once the answer came. */
export const AssistExchange = z.object({
  id: z.uuid(),
  question: z.string(),
  answer: z.string(),
  createdAt: z.iso.datetime(),
});
export type AssistExchange = z.infer<typeof AssistExchange>;

/** The answer to a question: the conversation it went into, and the exchange. */
export const AssistReply = z.object({
  conversationId: z.uuid(),
  exchange: AssistExchange,
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
  exchanges: z.array(AssistExchange),
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
