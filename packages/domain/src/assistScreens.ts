/**
 * The teacher assistant drives the interface (ADR-080, P2b amendment): it
 * may open one of the app's own screens, from a CLOSED catalogue, and run an
 * effect-free command of the screen the teacher is on. The browser runs
 * both, after the answer; the server checks what the model asked and hands
 * the checked actions back with the reply. Pure rules, no I/O.
 *
 * The catalogue below is checked against the web router by
 * `apps/web/src/assist/screens.test.ts`: the same views, each pattern the
 * router's own, each id of the kind the router's entity table gives, each
 * title the English label of the screen.
 */
import type { AssistEntityKind, AssistRole } from "./assist.js";
import type { AssistEditQuestion } from "./assistEdits.js";
import { ASSIST_MAX_WRITES, type AssistPendingWrite } from "./assistWrites.js";

// --- The tabs a screen reads off its address ----------------------------------

/** A course page's tabs, each a path of its own (`/courses/:id/<tab>`); the classrooms are the bare path. */
export const COURSE_TABS = ["classrooms", "templates", "pools", "members", "settings"] as const;
export type CourseTab = (typeof COURSE_TABS)[number];
/** The Administration page's tabs (`?tab=`). */
export const ADMIN_TABS = ["people", "system", "tasks", "llm", "concepts"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];
/** The classroom's sections that live in `?tab=`; the others are routes of their own. */
export const CLASSROOM_QUERY_TABS = ["evaluations", "roster", "drill"] as const;
export type ClassroomQueryTab = (typeof CLASSROOM_QUERY_TABS)[number];
/** The pool screen's tabs (`?tab=`); `review` while the platform has a model. */
export const POOL_TABS = ["questions", "concepts", "review", "settings"] as const;
/** The question editor's tabs (`?tab=`). */
export const QUESTION_TABS = ["edit", "try", "versions"] as const;
/** The results' tabs (`?tab=`). */
export const RESULTS_TABS = ["students", "questions"] as const;
/** The evaluation configuration's steps (`?step=`). */
export const EVALUATION_STEPS = ["questions", "timing", "launch"] as const;
/** The template editor's tabs (`?tab=`). */
export const TEMPLATE_TABS = ["questions", "settings"] as const;

// --- The catalogue -------------------------------------------------------------

/** What one parameter of a screen accepts. */
export type AssistParamSpec =
  /** One of a closed list (a tab, a step). */
  | { kind: "enum"; values: readonly string[] }
  /** Free text, at most {@link ASSIST_TEXT_PARAM_CHARS} characters (the pool's search box). */
  | { kind: "text"; hint: string }
  /** The id of an entity a read tool returned (a category, an item). */
  | { kind: "id"; of: string };

/** One screen the assistant may open, by the router's view name. */
export interface AssistScreenSpec {
  /** Its route pattern (`/pools/:id`), every id a parameter. */
  pattern: string;
  /** The route fields that are ids, and the entity each one is. */
  ids?: Readonly<Record<string, AssistEntityKind>>;
  /** The parameters the assistant may set: the screen's tabs, its search, … */
  params?: Readonly<Record<string, AssistParamSpec>>;
  /** Its title in English, as the interface labels it. */
  title: string;
  /** Its help topic (`help/<topic>` in the corpus). */
  help?: string;
  /** Offered to an administrator's assistant only. */
  admin?: true;
}

const tabs = (values: readonly string[]): AssistParamSpec => ({ kind: "enum", values });
const SEARCH: AssistParamSpec = {
  kind: "text",
  hint: "the search box: free text and #<concept> type:<type id> difficulty:<n|>n|a-b> version:<n|>n>",
};

export const ASSIST_SCREENS = {
  home: { pattern: "/", title: "Courses", help: "courses" },
  settings: { pattern: "/settings", title: "Settings" },
  admin: { pattern: "/admin", title: "Administration", admin: true, params: { tab: tabs(ADMIN_TABS) } },
  course: { pattern: "/courses/:id", ids: { id: "course" }, title: "Course", help: "courses", params: { tab: tabs(COURSE_TABS) } },
  template: { pattern: "/templates/:id", ids: { id: "template" }, title: "Evaluation template", help: "courses", params: { tab: tabs(TEMPLATE_TABS) } },
  classroomSettings: { pattern: "/classrooms/:id/settings", ids: { id: "classroom" }, title: "Classroom settings", help: "classroom" },
  classroomJournal: { pattern: "/classrooms/:id/journal", ids: { id: "classroom" }, title: "Classroom journal", help: "journal" },
  classroomGroups: { pattern: "/classrooms/:id/groups", ids: { id: "classroom" }, title: "Classroom groups", help: "groups" },
  classroomGrades: { pattern: "/classrooms/:id/grades", ids: { id: "classroom" }, title: "Classroom grades", help: "classroom" },
  classroom: { pattern: "/classrooms/:id", ids: { id: "classroom" }, title: "Classroom", help: "classroom", params: { tab: tabs(CLASSROOM_QUERY_TABS) } },
  activities: { pattern: "/activities", title: "Activities" },
  pools: { pattern: "/pools", title: "Question pools", help: "pools" },
  poolCategories: { pattern: "/pools/:id/categories", ids: { id: "pool" }, title: "Pool categories", help: "categories" },
  pool: { pattern: "/pools/:id", ids: { id: "pool" }, title: "Question pool", help: "pool", params: { tab: tabs(POOL_TABS), q: SEARCH, category: { kind: "id", of: "category" } } },
  polls: { pattern: "/polls", title: "Start a poll" },
  question: { pattern: "/questions/:id", ids: { id: "question" }, title: "Question editor", help: "question-editor", params: { tab: tabs(QUESTION_TABS) } },
  live: { pattern: "/evaluations/:id/live", ids: { id: "evaluation" }, title: "Live dashboard", help: "live" },
  grading: { pattern: "/evaluations/:evaluationId/grading", ids: { evaluationId: "evaluation" }, title: "Grading", help: "grading", params: { item: { kind: "id", of: "question" } } },
  results: { pattern: "/evaluations/:evaluationId/results", ids: { evaluationId: "evaluation" }, title: "Results", help: "results", params: { tab: tabs(RESULTS_TABS) } },
  evaluation: { pattern: "/evaluations/:id", ids: { id: "evaluation" }, title: "Evaluation configuration", help: "evaluation", params: { step: tabs(EVALUATION_STEPS) } },
} as const satisfies Record<string, AssistScreenSpec>;

export type AssistScreenName = keyof typeof ASSIST_SCREENS;

// --- Actions -------------------------------------------------------------------

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

/**
 * A command of the current screen that WRITES (ADR-080 P3, decision 5): the
 * panel shows a card naming it, and the browser runs it only on the
 * teacher's Confirm, while it is still registered.
 */
export interface AssistConfirmCommand {
  kind: "confirm_command";
  id: string;
  label: string;
}

export type AssistAction =
  | AssistOpenScreen
  | AssistRunCommand
  | AssistConfirmCommand
  | AssistEditQuestion
  | AssistPendingWrite;

/** A command of the current screen, as the client describes it (`AssistContext.commands`). */
export interface AssistScreenCommand {
  id: string;
  label: string;
  effect: "none" | "write";
  /** It needs the teacher's own click (a new tab): offered as a button, never run on its own. */
  gesture?: boolean | undefined;
}

/** The longest free-text parameter (the pool's search). */
export const ASSIST_TEXT_PARAM_CHARS = 200;
/** The most commands one answer may run or propose. */
export const ASSIST_MAX_COMMANDS = 3;
/** The most commands the client describes for one screen. */
export const ASSIST_MAX_SCREEN_COMMANDS = 40;
/** A command id: the palette's own (`question:preview`, `grading:results`). */
export const ASSIST_COMMAND_ID = /^[a-z][a-z0-9:-]{0,79}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id as the platform writes it: a uuid. */
export const isUuid = (s: string): boolean => UUID.test(s);

/** The screens a role's assistant may open, by name: an administrator's all, a teacher's all but the administrators'. */
export function assistScreensFor(role: AssistRole): [string, AssistScreenSpec][] {
  return Object.entries(ASSIST_SCREENS as Record<string, AssistScreenSpec>).filter(([, s]) => !s.admin || role === "admin");
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
    .map(([name, s]) => {
      const ids = Object.entries(s.ids ?? {}).map(([field, kind]) => `${field}=<${kind} id>`);
      const params = Object.entries(s.params ?? {}).map(([param, spec]) => describeParam(param, spec));
      const help = s.help ? ` (help/${s.help})` : "";
      const args = [...(ids.length > 0 ? [`ids: ${ids.join(", ")}`] : []), ...(params.length > 0 ? [`params: ${params.join(", ")}`] : [])];
      return `- ${name} — ${s.pattern} — ${s.title}${help}${args.length > 0 ? `; ${args.join("; ")}` : ""}`;
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
 * An `open_screen` input checked against the catalogue of `role`: a screen
 * of the catalogue, exactly its ids (each one `isId` — a uuid on the
 * server, a path segment in the browser), and only its parameters, each of
 * its kind. Throws an `Error` the model reads, naming what is allowed.
 */
export function checkOpenScreen(input: unknown, role: AssistRole, isId: (s: string) => boolean = isUuid): AssistOpenScreen {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const screens = assistScreensFor(role);
  const found = screens.find(([name]) => name === raw.screen);
  if (!found) throw new Error(`No screen "${String(raw.screen)}". The screens are: ${screens.map(([name]) => name).join(", ")}.`);
  const [name, entry] = found;
  const ids = stringRecord(raw.ids, "ids");
  const wanted = Object.keys(entry.ids ?? {});
  if (Object.keys(ids).some((k) => !wanted.includes(k)) || wanted.some((f) => ids[f] === undefined)) {
    throw new Error(`The screen ${name} takes ${wanted.length > 0 ? `the ids ${wanted.join(", ")}` : "no id"}.`);
  }
  for (const [field, kind] of Object.entries(entry.ids ?? {})) {
    if (!isId(ids[field]!)) throw new Error(`\`ids.${field}\` must be the id of a ${kind}, as a tool returned it.`);
  }
  const params = stringRecord(raw.params, "params");
  const allowed: Readonly<Record<string, AssistParamSpec>> = entry.params ?? {};
  for (const [param, value] of Object.entries(params)) {
    const spec = allowed[param];
    if (!spec) {
      const known = Object.keys(allowed);
      throw new Error(`The screen ${name} takes ${known.length > 0 ? `the params ${known.join(", ")}` : "no param"}.`);
    }
    checkParam(param, value, spec, isId);
  }
  return { kind: "open_screen", screen: name, ids, params };
}

/** How a command of the screen is listed to the model, its kind said, so the answer's wording is right. */
function commandLine(c: AssistScreenCommand): string {
  if (c.effect === "write") return `  - ${c.id} — ${c.label} (changes data: the user is shown a card and it runs only if they confirm)`;
  if (c.gesture) return `  - ${c.id} — ${c.label} (opens a new tab: offered as a button the user clicks)`;
  return `  - ${c.id} — ${c.label}`;
}

/**
 * The commands of the screen, as the prompt's screen part lists them
 * (ADR-080 P2b, and its P3 amendment, decision 5): each with what naming it
 * means — run after the answer, offered as a button (a new tab), or
 * proposed behind the teacher's confirmation (a write).
 */
export function assistCommandList(commands: readonly AssistScreenCommand[] | undefined): string {
  const listed = commands ?? [];
  return listed.length === 0
    ? "- Commands of this screen (run_screen_command): none."
    : `- Commands of this screen (run_screen_command):\n${listed.map(commandLine).join("\n")}`;
}

/**
 * The actions of ONE answer: what the UI tools record, and their bounds —
 * one screen per answer; at most {@link ASSIST_MAX_COMMANDS} commands run or
 * proposed, and none once a screen is being opened (the commands are the
 * CURRENT screen's, which the navigation leaves); one editor proposal, and
 * no screen opened after it nor after a proposed command (they need this
 * screen); at most {@link ASSIST_MAX_WRITES} prepared writes. Each call
 * answers the model a short text, or throws the refusal it reads. A
 * prepared write ENDS the turn (`writing`): the model then says what it
 * prepared, nothing more.
 */
export class AssistUiTurn {
  readonly actions: AssistAction[] = [];

  constructor(
    private readonly role: AssistRole,
    private readonly commands: readonly AssistScreenCommand[] | undefined,
  ) {}

  private get opening(): AssistOpenScreen | undefined {
    return this.actions.find((a): a is AssistOpenScreen => a.kind === "open_screen");
  }

  private count(kind: AssistAction["kind"]): number {
    return this.actions.filter((a) => a.kind === kind).length;
  }

  /** A write was prepared: the gateway ends the turn after this step. */
  get writing(): boolean {
    return this.count("pending_write") > 0;
  }

  open(input: unknown): string {
    if (this.opening) throw new Error(`One screen per answer: ${this.opening.screen} is already being opened.`);
    if (this.count("edit_question") + this.count("confirm_command") > 0) {
      throw new Error("This answer proposes something on the current screen: open another screen in a later answer.");
    }
    const action = checkOpenScreen(input, this.role);
    this.actions.push(action);
    const { title } = ASSIST_SCREENS[action.screen as AssistScreenName];
    return `Done: the user's browser opens ${title} after your answer. Do not list what it shows; reply in one short sentence.`;
  }

  run(input: unknown): string {
    const id = typeof input === "object" && input !== null ? (input as { id?: unknown }).id : undefined;
    const command = (this.commands ?? []).find((c) => c.id === id);
    if (!command) throw new Error(`No command "${String(id)}" on this screen. Name only one the current screen lists.`);
    if (this.opening) throw new Error("A screen is being opened: the current screen's commands no longer apply.");
    if (this.count("run_command") + this.count("confirm_command") >= ASSIST_MAX_COMMANDS) {
      throw new Error(`At most ${ASSIST_MAX_COMMANDS} commands per answer.`);
    }
    if (command.effect === "write") {
      this.actions.push({ kind: "confirm_command", id: command.id, label: command.label });
      return `Proposed: the user is shown a card naming "${command.label}"; it runs only if they confirm it. Say so; never say it is done.`;
    }
    this.actions.push({ kind: "run_command", id: command.id });
    return command.gesture
      ? `Offered: "${command.label}" opens a new tab, so it is shown as a button the user clicks under your answer. Say so; never say it is open.`
      : `Done: the user's browser runs "${command.label}" after your answer.`;
  }

  /** An editor proposal the caller checked (`proposeQuestionEdit`): one per answer, on the current screen. */
  propose(edit: AssistEditQuestion): string {
    if (this.opening) throw new Error("A screen is being opened: the editor's draft no longer applies.");
    if (this.count("edit_question") > 0) throw new Error("One proposal per answer: put every change in one call.");
    this.actions.push(edit);
    return (
      `Proposed: the user sees a before/after diff of ${edit.fields.length} field(s) with an Apply button; nothing changes ` +
      "until they apply it, and it is never published. Say so in one or two sentences; do not repeat the texts."
    );
  }

  /** A write the caller froze as pending: at most a few per answer, and the turn ends after it. */
  prepare(write: AssistPendingWrite): string {
    if (this.count("pending_write") >= ASSIST_MAX_WRITES) throw new Error(`At most ${ASSIST_MAX_WRITES} writes per answer.`);
    this.actions.push(write);
    return (
      "Prepared, NOT done: the user is shown a confirmation card, and it is written only if they confirm it. " +
      "End your answer now: say in one or two sentences what you prepared and that nothing happens until they confirm."
    );
  }

  /** Whether one more write may be prepared in this answer (checked before any work is done for it). */
  get mayPrepare(): boolean {
    return this.count("pending_write") < ASSIST_MAX_WRITES;
  }
}
