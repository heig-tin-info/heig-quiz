/**
 * The browser's half of the assistant's UI actions (ADR-080, P2b
 * amendment): the server checked them against the catalogue; this runs
 * them, in order, and checks again what only the browser knows.
 *
 * - `open_screen` is checked by the domain's own rule (`checkOpenScreen`),
 *   each id a plain path segment here, then resolved through the router:
 *   the path must parse back to that very screen (`parsePath`) — anything
 *   else is a no-op that says so, never a jump to the home. The router's
 *   leave guard still asks before unsaved work is left; the answer says
 *   whether the app moved.
 * - `run_command` runs a command of the mounted screen only while it is
 *   still registered AND effect-free; one that needs a real gesture (a new
 *   tab) is offered as a button the teacher clicks instead.
 * - The proposals of P3 — a write command, an editor proposal, a prepared
 *   write — are not run here: the panel shows each as a card
 *   (`AssistCards.tsx`), and only the teacher's Confirm or Apply acts.
 */
import type { AssistAction } from "@quiz/contracts";
import { checkOpenScreen, type AssistRole } from "@quiz/domain";

import type { TFunction } from "../i18n";
import { parsePath, routeToPath, type Navigate, type Route } from "../router";
import { screenCommands } from "../screenCommands";
import { ASSIST_SCREEN_LABELS } from "./screens";

/** What one action did, as the answer's line says it; `click` when the teacher has to run it. */
export interface ActionOutcome {
  ok: boolean;
  text: string;
  click?: () => void;
}

/** One path segment, never a path: no `/`, `?`, `#` nor `..` can ride in an id. */
const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;

/** The route and query an `open_screen` names, or null when it names none of the catalogue's screens. */
export function openScreenTarget(action: AssistAction, role: AssistRole) {
  let checked;
  try {
    checked = checkOpenScreen(action, role, (s) => SEGMENT.test(s));
  } catch {
    return null;
  }
  const view = checked.screen as Route["view"];
  const label = ASSIST_SCREEN_LABELS[view];
  if (!label) return null;
  // Every parameter on the route: it writes the ones it carries (a course's
  // tab in its path, a classroom's in `?tab=`); the others go on the query.
  const route = { view, ...checked.ids, ...checked.params } as Route;
  const parsed = parsePath(new URL(routeToPath(route), window.location.origin).pathname) as Record<string, unknown>;
  if (parsed.view !== view) return null;
  const query = Object.fromEntries(Object.entries(checked.params).filter(([name, value]) => parsed[name] !== value));
  return { route, query, label };
}

/** The effect-free command `id` of the mounted screen, run now; false when it is gone or writes. */
function runCommand(id: string): boolean {
  const command = screenCommands().find((c) => c.id === id);
  if (!command || command.effect !== "none") return false;
  command.run();
  return true;
}

/**
 * A WRITE command of the mounted screen, run on the teacher's Confirm
 * (ADR-080 P3, decision 5) — only while it is still registered and still a
 * write; false otherwise. Its own confirmation dialog, if any, still asks.
 */
export function runConfirmedCommand(id: string): boolean {
  const command = screenCommands().find((c) => c.id === id);
  if (!command || command.effect !== "write") return false;
  command.run();
  return true;
}

/** The actions the panel shows as cards rather than runs (ADR-080 P3). */
export const isProposal = (action: AssistAction): action is Exclude<AssistAction, { kind: "open_screen" | "run_command" }> =>
  action.kind === "confirm_command" || action.kind === "edit_question" || action.kind === "pending_write";

/** Runs `actions` in order and says what each did; the proposals are left to their cards. */
export async function runAssistActions(
  actions: readonly AssistAction[],
  navigate: Navigate | undefined,
  role: AssistRole,
  t: TFunction,
): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  for (const action of actions) {
    if (isProposal(action)) continue;
    if (action.kind === "run_command") {
      const command = screenCommands().find((c) => c.id === action.id);
      if (!command || command.effect !== "none") outcomes.push({ ok: false, text: t("assist.runFailed") });
      else if (command.gesture) outcomes.push({ ok: true, text: command.label, click: () => void runCommand(action.id) });
      else outcomes.push({ ok: runCommand(action.id), text: t("assist.ran", { command: command.label }) });
      continue;
    }
    const target = openScreenTarget(action, role);
    if (!target || !navigate) {
      outcomes.push({ ok: false, text: t("assist.openFailed") });
      continue;
    }
    const moved = await navigate(target.route, { query: target.query });
    outcomes.push(
      moved === false ? { ok: false, text: t("assist.stayed") } : { ok: true, text: t("assist.opened", { screen: t(target.label) }) },
    );
  }
  return outcomes;
}
