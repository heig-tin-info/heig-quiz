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
 * them an assistant, refused); "Labo 5 — arbres" runs under Safe Exam
 * Browser (D21, M6-07). The student persona's
 * open project runs in the workspace, and the invited one under Safe Exam
 * Browser (`mock/student.ts`; `?sebproject=1` puts the student inside SEB,
 * on that project's `seb` session). The administration's teachers carry a
 * grant.
 */
import {
  ProjectWorkModeBody,
  type DeviceLevel,
  type ProjectWorkspace,
  type ProjectWorkspaceSessions,
  type ProjectWorkspaceSyncAccepted,
  type WorkMode,
} from "@quiz/contracts";
import { workModeChoices, workModeRefusal, workSettingOf } from "@quiz/domain";

import { classroomRoster } from "./org";
import { flags, H, iso, MockError, MockPayload, on, refuse } from "./runtime";

interface MockWorkspace {
  mode: WorkMode;
  /** The device level (ADR-089): `any` out of `online_seb`. */
  devices: DeviceLevel;
  launched: boolean;
  syncedAt: string | null;
  syncError: string | null;
}

const WORKSPACES = new Map<string, MockWorkspace>([
  ["pj-published", { mode: "online", devices: "any", launched: true, syncedAt: iso(-2 * H), syncError: null }],
  // D21 (M6-07): a draft under Safe Exam Browser, synced like an online project.
  ["pj-draft-manual", { mode: "online_seb", devices: "seb", launched: false, syncedAt: iso(-30 * 60_000), syncError: null }],
]);

/** Kiosk stations are not offered to projects here: `KIOSK_PROJECTS` stays off until M6-11d (ADR-089). */
const KIOSK_OFFERED = false;

function workspaceOr404(id: string): MockWorkspace {
  if (!flags.codespace) throw new MockError(404, "Not found");
  let ws = WORKSPACES.get(id);
  if (!ws) {
    ws = { mode: "free", devices: "any", launched: false, syncedAt: null, syncError: null };
    WORKSPACES.set(id, ws);
  }
  return ws;
}

/** The project's workspace for the persona: an owner with the grant, unless `?assistant=1`. */
function view(ws: MockWorkspace): ProjectWorkspace {
  const facts = { owner: !flags.assistant, granted: true, launched: ws.launched, groupMode: false, kioskOffered: KIOSK_OFFERED };
  return {
    mode: ws.mode,
    devices: ws.devices,
    kioskOffered: KIOSK_OFFERED,
    ...workModeChoices(facts, ws),
    syncedAt: ws.syncedAt,
    syncError: ws.syncError,
    review: true,
  };
}

on("GET", "/app/api/projects/:id/workspace", (m) => view(workspaceOr404(m.groups!.id!)));

/** The project's workspace as the staff's review launch reads it (ADR-129 §5, `mock/project.ts`); 404 without the portal. */
export const mockWorkspace = (projectId: string): ProjectWorkspace => view(workspaceOr404(projectId));

on("PUT", "/app/api/projects/:id/workspace/mode", (m, raw) => {
  const ws = workspaceOr404(m.groups!.id!);
  const body = ProjectWorkModeBody.safeParse(raw);
  if (flags.assistant) throw refuse(403, "owner_required", "Only an owner of this course may do that");
  if (!body.success) throw new MockPayload(400, { error: "validation", message: body.error.message });
  const to = workSettingOf(body.data);
  const facts = { owner: true, granted: true, launched: ws.launched, groupMode: false, kioskOffered: KIOSK_OFFERED };
  const refusal = workModeRefusal(facts, ws, to);
  const status = refusal === "kiosk_unavailable" ? 422 : refusal === "work_mode_frozen" || refusal === "work_mode_group" ? 409 : 403;
  if (refusal) throw refuse(status, refusal, refusal);
  ws.mode = to.mode;
  ws.devices = to.devices;
  // The portal takes an online project at once, under Safe Exam Browser too (M6-07).
  if (ws.mode !== "free") ws.syncedAt = iso(0);
  return view(ws);
});

on("POST", "/app/api/projects/:id/workspace/sync", (m) => {
  const ws = workspaceOr404(m.groups!.id!);
  if (ws.mode === "free") throw refuse(409, "not_online", "This project does not use the online workspace");
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
        // The first student's last push came after a restore by Quiz's App: GitHub refused it (ADR-078 §6).
        rejectedPush: i === 0 ? { ref: "refs/heads/main", at: at(30), reason: "fetch first" } : null,
      })),
      // An account the classroom does not hold: named by nobody.
      { sessionId: "ws-9", user: null, state: "closed", createdAt: at(3 * 24 * 60), lastSeenAt: at(2 * 24 * 60), lastPushAt: null, rejectedPush: null },
    ],
  };
});
