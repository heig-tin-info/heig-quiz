import { z } from "zod";

import {
  ASSIST_COMMAND_ID,
  ASSIST_WRITE_FIELDS,
  ASSIST_WRITE_TOOLS,
  ASSIST_LOCALES,
  ASSIST_MAX_MESSAGE_CHARS,
  ASSIST_MAX_SCREEN_COMMANDS,
  type AssistAction as DomainAssistAction,
  type AssistScreenCommand as DomainAssistScreenCommand,
  type AssistEntityKind,
} from "@quiz/domain";
import { ASSIST_TEXT_LABELS } from "@quiz/core/generate";

/** `true` when `A` and `B` are the same shape, `false` otherwise. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

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
    /** It needs the teacher's own click (a new tab): offered as a button (ADR-080 P3, decision 10). */
    gesture: z.boolean().optional(),
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

/** The longest editor draft a question may carry, as JSON. */
export const ASSIST_MAX_EDITOR_CHARS = 200_000;

/**
 * The question editor's open draft (ADR-080 P3, decision 2): its config and
 * its explanation, the teacher's own text, sent with a question asked from
 * the editor ONLY — the server refuses it on any other screen. Never stored.
 */
export const AssistEditorDraft = z
  .object({
    questionId: z.uuid(),
    config: z.unknown(),
    explanation: z.string().max(20_000),
  })
  .strict()
  .refine((d) => JSON.stringify(d.config ?? null).length <= ASSIST_MAX_EDITOR_CHARS, { message: "draft_too_large" });
export type AssistEditorDraft = z.infer<typeof AssistEditorDraft>;

/** `POST /app/api/assist/ask`: a question, in a conversation of the asker's or in a new one. */
export const AssistAsk = z
  .object({
    conversationId: z.uuid().optional(),
    message: z.string().trim().min(1).max(ASSIST_MAX_MESSAGE_CHARS),
    context: AssistContext,
    editor: AssistEditorDraft.optional(),
  })
  .strict()
  // ADR-080 P3, decision 2: the draft rides with a question asked from that very question's editor, never another screen.
  .superRefine((ask, ctx) => {
    if (!ask.editor) return;
    if (ask.context.route === "/questions/:id" && ask.context.entities?.question === ask.editor.questionId) return;
    ctx.addIssue({ code: "custom", path: ["editor"], message: "editor_off_screen" });
  });
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
  // ADR-080 P3: a write command of the screen, run by the browser on the teacher's Confirm only.
  z.object({ kind: z.literal("confirm_command"), id: z.string().regex(ASSIST_COMMAND_ID), label: z.string() }),
  // ADR-080 P3: an editor proposal, applied by the teacher to the draft it was computed against.
  z.object({
    kind: z.literal("edit_question"),
    questionId: z.uuid(),
    base: z.object({ config: z.unknown(), explanation: z.string() }),
    config: z.unknown(),
    explanation: z.string(),
    fields: z.array(
      z.object({
        path: z.string(),
        label: z.enum([...ASSIST_TEXT_LABELS, "explanation"]),
        n: z.number().int().min(1).nullable(),
        before: z.string().nullable(),
        after: z.string(),
      }),
    ),
  }),
  // ADR-080 P3: a write frozen on the server, run only on the teacher's Confirm.
  z.object({
    kind: z.literal("pending_write"),
    id: z.uuid(),
    tool: z.enum(ASSIST_WRITE_TOOLS),
    lines: z.array(z.object({ field: z.enum(ASSIST_WRITE_FIELDS), values: z.array(z.string()) })),
    expiresAt: z.iso.datetime(),
  }),
]);
export type AssistAction = z.infer<typeof AssistAction>;
// The domain's actions and commands (`AssistUiTurn`) are this contract's: a drift is a compile error.
true satisfies Same<AssistAction, DomainAssistAction>;
true satisfies Same<AssistScreenCommand, DomainAssistScreenCommand>;

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

/**
 * `POST /app/api/assist/writes/:id/confirm` and `…/cancel` (ADR-080 P3,
 * decision 7): the conversation the write was prepared in — a pending write
 * is its teacher's and its conversation's alone.
 */
export const AssistWriteDecision = z.object({ conversationId: z.uuid() }).strict();
export type AssistWriteDecision = z.infer<typeof AssistWriteDecision>;

/**
 * Why a confirmed write was not done (`422 write_failed`), a code the browser
 * words in the UI language: what it concerns is not on the teacher's seats or
 * is gone, the platform refused it (a role), its frozen arguments no longer
 * hold, or anything else.
 */
export const AssistWriteFailure = z.enum(["not_found", "refused", "invalid", "failed"]);
export type AssistWriteFailure = z.infer<typeof AssistWriteFailure>;
export const AssistWriteFailed = z.object({ error: z.literal("write_failed"), reason: AssistWriteFailure });
export type AssistWriteFailed = z.infer<typeof AssistWriteFailed>;

/** A confirmed write, done: the app's path of what it made or changed, for the card's link. */
export const AssistWriteDone = z.object({ path: z.string().regex(/^\/[a-z0-9/-]*$/) });
export type AssistWriteDone = z.infer<typeof AssistWriteDone>;

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
