/**
 * The browser's half of the assistant's UI actions (ADR-080, P2b
 * amendment): the server checked them against the catalogue; this runs
 * them, in order, once the answer is on screen, and checks again what only
 * the browser knows.
 *
 * - `open_screen` resolves through the router: the route of the screen with
 *   its ids, its parameters on the address, and the path must parse back to
 *   that very screen (`parsePath`) — an unknown path is a no-op that says
 *   so, never a jump to the home. The router's leave guard still asks
 *   before unsaved work is left; Back returns.
 * - `run_command` runs a command of the mounted screen only while it is
 *   still registered AND effect-free (`effect: "none"`): a command that
 *   writes is never run, whatever the server returned.
 */
import type { AssistAction } from "@quiz/contracts";

import type { TFunction } from "../i18n";
import { parsePath, routeToPath, withQuery, type Navigate } from "../router";
import { screenCommands } from "../screenCommands";
import { ASSIST_SCREEN_SPECS, routeOf } from "./screens";

/** What one action did, as the answer's line says it. */
export interface ActionOutcome {
  ok: boolean;
  text: string;
}

/** One path segment, never a path: no `/`, `?`, `#` nor `..` can ride in an id. */
const SEGMENT = /^[A-Za-z0-9-]{1,64}$/;

/** The address an `open_screen` names, or null when it names none of the catalogue's screens. */
export function openScreenTarget(action: Extract<AssistAction, { kind: "open_screen" }>) {
  if (!Object.hasOwn(ASSIST_SCREEN_SPECS, action.screen)) return null;
  const view = action.screen as keyof typeof ASSIST_SCREEN_SPECS;
  const spec = ASSIST_SCREEN_SPECS[view];
  if (!spec) return null;
  const fields = spec.ids ?? [];
  if (fields.some((f) => !SEGMENT.test(action.ids[f] ?? "")) || Object.keys(action.ids).length !== fields.length) return null;
  const allowed = spec.params ?? {};
  if (Object.keys(action.params).some((p) => !Object.hasOwn(allowed, p))) return null;
  // Every parameter on the route: it writes the ones it carries (a course's
  // tab in its path, a classroom's in `?tab=`); the others go on the query.
  const route = routeOf(view, { ...action.ids, ...action.params });
  const path = routeToPath(route);
  const parsed = parsePath(new URL(path, window.location.origin).pathname) as Record<string, unknown>;
  if (parsed.view !== view) return null;
  const query = Object.fromEntries(Object.entries(action.params).filter(([name, value]) => parsed[name] !== value));
  return { route, query, label: spec.label, href: withQuery(path, query) };
}

/** Runs `actions` in order and says what each did. */
export function runAssistActions(actions: readonly AssistAction[], navigate: Navigate | undefined, t: TFunction): ActionOutcome[] {
  return actions.map((action) => {
    if (action.kind === "run_command") {
      const command = screenCommands().find((c) => c.id === action.id);
      if (!command || command.effect !== "none") return { ok: false, text: t("assist.runFailed") };
      command.run();
      return { ok: true, text: t("assist.ran", { command: command.label }) };
    }
    const target = openScreenTarget(action);
    if (!target || !navigate) return { ok: false, text: t("assist.openFailed") };
    navigate(target.route, { query: target.query });
    return { ok: true, text: t("assist.opened", { screen: t(target.label) }) };
  });
}
