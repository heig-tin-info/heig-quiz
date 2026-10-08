/**
 * Section 11 — the teacher assistant (ADR-080): the development stub's
 * answer, so the button and the panel can be looked at without a server.
 * One stored conversation, to show the history; a question opens a new one
 * or continues the one it names. A student is refused, as by the server. The
 * stub's results path (ADR-080 P2) reads the mock gradebook; its "show me
 * the pool …" (P2b) opens one of the mock's pools; in the question editor,
 * "rewrite …" proposes the statement tidied, and on a pool, "create the
 * category «…»" prepares it behind a confirmation card (P3).
 */
import type { AssistAction, AssistContext, AssistConversation, AssistEditorDraft, AssistExchange } from "@quiz/contracts";
import {
  assistResults,
  assistTextFields,
  buildCorpus,
  DEFAULT_ASSIST_TEXT,
  proposeQuestionEdit,
  STUB_TEXT,
  stubTurn,
  type AssistEditInput,
} from "@quiz/domain";

import { staffGradebookOf } from "./gradebook";
import { pools } from "./pool";
import { H, iso, MockError, on, role } from "./runtime";

const conversations: AssistConversation[] = [
  {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    createdAt: iso(-26 * H),
    updatedAt: iso(-26 * H),
    exchanges: [
      {
        id: "a1b2c3d4-0000-4000-8000-0000000000a1",
        question: "Comment partager une banque avec un collègue ?",
        answer:
          "Ouvrez la banque, puis **Partager** dans son en-tête :\n\n1. Saisissez l'adresse du collègue.\n2. Choisissez son rôle : **Lecteur**, **Contributeur** ou **Propriétaire**.\n3. Confirmez.",
        createdAt: iso(-26 * H),
      },
    ],
  },
];

let seq = 100;
const uuid = () => `a1b2c3d4-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;

const teacherOnly = () => {
  if (role === "student") throw new MockError(403, "forbidden");
};

/**
 * The stub's answer, the server's own (`stubReply` of `@quiz/domain`) over
 * a one-page corpus, so its wording never drifts from the API's.
 */
const CORPUS = buildCorpus([
  { id: "guide/pools", locale: "en", text: "# Question pools\n\n## Sharing a pool\n\nShare a pool with a colleague." },
]);

/**
 * The mock's results reader for the stub (`stubReply` of `@quiz/domain`,
 * the server's own): the classroom's staff gradebook, the mock's own route.
 * The mock's classroom ids are not uuids (`r1`), so the client sends no
 * classroom and the stub says to open one; a uuid would be read here.
 */
const readResults = (classroomId: string) => Promise.resolve().then(() => assistResults(staffGradebookOf(classroomId)));

on("GET", "/app/api/assist/availability", () => {
  teacherOnly();
  return { available: true, stub: true };
});
on("GET", "/app/api/assist/conversations", () => {
  teacherOnly();
  return conversations
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => ({ id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, preview: c.exchanges[0]?.question ?? "" }));
});
on("GET", "/app/api/assist/conversations/:id", (m) => {
  teacherOnly();
  const found = conversations.find((c) => c.id === m.groups!.id);
  if (!found) throw new MockError(404, "conversation_not_found");
  return found;
});
on("DELETE", "/app/api/assist/conversations/:id", (m) => {
  const at = conversations.findIndex((c) => c.id === m.groups!.id);
  if (at < 0) throw new MockError(404, "conversation_not_found");
  conversations.splice(at, 1);
  return undefined;
});
on("POST", "/app/api/assist/ask", async (_m, body) => {
  teacherOnly();
  const now = iso(0);
  const named = conversations.find((c) => c.id === body.conversationId);
  if (body.conversationId && !named) throw new MockError(404, "conversation_not_found");
  const conversation = named ?? { id: uuid(), createdAt: now, updatedAt: now, exchanges: [] };
  if (!named) conversations.push(conversation);
  const question = String(body.message);
  const context = body.context as AssistContext;
  const editor = body.editor as AssistEditorDraft | undefined;
  // The mock's ids are not uuids, so the client names no entity: the open pool is the mock's first.
  const screen = {
    ...context,
    ...(context.route === "/pools/:id" ? { entities: { pool: pools[0]!.id } } : {}),
    ...(editor ? { editor: { texts: assistTextFields(editor.config, DEFAULT_ASSIST_TEXT), explanation: editor.explanation } } : {}),
  };
  // ADR-080 P2b: "show me the pool …" opens it, as the server's stub does; P3: its calls, as the server runs them.
  const turn = await stubTurn(CORPUS, "teacher", question, screen, {
    results: readResults,
    pools: () => Promise.resolve(pools),
  });
  let text = turn.text;
  const actions: AssistAction[] = [...turn.actions];
  try {
    for (const call of turn.calls ?? []) actions.push(mockCall(call, editor));
  } catch (error) {
    text = `${STUB_TEXT[context.locale].intro}\n\n${STUB_TEXT[context.locale].refused} ${(error as Error).message}`;
  }
  const exchange: AssistExchange = { id: uuid(), question, answer: text, createdAt: now };
  conversation.exchanges.push(exchange);
  conversation.updatedAt = now;
  return { conversationId: conversation.id, exchange, actions };
});

/** The mock's run of a stub call (ADR-080 P3): an editor proposal, or a prepared category. */
function mockCall(call: { tool: string; input: unknown }, editor: AssistEditorDraft | undefined): AssistAction {
  if (call.tool === "propose_question_edit" && editor) {
    const base = { config: editor.config, explanation: editor.explanation };
    return proposeQuestionEdit(editor.questionId, base, DEFAULT_ASSIST_TEXT, call.input as AssistEditInput);
  }
  const { poolId, name } = call.input as { poolId: string; name: string };
  const pool = pools.find((p) => p.id === poolId);
  const id = uuid();
  prepared.add(id);
  return {
    kind: "pending_write",
    id,
    tool: "create_category",
    lines: [
      { field: "pool", values: [pool?.name ?? poolId] },
      { field: "name", values: [name] },
    ],
    expiresAt: iso(10 * 60_000),
  };
}

/** The mock's prepared writes: confirmed or cancelled once. */
const prepared = new Set<string>();
on("POST", "/app/api/assist/writes/:id/confirm", (m) => {
  teacherOnly();
  if (!prepared.delete(m.groups!.id!)) throw new MockError(404, "write_not_found");
  return { path: `/pools/${pools[0]!.id}/categories` };
});
on("POST", "/app/api/assist/writes/:id/cancel", (m) => {
  prepared.delete(m.groups!.id!);
  return undefined;
});
