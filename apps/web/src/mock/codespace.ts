/**
 * 5d. The online workspace (ADR-047 as amended 2026-10-07, M6-06), scene
 * flag `?codespace=1` — without it the platform has no portal, and every
 * route below answers 404, as the API does with `CODESPACE_URL` empty.
 *
 * With it (and `?projects=1`): "Labo 2 — pointeurs" runs in the workspace,
 * already opened by three students (its mode frozen), synced two hours ago,
 * with four workspaces — one of an account the classroom does not hold;
 * "Labo 3 — listes chaînées" is a draft in the students' own tools whose
 * mode the persona may set (an owner with the grant; `?assistant=1` makes
 * them an assistant, refused). The student persona's open project runs in
 * the workspace, and the invited one under Safe Exam Browser
 * (`mock/student.ts`). The administration's teachers carry a grant.
 */
import {
  ProjectWorkModeBody,
  WORK_MODES,
  type ProjectWorkspace,
  type ProjectWorkspaceSessions,
  type ProjectWorkspaceSyncAccepted,
  type WorkMode,
} from "@quiz/contracts";
import { workModeRefusal } from "@quiz/domain";

import { classroomRoster } from "./org";
import { flags, H, iso, MockError, MockPayload, on, refuse } from "./runtime";

interface MockWorkspace {
  mode: WorkMode;
  launched: boolean;
  syncedAt: string | null;
  syncError: string | null;
}

const WORKSPACES = new Map<string, MockWorkspace>([
  ["pj-published", { mode: "online", launched: true, syncedAt: iso(-2 * H), syncError: null }],
]);


function workspaceOr404(id: string): MockWorkspace {
  if (!flags.codespace) throw new MockError(404, "Not found");
  let ws = WORKSPACES.get(id);
  if (!ws) {
    ws = { mode: "free", launched: false, syncedAt: null, syncError: null };
    WORKSPACES.set(id, ws);
  }
  return ws;
}

/** The project's workspace for the persona: an owner with the grant, unless `?assistant=1`. */
function view(ws: MockWorkspace): ProjectWorkspace {
  const facts = { owner: !flags.assistant, granted: true, launched: ws.launched, groupMode: false };
  const judged = WORK_MODES.map((to) => ({ to, refusal: workModeRefusal(facts, ws.mode, to) }));
  return {
    mode: ws.mode,
    allowed: judged.filter((j) => j.refusal === null).map((j) => j.to),
    refusal: judged.find((j) => j.refusal !== null)?.refusal ?? null,
    syncedAt: ws.syncedAt,
    syncError: ws.syncError,
  };
}

on("GET", "/app/api/projects/:id/workspace", (m) => view(workspaceOr404(m.groups!.id!)));

on("PUT", "/app/api/projects/:id/workspace/mode", (m, raw) => {
  const ws = workspaceOr404(m.groups!.id!);
  const body = ProjectWorkModeBody.safeParse(raw);
  if (flags.assistant) throw refuse(403, "owner_required", "Only an owner of this course may do that");
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const refusal = workModeRefusal({ owner: true, granted: true, launched: ws.launched, groupMode: false }, ws.mode, body.data.mode);
  if (refusal) throw refuse(refusal === "work_mode_frozen" || refusal === "work_mode_group" ? 409 : 403, refusal, refusal);
  ws.mode = body.data.mode;
  // The portal takes an online project at once; an exam waits for M6-07.
  if (ws.mode === "online") ws.syncedAt = iso(0);
  return view(ws);
});

on("POST", "/app/api/projects/:id/workspace/sync", (m) => {
  const ws = workspaceOr404(m.groups!.id!);
  if (ws.mode === "free") throw refuse(409, "not_online", "This project does not use the online workspace");
  if (ws.mode === "online_seb") throw refuse(409, "seb_required", "A Safe Exam Browser project is synced from M6-07 on");
  ws.syncedAt = iso(0);
  ws.syncError = null;
  const answer: ProjectWorkspaceSyncAccepted = { requestedAt: iso(0) };
  return answer;
});

on("GET", "/app/api/projects/:id/workspace/sessions", (m): ProjectWorkspaceSessions => {
  const id = m.groups!.id!;
  const ws = workspaceOr404(id);
  if (ws.mode === "free" || !ws.launched) return { reachable: true, sessions: [] };
  const states = ["running", "running", "stopped"] as const;
  const students = classroomRoster("r1")
    .filter((s) => s.status === "claimed" && !s.staff)
    .slice(0, states.length);
  const at = (minutes: number) => iso(-minutes * 60_000);
  return {
    reachable: true,
    sessions: [
      ...students.map((s, i) => ({
        sessionId: `ws-${i + 1}`,
        user: { id: `0190d3c4-0000-7000-8000-00000000c0${String(i + 1).padStart(2, "0")}`, name: `${s.prenom} ${s.nom}` },
        state: states[i]!,
        createdAt: at(180 - i * 20),
        lastSeenAt: at(i === 2 ? 95 : 2 + i * 3),
        lastPushAt: i === 1 ? null : at(30 + i * 10),
      })),
      // An account the classroom does not hold: named by nobody.
      { sessionId: "ws-9", user: null, state: "closed", createdAt: at(3 * 24 * 60), lastSeenAt: at(2 * 24 * 60), lastPushAt: null },
    ],
  };
});
