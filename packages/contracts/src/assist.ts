import { z } from "zod";

import {
  ASSIST_COMMAND_ID,
  ASSIST_LOCALES,
  ASSIST_MAX_MESSAGE_CHARS,
  ASSIST_MAX_SCREEN_COMMANDS,
  type AssistAction as DomainAssistAction,
  type AssistEntityKind,
} from "@quiz/domain";

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
 * One command of the screen on view (ADR-080 P2b): the palette's id, its
 * label — screen chrome, never an entity's name (`Command.effect`, web) —
 * and its effect. The model is offered the `none` ones only.
 */
export const AssistScreenCommand = z
  .object({
    id: z.string().regex(ASSIST_COMMAND_ID),
    label: z.string().min(1).max(120),
    effect: z.enum(["none", "write"]),
  })
  .strict();
export type AssistScreenCommand = z.infer<typeof AssistScreenCommand>;

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
    /** The screen's palette commands (ADR-080 P2b); never stored. */
    commands: z.array(AssistScreenCommand).max(ASSIST_MAX_SCREEN_COMMANDS).optional(),
  })
  .strict();
export type AssistContext = z.infer<typeof AssistContext>;

/** The context as an exchange stores it (`assist_exchanges.context`): the screen, never an id nor a command. */
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

/**
 * A UI action of an answer (ADR-080 P2b), checked by the server against
 * the screen catalogue (`checkOpenScreen`, `AssistUiTurn` of
 * `@quiz/domain`) and run by the browser: open one of the app's screens, or
 * run an effect-free command of the screen on view. Never stored.
 */
export const AssistAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("open_screen"),
    screen: z.string(),
    ids: z.record(z.string(), z.string()),
    params: z.record(z.string(), z.string()),
  }),
  z.object({ kind: z.literal("run_command"), id: z.string().regex(ASSIST_COMMAND_ID) }),
]);
export type AssistAction = z.infer<typeof AssistAction>;
// The domain's actions (`AssistUiTurn`) are this contract's: a drift is a compile error.
true satisfies [AssistAction] extends [DomainAssistAction] ? ([DomainAssistAction] extends [AssistAction] ? true : false) : false;

/**
 * The answer to a question: the conversation it went into, the exchange,
 * and the UI actions the browser runs after showing it (ADR-080 P2b).
 */
export const AssistReply = z.object({
  conversationId: z.uuid(),
  exchange: AssistExchange,
  actions: z.array(AssistAction),
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
