/**
 * Section 11 — the teacher assistant (ADR-080): the development stub's
 * answer, so the button and the panel can be looked at without a server.
 * One stored conversation, to show the history; a question opens a new one
 * or continues the one it names. A student is refused, as by the server.
 */
import type { AssistContext, AssistConversation, AssistMessage } from "@quiz/contracts";
import { buildCorpus, stubAnswer } from "@quiz/domain";

import { iso, MockError, on, role, H } from "./runtime";

const conversations: AssistConversation[] = [
  {
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    createdAt: iso(-26 * H),
    updatedAt: iso(-26 * H),
    messages: [
      { id: "a1b2c3d4-0000-4000-8000-0000000000a1", role: "user", content: "Comment partager une banque avec un collègue ?", createdAt: iso(-26 * H) },
      {
        id: "a1b2c3d4-0000-4000-8000-0000000000a2",
        role: "assistant",
        content:
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
 * The stub's answer, the server's own (`stubAnswer` of `@quiz/domain`) over
 * a one-page corpus, so its wording never drifts from the API's.
 */
const CORPUS = buildCorpus([
  { id: "guide/pools", locale: "en", text: "# Question pools\n\n## Sharing a pool\n\nShare a pool with a colleague." },
]);

on("GET", "/app/api/assist/availability", () => {
  teacherOnly();
  return { available: true, stub: true };
});
on("GET", "/app/api/assist/conversations", () => {
  teacherOnly();
  return conversations
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((c) => ({ id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, preview: c.messages[0]?.content ?? "" }));
});
on("GET", "/app/api/assist/conversations/:id", (m) => {
  teacherOnly();
  const found = conversations.find((c) => c.id === m.groups!.id);
  if (!found) throw new MockError(404, "not_found");
  return found;
});
on("DELETE", "/app/api/assist/conversations/:id", (m) => {
  const at = conversations.findIndex((c) => c.id === m.groups!.id);
  if (at < 0) throw new MockError(404, "not_found");
  conversations.splice(at, 1);
  return undefined;
});
on("POST", "/app/api/assist/ask", (_m, body) => {
  teacherOnly();
  const context = body.context as AssistContext;
  const now = iso(0);
  let conversation = conversations.find((c) => c.id === body.conversationId);
  if (body.conversationId && !conversation) throw new MockError(404, "not_found");
  if (!conversation) {
    conversation = { id: uuid(), createdAt: now, updatedAt: now, messages: [] };
    conversations.push(conversation);
  }
  const question: AssistMessage = { id: uuid(), role: "user", content: String(body.message), createdAt: now };
  const answer: AssistMessage = { id: uuid(), role: "assistant", content: stubAnswer(CORPUS, "teacher", String(body.message), context), createdAt: now };
  conversation.messages.push(question, answer);
  conversation.updatedAt = now;
  return { conversationId: conversation.id, question, answer };
});
