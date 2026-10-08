/**
 * The teacher assistant drives the interface (ADR-080, P2b amendment): it
 * may open one of the app's own screens, from a CLOSED catalogue, and run an
 * effect-free command of the screen the teacher is on. The browser runs
 * both, after the answer; the server only checks what the model asked
 * against the catalogue and hands the checked actions back with the reply.
 *
 * The catalogue (`ASSIST_SCREENS`, `./assistScreens.generated.ts`) is
 * DERIVED from the web router's route table by `apps/web/src/assist/screens.ts`
 * and its test, never kept by hand: a view added to the router must be
 * classified there before the build passes. This file holds the rules that
 * read it — the prompt's catalogue, the checks of the two tools, the per-turn
 * bounds — with no I/O.
 */
import type { AssistEntityKind, AssistRole } from "./assist.js";
import { ASSIST_SCREENS } from "./assistScreens.generated.js";

export { ASSIST_SCREENS };

/** What one parameter of a screen accepts. */
export type AssistParamSpec =
  /** One of a closed list (a tab, a step). */
  | { kind: "enum"; values: readonly string[] }
  /** Free text, at most {@link ASSIST_TEXT_PARAM_CHARS} characters (the pool's search box). */
  | { kind: "text"; hint: string }
  /** The id of an entity a read tool returned (a category, an item). */
  | { kind: "id"; of: string };

/** One screen the assistant may open. */
export interface AssistScreenEntry {
  /** The router's view (`pool`). */
  screen: string;
  /** Its route pattern (`/pools/:id`), every id a parameter. */
  pattern: string;
  /** The route fields that are ids, in the order the pattern names them, and the entity each one is. */
  ids: readonly { field: string; kind: AssistEntityKind }[];
  /** The parameters the assistant may set: the screen's tabs, its search, … */
  params: Readonly<Record<string, AssistParamSpec>>;
  /** The screen's title in English, as the interface labels it. */
  title: string;
  /** Its help topic (`help/<topic>` in the corpus), or null. */
  help: string | null;
  /** `admin`: offered to an administrator's assistant only. */
  audience: "staff" | "admin";
}

/** A screen to open, as the model asks for it and as the browser receives it. */
export interface AssistOpenScreen {
  kind: "open_screen";
  screen: string;
  ids: Record<string, string>;
  params: Record<string, string>;
}

/** An effect-free command of the current screen to run, by id. */
export interface AssistRunCommand {
  kind: "run_command";
  id: string;
}

export type AssistAction = AssistOpenScreen | AssistRunCommand;

/** A command of the current screen, as the client describes it (`AssistContext.commands`). */
export interface AssistScreenCommand {
  id: string;
  label: string;
  effect: "none" | "write";
}

/** The longest free-text parameter (the pool's search). */
export const ASSIST_TEXT_PARAM_CHARS = 200;
/** The most commands one answer may run. */
export const ASSIST_MAX_COMMANDS = 3;
/** The most commands the client describes for one screen. */
export const ASSIST_MAX_SCREEN_COMMANDS = 40;
/** A command id: the palette's own (`question:preview`, `grading:results`). */
export const ASSIST_COMMAND_ID = /^[a-z][a-z0-9:-]{0,79}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id as the platform writes it: a uuid. */
export const isUuid = (s: string): boolean => UUID.test(s);

/** The screens a role's assistant may open: an administrator's all, a teacher's all but the administrators'. */
export function assistScreensFor(role: AssistRole): AssistScreenEntry[] {
  return ASSIST_SCREENS.filter((s) => s.audience === "staff" || role === "admin");
}

function describeParam(name: string, spec: AssistParamSpec): string {
  switch (spec.kind) {
    case "enum":
      return `${name}=${spec.values.join("|")}`;
    case "text":
      return `${name}=<${spec.hint}>`;
    case "id":
      return `${name}=<${spec.of} id>`;
  }
}

/**
 * The catalogue as the prompt gives it (in the cached prefix: it depends on
 * the role only): one line per screen — its name, its path, its title and
 * help topic, its ids and its parameters.
 */
export function assistScreenCatalogue(role: AssistRole): string {
  return assistScreensFor(role)
    .map((s) => {
      const ids = s.ids.map((i) => `${i.field}=<${i.kind} id>`);
      const params = Object.entries(s.params).map(([name, spec]) => describeParam(name, spec));
      const help = s.help ? ` (help/${s.help})` : "";
      const args = [...(ids.length > 0 ? [`ids: ${ids.join(", ")}`] : []), ...(params.length > 0 ? [`params: ${params.join(", ")}`] : [])];
      return `- ${s.screen} — ${s.pattern} — ${s.title}${help}${args.length > 0 ? `; ${args.join("; ")}` : ""}`;
    })
    .join("\n");
}

/** A plain object of strings, or the reason it is not one. */
function stringRecord(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`\`${what}\` must be an object of strings.`);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== "string") throw new Error(`\`${what}.${key}\` must be a string.`);
    out[key] = v;
  }
  return out;
}

/** Control characters: never in a parameter that lands in an address. */
const CONTROL = /\p{Cc}/u;

function checkParam(name: string, value: string, spec: AssistParamSpec, isId: (s: string) => boolean): void {
  switch (spec.kind) {
    case "enum":
      if (!spec.values.includes(value)) throw new Error(`\`${name}\` must be one of ${spec.values.join(", ")}.`);
      return;
    case "text":
      if (value.trim() === "" || value.length > ASSIST_TEXT_PARAM_CHARS || CONTROL.test(value)) {
        throw new Error(`\`${name}\` must be a non-empty line of at most ${ASSIST_TEXT_PARAM_CHARS} characters.`);
      }
      return;
    case "id":
      if (!isId(value)) throw new Error(`\`${name}\` must be the id of a ${spec.of}, as a tool returned it.`);
  }
}

/**
 * The `open_screen` tool's input, checked against the catalogue of `role`:
 * a screen of the catalogue, exactly its ids (each one `isId`, a uuid on
 * the server), and only its parameters, each of its kind. Throws an `Error`
 * the model reads — naming what is allowed — on anything else.
 */
export function checkOpenScreen(input: unknown, role: AssistRole, isId: (s: string) => boolean = isUuid): AssistOpenScreen {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const screens = assistScreensFor(role);
  const entry = screens.find((s) => s.screen === raw.screen);
  if (!entry) throw new Error(`No screen "${String(raw.screen)}". The screens are: ${screens.map((s) => s.screen).join(", ")}.`);
  const ids = stringRecord(raw.ids, "ids");
  const wanted = entry.ids.map((i) => i.field);
  const extra = Object.keys(ids).filter((k) => !wanted.includes(k));
  if (extra.length > 0 || wanted.some((f) => ids[f] === undefined)) {
    throw new Error(`The screen ${entry.screen} takes ${wanted.length > 0 ? `the ids ${wanted.join(", ")}` : "no id"}.`);
  }
  for (const i of entry.ids) {
    if (!isId(ids[i.field]!)) throw new Error(`\`ids.${i.field}\` must be the id of a ${i.kind}, as a tool returned it.`);
  }
  const params = stringRecord(raw.params, "params");
  for (const [name, value] of Object.entries(params)) {
    const spec = entry.params[name];
    if (!spec) {
      const known = Object.keys(entry.params);
      throw new Error(`The screen ${entry.screen} takes ${known.length > 0 ? `the params ${known.join(", ")}` : "no param"}.`);
    }
    checkParam(name, value, spec, isId);
  }
  return { kind: "open_screen", screen: entry.screen, ids, params };
}

/**
 * The commands of the current screen the model may run: the effect-free
 * ones only (ADR-080 P2b, decision 2). A command that writes is never
 * offered, nor runnable, whatever the model names.
 */
export const runnableCommands = (commands: readonly AssistScreenCommand[] | undefined): AssistScreenCommand[] =>
  (commands ?? []).filter((c) => c.effect === "none");

/** The commands of the screen, as the prompt's screen part lists them. */
export function assistCommandList(commands: readonly AssistScreenCommand[] | undefined): string {
  const runnable = runnableCommands(commands);
  return runnable.length === 0
    ? "- Commands you may run here: none."
    : `- Commands you may run here (run_screen_command):\n${runnable.map((c) => `  - ${c.id} — ${c.label}`).join("\n")}`;
}

/**
 * The UI actions of ONE answer: what the two tools record, and their
 * bounds — one screen per answer, at most {@link ASSIST_MAX_COMMANDS}
 * commands, and no command once a screen is being opened (the commands are
 * the CURRENT screen's, which the navigation leaves). Each call answers the
 * model a short "done by the browser" text, or throws the refusal it reads.
 */
export class AssistUiTurn {
  readonly actions: AssistAction[] = [];

  constructor(
    private readonly role: AssistRole,
    private readonly commands: readonly AssistScreenCommand[] | undefined,
    private readonly isId: (s: string) => boolean = isUuid,
  ) {}

  private get opening(): AssistOpenScreen | undefined {
    return this.actions.find((a): a is AssistOpenScreen => a.kind === "open_screen");
  }

  open(input: unknown): string {
    if (this.opening) throw new Error(`One screen per answer: ${this.opening.screen} is already being opened.`);
    const action = checkOpenScreen(input, this.role, this.isId);
    this.actions.push(action);
    const title = ASSIST_SCREENS.find((s) => s.screen === action.screen)!.title;
    return `Done: the user's browser opens ${title} after your answer. Do not list what it shows; reply in one short sentence.`;
  }

  run(input: unknown): string {
    const id = (typeof input === "object" && input !== null ? (input as { id?: unknown }).id : undefined) as unknown;
    const command = runnableCommands(this.commands).find((c) => c.id === id);
    if (!command) throw new Error(`No command "${String(id)}" you may run on this screen. Run only one the current screen lists.`);
    if (this.opening) throw new Error("A screen is being opened: the current screen's commands no longer apply.");
    if (this.actions.length >= ASSIST_MAX_COMMANDS) throw new Error(`At most ${ASSIST_MAX_COMMANDS} commands per answer.`);
    this.actions.push({ kind: "run_command", id: command.id });
    return `Done: the user's browser runs "${command.label}" after your answer.`;
  }
}
