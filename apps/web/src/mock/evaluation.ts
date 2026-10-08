/** Section 3 of the mock — see `index.ts` for the layout. */
import { countsAsCompleted,
  evaluationTotal,
  configLock,
  isConfigEditable,
  isConfigFieldWritable,
  isFeedbackAllowed,
  itemListDiff,
  itemListLock,
  missingTimingFields,
  pastTiming,
  parseCloze,
  round2,
  splitTemplate,
} from "@quiz/domain";
import type {
  EvaluationTiming,
  FeedbackWhen,
  LobbyName,
  McqScorePolicy,
} from "@quiz/domain";
import { TemplatePatch, type DashboardAccess } from "@quiz/contracts";
import {
  D,
  H,
  MockError,
  MockPayload,
  flags,
  iso,
  mockCalculator,
  MOCK_CONDITIONS,
  now,
  on,
  rand,
} from "./runtime";
import {
  CATEGORIZE_ANSWER,
  DIAGRAM_ANSWER,
  MockQuestion,
  RC_REFERENCE,
  RC_STUDENT,
  categories,
  coursePools,
  frozenConfig,
  isKeyless,
  poolOr404,
  poolSummary,
  questionOr404,
  questions,
  registerUsedProbe,
  solutionOf,
  studentView,
} from "./pool";
import {
  ME_TEACHER,
  MOCK_CATALOG,
  classroomRoster,
  courses,
  roomOr404,
  rooms,
  templateCount,
} from "./org";
import {
  me,
} from "./session";

// --- 3. Evaluations, live dashboard (WP8) ----------------------------------
//
// Everything a teacher can configure and supervise, with enough data that the
// five states of every surface are reachable without a backend: one
// evaluation per state, and a running one at 24 students × 10 questions —
// the size the grid has to stay usable at (120 × 10 under `?many=1`, which is
// the roster the classroom above grows to).
//
// The items are frozen on the questions of section 2, by design: the item
// table, the picker, the teacher's preview and the inspect panel of the
// dashboard then all render the SAME four types on the SAME French content
// the pool screens show, and there is exactly one place to edit when a
// payload changes.
//
// Ids here are real UUIDs, not "e1": the SSE client validates every frame
// against the `ServerEvent` schema of `@quiz/contracts` (invariant 7) and the
// dashboard snapshot against `DashboardView`, so the mock has to speak the
// same grammar as the server, down to the id format. The one exception is the
// `questionId` an item points at, which is the pool's own `q3` — it never
// travels on the stream.

let uuidSeq = 0;
export const uuid = (): string =>
  `00000000-0000-4000-8000-${(uuidSeq += 1).toString(16).padStart(12, "0")}`;

const ADJECTIVES = ["calme", "vif", "patient", "curieux", "sobre", "franc", "alerte", "serein"];
const ANIMALS = ["héron", "renard", "lynx", "martre", "bouquetin", "chamois", "castor", "milan"];
/** Decision D20: a stable adjective+animal per row, never the student's name. */
const pseudonymOf = (index: number) =>
  `${ADJECTIVES[index % ADJECTIVES.length]} ${ANIMALS[(index * 3) % ANIMALS.length]}`;

// --- The pool, seen from an evaluation -------------------------------------
//
// Four adapters, one per thing an item needs from the question it froze: what
// the student sees, what the key is, what a student plausibly answered, and
// the glyph the grid puts in a cell. The first two go through the very
// functions of section 2 (`studentView`, and the `@quiz/domain` cloze
// helpers), so nothing is described twice.


/** The questions an evaluation may draw from: published, `p1` first. */
function itemSource(): MockQuestion[] {
  const published = questions.filter((q) => q.deletedAt === null && q.versions.length > 0);
  const primary = published.filter((q) => q.poolId === "p1");
  /*
   * The `circuit` question lives in the SECOND pool — a sensor's front end is
   * not a C exercise — and an evaluation that never played it would leave the
   * dashboard, the grading panel and the feedback screen without one. It is
   * spliced in early enough that even a four-item evaluation carries it.
   */
  const circuit = published.filter((q) => q.type === "circuit");
  /*
   * The essay is spliced in the same way, fifth, so the closed and released
   * evaluations the grading panel is built from carry one (issue #192).
   */
  const essay = published.filter((q) => q.type === "rich");
  // The categorize question follows the essay, sixth (docs/04 §4.13), and
  // the code-to-picture one comes seventh, so the two finished evaluations
  // give the grading table every type of question (ADR-044).
  const categorize = published.filter((q) => q.type === "categorize");
  const codeimage = published.filter((q) => q.type === "codeimage");
  // The diagram comes eighth (docs/04 §4.14), after the picture.
  const diagram = published.filter((q) => q.type === "diagram");
  const rest = primary.filter((q) => !["rich", "categorize", "codeimage", "diagram"].includes(q.type));
  if (primary.length === 0) return published;
  return [
    ...rest.slice(0, 2),
    ...circuit,
    ...rest.slice(2, 3),
    ...essay,
    ...categorize,
    ...codeimage,
    ...diagram,
    ...rest.slice(3),
  ];
}

const studentConfigOf = (q: MockQuestion): unknown => studentView(q, frozenConfig(q));


type MockBlank = ReturnType<typeof parseCloze>["blanks"][number];

/** What a student would type in one blank. A `select` stores the option INDEX. */
function blankAnswer(blank: MockBlank): string {
  switch (blank.kind) {
    case "text":
      return blank.answers[0] ?? "";
    case "number":
      return String(blank.value);
    case "select":
      return String(blank.correct[0] ?? 0);
    case "regex":
      return blank.pattern.replace(/[^\w ]/g, "");
  }
}

/**
 * One student's answer to one item. Two in three are the right one: a grid of
 * nothing but wrong answers reads as a broken mock rather than as a hard
 * question, and the teacher's eye is exactly what these screens are for.
 */
function answerOf(q: MockQuestion, seedValue: number): unknown {
  const config = frozenConfig(q);
  const wrong = seedValue % 3 === 0;
  switch (q.type) {
    case "mcq": {
      const choices = (config.choices ?? []) as { correct: boolean }[];
      const correct = Math.max(
        choices.findIndex((c) => c.correct),
        0,
      );
      const picked = wrong ? (correct + 1) % Math.max(choices.length, 1) : correct;
      return { selected: [picked] };
    }
    case "short": {
      const matchers = (config.matchers ?? []) as { value?: unknown }[];
      const expected = String(matchers[0]?.value ?? "");
      return { text: wrong ? `${expected}0` : expected };
    }
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""));
      // A blank left untouched is `null`, which is what an unfinished answer
      // looks like on the wire.
      return {
        blanks: parse.blanks.map((b, i) => ((seedValue + i) % 4 === 0 ? null : blankAnswer(b))),
      };
    }
    case "code":
      return {
        regions: splitTemplate(String(config.template ?? ""), "c")
          .filter((s) => s.kind === "editable")
          .map((s) => s.text),
        lastRun: null,
      };
    case "codeimage":
      return {
        regions: splitTemplate(String(config.template ?? ""), "c")
          .filter((s) => s.kind === "editable")
          .map((s) => s.text),
      };
    // The student's circuit is the reference with its ground wires missing
    // when the seed says "wrong": a floating capacitor is the mistake this
    // type actually produces, and the strip under the canvas names it.
    case "circuit":
      return { schematic: wrong ? RC_STUDENT : RC_REFERENCE };
    // An essay has no wrong answer to pick: a short one and a longer one.
    case "rich":
      return { text: wrong ? RICH_SHORT_ANSWER : RICH_LONG_ANSWER };
    // The mockup's partly right answer, or the key itself.
    case "categorize":
      return wrong
        ? CATEGORIZE_ANSWER
        : {
            columns: Object.fromEntries(
              ((config.columns ?? []) as { id: string; cards: string[] }[]).map((c) => [c.id, c.cards]),
            ),
          };
    // Half drawn from the starter, or the reference itself.
    case "diagram":
      return wrong ? DIAGRAM_ANSWER : { scene: config.reference };
  }
}

/** Two essays of the mock class, the second one finished. */
export const RICH_SHORT_ANSWER = "La pile déborde et le programme plante.";
export const RICH_LONG_ANSWER =
  "Chaque appel de fonction empile un **cadre** : l'adresse de retour et les variables locales.\n\n" +
  "La pile a une taille fixe (8 Mio par défaut sous Linux). Une récursion sans condition d'arrêt " +
  "finit par écrire sous sa limite, dans une page non allouée. Le processeur lève une faute de " +
  "page, et le noyau envoie `SIGSEGV` au processus, qui s'arrête.";

/**
 * The glyph a dashboard cell carries, the way the SERVER writes it: the
 * question type's own `summarizeAnswer` (`@quiz/core`), not a count. It is
 * duplicated here rather than imported because the mock answers HTTP and has
 * no configuration to hand a server package; the shapes are the real ones, so
 * a change of form is visible on the screenshots.
 */
export function summaryOf(q: MockQuestion, seedValue: number): string {
  const answer = answerOf(q, seedValue);
  switch (q.type) {
    case "mcq":
      return (answer as { selected: number[] }).selected
        .map((index) => String.fromCharCode(65 + index))
        .join(", ");
    case "short":
      return (answer as { text: string }).text;
    case "cloze":
      return (answer as { blanks: (string | null)[] }).blanks
        .map((b) => (b === null || b === "" ? "—" : b))
        .join(" · ");
    case "code":
    case "codeimage": {
      const regions = (answer as { regions?: string[] }).regions ?? [];
      return `${regions.reduce((sum, r) => sum + r.split("\n").length, 0)} L`;
    }
    case "circuit": {
      const schematic = (answer as { schematic?: { components?: unknown[] } }).schematic;
      const max = (frozenConfig(q).palette as { maxComponents?: number } | undefined)
        ?.maxComponents;
      return `${schematic?.components?.length ?? 0}/${max ?? 10}`;
    }
    // `summarizeAnswer` of `@quiz/qt-rich`: the count, never the first line.
    case "rich": {
      const chars = (answer as { text: string }).text.length;
      const max = frozenConfig(q).maxChars as number | undefined;
      return max === undefined ? String(chars) : `${chars}/${max}`;
    }
    // `summarizeAnswer` of `@quiz/qt-categorize`: cards placed / cards.
    case "categorize": {
      const placed = Object.values((answer as { columns: Record<string, string[]> }).columns).flat().length;
      return `${placed}/${((frozenConfig(q).cards ?? []) as unknown[]).length}`;
    }
    // `summarizeAnswer` of `@quiz/qt-diagram`: elements · links.
    case "diagram": {
      const { scene } = answer as { scene: { nodes: unknown[]; links: unknown[] } };
      return `${scene.nodes.length} · ${scene.links.length}`;
    }
    // A poll's alone: no evaluation of the mock holds one.
    case "brainstorm":
      return "";
  }
}

/** The pool question an item froze on, or null if the pool no longer has it. */
export const itemQuestion = (item: { questionId: string }): MockQuestion | null =>
  questions.find((q) => q.id === item.questionId) ?? null;
interface MockCell {
  itemId: string;
  status: "empty" | "seen" | "in_progress" | "skipped" | "done";
  /** The student's review flag (issue #89). */
  flagged: boolean;
  /**
   * The live verdict of ADR-020: with the "Results" switch on, the real
   * server grades the answer it already holds. The mock fakes it the only
   * way a mock can — deterministically, from the cell's own coordinates —
   * so the screen it draws is the screen the teacher gets.
   */
  verdict: "correct" | "partial" | "wrong" | null;
  provisional: boolean;
  points: null;
  revision: number;
  summary: string | null;
}

/** A stable verdict per cell, so a re-render never reshuffles the colours. */
export function mockVerdict(seed: number): "correct" | "partial" | "wrong" {
  const n = seed % 10;
  return n < 6 ? "correct" : n < 8 ? "partial" : "wrong";
}

const MOCK_INTRO_FIRST =
  "Lisez les chapitres 8 et 9 du polycopié avant de répondre. **Une seule réponse** par question à choix.";
const MOCK_INTRO_PART2 =
  "## Partie 2\n\nFin de la première partie. Les questions suivantes portent sur le code.";

interface MockItem {
  id: string;
  position: number;
  points: number;
  milestone: boolean;
  bonus: boolean;
  intro: string | null;
  questionId: string;
  questionVersionId: string;
  type: string;
  internalName: string;
  versionNumber: number;
  latestVersionNumber: number | null;
  deprecated: boolean;
}

interface MockRowState {
  attemptId: string | null;
  seatId: string;
  userId: string;
  displayName: string;
  /** A teacher walking their own quiz (ADR-018): badged, counted nowhere. */
  staff: boolean;
  lastName: string;
  firstName: string;
  email: string;
  pseudonym: string;
  state: "not_started" | "in_progress" | "submitted" | "expired";
  online: boolean;
  lastSeenAt: string | null;
  deadlineAt: string | null;
  timeBonusPercent: number;
  /** F-EVAL-15: the row shows the latest attempt; this many were taken. */
  attemptCount: number;
  points: null;
  maxPoints: number;
  cells: MockCell[];
  /** ADR-051 §8: how the student sits it — the portal, unless `?seb=1` / `?kiosk=1`. */
  access: DashboardAccess;
}

const PORTAL: DashboardAccess = { kind: "portal", station: null, alert: null };

/**
 * `?kiosk=1`: three students sit on stations — one suspended, one Google
 * cannot attest, one fine; `?seb=1`: one in Safe Exam Browser.
 */
function mockAccess(index: number): DashboardAccess {
  if (flags.kiosk && index === 1) return { kind: "kiosk", station: "Poste de secours n° 7", alert: "suspended" };
  if (flags.kiosk && index === 3) return { kind: "kiosk", station: "Poste de secours n° 8", alert: "unavailable" };
  if (flags.kiosk && index === 5) return { kind: "kiosk", station: "Poste de secours n° 2", alert: null };
  if (flags.seb && index === 2) return { kind: "seb", station: null, alert: null };
  return PORTAL;
}

export interface MockEvaluation {
  id: string;
  classroomId: string;
  title: string;
  mode: "exam" | "exercise" | "poll";
  state:
    | "draft"
    | "scheduled"
    | "lobby"
    | "running"
    | "paused"
    | "closed"
    | "grading"
    | "released";
  settings: Record<string, unknown>;
  gradingScale: Record<string, unknown>;
  feedbackPolicy: Record<string, unknown>;
  mcqPolicy: McqScorePolicy;
  opensAt: string | null;
  closesAt: string | null;
  durationS: number | null;
  accessCode: string | null;
  ipAllowlist: string[];
  startedAt: string | null;
  pausedAt: string | null;
  closedAt: string | null;
  releasedAt: string | null;
  /** ADR-050: an exercise's correction published while it runs. */
  correctionPublishedAt: string | null;
  modifiedAfterRelease: boolean;
  createdAt: string;
  /** The template it was made from, and the revision its questions came from (ADR-031). */
  originTemplateId: string | null;
  originRevision: number | null;
  items: MockItem[];
  rows: MockRowState[];
  present: number;
}

const defaultEvaluationSettings = () => ({
  navigation: "free",
  presentation: "zen",
  lobby: "manual",
  shuffleItems: false,
  shuffleChoices: true,
  timing: "duration",
  showProgressBar: true,
  logVisibility: true,
  requireFullscreen: false,
  // ADR-026, behind the `?negative=1` scene flag.
  ...(flags.negative ? { negativeMarking: true } : {}),
  // ADR-051, behind `?kiosk=1`: the exams accept the stations, and the live
  // grid offers "Assign a station".
  ...(flags.kiosk ? { kiosk: true } : {}),
  ...mockCalculator(),
});

/**
 * The items of an evaluation, frozen on the published questions of the pool.
 * `versionNumber` is the frozen one and `latestVersionNumber` what the pool
 * published since: one item in five is deliberately left a version behind, so
 * the stale badge and the one-click update are reachable without editing
 * anything.
 */
function makeItems(count: number): MockItem[] {
  const source = itemSource();
  if (source.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const q = source[i % source.length]!;
    const latest = q.versions.at(-1)!;
    // Every third item is frozen one version behind, whenever the question
    // has one: that is the stale badge and the one-click update.
    const frozen = i % 3 === 0 && latest.number > 1 ? latest.number - 1 : latest.number;
    return {
      id: uuid(),
      // 0-based, as `evaluation_items.position` is on the wire: every screen
      // numbers from 1 itself.
      position: i,
      points: q.type === "code" ? 3 : 1 + (i % 3),
      // Two section breaks, the first early enough that the four-item draft
      // shows one: the milestone separator is a shape of the list and has to
      // appear on the screenshot that documents it.
      milestone: i === 1 || i === 4,
      // One bonus question (ADR-052) in a list long enough to keep others
      // that count: the builder's candy toggle and the student's label.
      bonus: count >= 4 && i === 2,
      // ADR-084: the instructions before the first question, and a transition
      // after the first section break — the builder's text bands.
      intro: i === 0 ? MOCK_INTRO_FIRST : i === 2 ? MOCK_INTRO_PART2 : null,
      questionId: q.id,
      questionVersionId: uuid(),
      type: q.type,
      internalName: q.internalName,
      versionNumber: frozen,
      latestVersionNumber: latest.number,
      deprecated: latest.deprecatedAt !== null,
    };
  });
}

/** F-EVAL-15, as the server reads it: an exercise whose retakes are on. */
const retakesOnMock = (e: MockEvaluation): boolean =>
  e.mode === "exercise" &&
  (e.settings as { retakes?: { enabled?: boolean } }).retakes?.enabled === true;

export function makeRows(e: MockEvaluation, started: boolean): MockRowState[] {
  const roster = classroomRoster(e.classroomId);
  const maxPoints = evaluationTotal(e.items);
  const retaking = retakesOnMock(e);
  return roster.map((student, index) => {
    // A deterministic spread: some are ahead, some have not opened it.
    const progress = started ? Math.min(e.items.length, Math.floor(rand() * (e.items.length + 2))) : 0;
    const online = started ? rand() > 0.12 : rand() > 0.3;
    const hasAttempt = started && progress > 0;
    return {
      attemptId: hasAttempt ? uuid() : null,
      seatId: uuid(),
      userId: uuid(),
      displayName: `${student.nom}, ${student.prenom}`,
      staff: false,
      lastName: student.nom,
      firstName: student.prenom,
      email: student.email,
      pseudonym: pseudonymOf(index),
      state: !hasAttempt
        ? "not_started"
        : progress >= e.items.length
          ? "submitted"
          : "in_progress",
      online,
      lastSeenAt: online ? iso(-2000) : hasAttempt ? iso(-40_000) : null,
      // The common close for most of the class, so the grid shows the
      // header's clock and nothing per row (#227). A time bonus carries its
      // share of the window (the duration), and one student got five more minutes: the two
      // cases in which a row shows a countdown of its own.
      deadlineAt: hasAttempt
        ? new Date(
            Date.parse(e.closesAt ?? iso(12 * 60_000)) +
              ((e.durationS ?? 0) * 1000 * student.timeBonusPercent) / 100 +
              (index === 4 ? 5 * 60_000 : 0),
          ).toISOString()
        : null,
      timeBonusPercent: student.timeBonusPercent,
      // An exercise with retakes: every third student is on a later attempt.
      attemptCount: !hasAttempt ? 0 : retaking && index % 3 === 1 ? 2 + (index % 2) : 1,
      points: null,
      maxPoints,
      access: mockAccess(index),
      cells: e.items.map((item, i) => {
        // The states of F-DASH-01 a `free` paper reaches (issue #89): an
        // answer behind the student and where they are, now and then a
        // question left on purpose ("won't answer"), `seen` on the next
        // question for a third of the class (opened, nothing typed) and
        // empty after. `done` is the validation of the locking navigations,
        // which this paper does not use.
        const status: MockCell["status"] =
          i < progress
            ? (index + i) % 7 === 3
              ? "skipped"
              : "in_progress"
            : i === progress && index % 3 === 0
              ? "seen"
              : "empty";
        const question = itemQuestion(item);
        const answered = status === "in_progress";
        return {
          itemId: item.id,
          status,
          // The second question is the unclear one: most of the class that
          // reached it flagged it — the story the column header tells.
          flagged:
            status !== "empty" && ((i === 1 && index % 3 !== 2) || (index * 5 + i) % 29 === 0),
          verdict: answered ? mockVerdict(index * 7 + i * 3) : null,
          provisional: answered,
          points: null,
          revision: status === "empty" || status === "seen" ? 0 : 1 + i,
          // `seen` carries nothing on purpose: there is no answer to preview.
          summary:
            answered && question !== null ? summaryOf(question, index + i) : null,
        };
      }),
    };
  });
}

export function makeEvaluation(
  classroomId: string,
  title: string,
  state: MockEvaluation["state"],
  itemCount: number,
  extra: Partial<MockEvaluation> = {},
): MockEvaluation {
  const e: MockEvaluation = {
    id: uuid(),
    classroomId,
    title,
    mode: "exam",
    state,
    settings: defaultEvaluationSettings(),
    gradingScale: { kind: "linear", rounding: "nearest" },
    feedbackPolicy: {
      when: "on_release",
      showAnswer: true,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: true,
      showTeacherComment: true,
    },
    mcqPolicy: "all_or_nothing",
    opensAt: null,
    closesAt: null,
    durationS: 45 * 60,
    accessCode: null,
    ipAllowlist: [],
    startedAt: null,
    pausedAt: null,
    closedAt: null,
    releasedAt: null,
    correctionPublishedAt: null,
    modifiedAfterRelease: false,
    createdAt: iso(-10 * D),
    originTemplateId: null,
    originRevision: null,
    items: [],
    rows: [],
    present: 0,
    ...extra,
  };
  e.items = makeItems(itemCount);
  const started =
    state === "running" || state === "paused" || state === "closed" || state === "released";
  e.rows = makeRows(e, started);
  if (state === "closed" || state === "released") {
    // Nothing is in flight once the ticker has closed everything: no
    // countdown keeps running on a finished quiz.
    for (const row of e.rows) {
      if (row.state === "in_progress") row.state = "expired";
      row.deadlineAt = null;
    }
  }
  e.present = e.rows.filter((r) => r.online).length;
  return e;
}

export const evaluations: MockEvaluation[] = [];

// The pool list's "Used" (ADR-013 §7): a question frozen in an exam or an
// exercise where a student seat, not a staff walk, STARTED an attempt.
registerUsedProbe((questionId) =>
  evaluations.some(
    (e) =>
      e.mode !== "poll" &&
      e.items.some((i) => i.questionId === questionId) &&
      e.rows.some((r) => !r.staff && r.attemptId !== null && r.state !== "not_started"),
  ),
);
/** The draft exercise with retakes (F-EVAL-15), addressable by id. */
export const RETAKE_DRAFT_ID = "eeeeeeee-0000-4000-8000-000000000015";
/** The draft made from a template that has moved since (F-EVAL-26), addressable by id. */
export const TEMPLATE_INSTANCE_ID = "eeeeeeee-0000-4000-8000-000000000026";
/** The classroom every seeded evaluation belongs to (`r1`, emptied or not). */
export const EVAL_ROOM = "r1";

/*
 * The finished two come first and are seeded UNCONDITIONALLY. They are the
 * ones section 5 grades, and an empty grading queue or an empty results table
 * is a state of a real evaluation, not of a missing one: under `?empty=1` the
 * classroom has no roster, so they simply carry no item and no attempt.
 *
 * Being first also makes them what the state aliases `closed` and `released`
 * resolve to, which is what the screenshot script deep-links to.
 */
evaluations.push(
  // Nine items: the eighth is the diagram, the ninth the cloze, so the
  // correction draws both.
  makeEvaluation(EVAL_ROOM, "Quiz 0 — prise en main", "closed", 9, {
    startedAt: iso(-20 * D),
    closedAt: iso(-20 * D + H),
  }),
  makeEvaluation(EVAL_ROOM, "Test d'entrée", "released", 8, {
    startedAt: iso(-60 * D),
    closedAt: iso(-60 * D + H),
    releasedAt: iso(-59 * D),
    // Published, then a grading was adjusted: the banner the results page
    // shows when what the students read is no longer what the table says.
    modifiedAfterRelease: true,
  }),
);

function seedEvaluations() {
  const room = rooms[0];
  if (!room) return;
  evaluations.push(
    // ADR-079: the draft exam announces its conditions (the editor's screenshot).
    makeEvaluation(room.id, "Quiz 1 — variables et types", "draft", 4, {
      // The first two were ticked in PRG1's catalog (F-ORG-16); the rest are one-off.
      settings: {
        ...defaultEvaluationSettings(),
        conditions: MOCK_CONDITIONS.map((c, i) => {
          const entry = MOCK_CATALOG.c1?.[i];
          return i < 2 && entry ? { ...c, catalogId: entry.id } : c;
        }),
      },
    }),
    makeEvaluation(room.id, "Quiz 2 — boucles", "scheduled", 6, {
      opensAt: iso(2 * D),
      closesAt: iso(2 * D + H),
    }),
    makeEvaluation(room.id, "Quiz 4 — chaînes", "lobby", 8),
    makeEvaluation(room.id, "Quiz 3 — pointeurs et tableaux", "running", 10, {
      startedAt: iso(-13 * 60_000),
      closesAt: iso(12 * 60_000),
    }),
    // F-EVAL-15: a draft exercise with retakes on, at a fixed id so the
    // screenshot script can open its timing step (the `draft` alias is the
    // exam above).
    makeEvaluation(room.id, "Série 5 — entraînement libre", "draft", 4, {
      id: RETAKE_DRAFT_ID,
      mode: "exercise",
      durationS: null,
      settings: {
        ...defaultEvaluationSettings(),
        timing: "manual",
        lobby: "skip",
        retakes: { enabled: true, keep: "best", maxAttempts: 3 },
      },
      feedbackPolicy: {
        when: "immediate",
        showAnswer: true,
        showKey: true,
        showExplanation: true,
        showHiddenCaseNames: true,
        showTeacherComment: true,
      },
    }),
    makeEvaluation(room.id, "Exercice — allocation dynamique", "paused", 5, {
      mode: "exercise",
      // F-EVAL-15: several attempts, the best one kept, three at most.
      settings: {
        ...defaultEvaluationSettings(),
        retakes: { enabled: true, keep: "best", maxAttempts: 3 },
      },
      startedAt: iso(-30 * 60_000),
      closesAt: iso(8 * 60_000),
      pausedAt: iso(-60_000),
    }),
  );
}
if (!flags.empty) seedEvaluations();

/**
 * A semester of weekly take-home series in EMB-2026 (#190): what the
 * Activities section is for — the four behind (two published, two waiting
 * for their grading), this week's open, and the five ahead scheduled. Each
 * opens on a Monday at 08:00 and closes the Sunday after at 23:59.
 */
function seedSeries() {
  const monday = new Date(now);
  monday.setHours(8, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  for (let week = -4; week <= 5; week++) {
    const opens = new Date(monday);
    opens.setDate(opens.getDate() + 7 * week);
    const closes = new Date(opens);
    closes.setDate(closes.getDate() + 6);
    closes.setHours(23, 59, 0, 0);
    const state = week < -2 ? "released" : week < 0 ? "closed" : week === 0 ? "running" : "scheduled";
    const e = makeEvaluation("r3", `Série ${week + 5} — ${SERIES[week + 4]}`, state, 0, {
      mode: "exercise",
      durationS: null,
      settings: { ...defaultEvaluationSettings(), timing: "deadline", lobby: "skip" },
      opensAt: opens.toISOString(),
      closesAt: closes.toISOString(),
      startedAt: week <= 0 ? opens.toISOString() : null,
      closedAt: week < 0 ? closes.toISOString() : null,
      releasedAt: week < -2 ? closes.toISOString() : null,
      createdAt: iso(-40 * D),
    });
    evaluations.push(e);
  }
}
const SERIES = [
  "GPIO",
  "Interruptions",
  "Timers",
  "UART",
  "SPI",
  "I2C",
  "ADC",
  "PWM",
  "DMA",
  "Basse consommation",
];
if (!flags.empty) seedSeries();

/**
 * `?mytest=1` — the teacher joined their own classroom and walked every
 * started evaluation with that staff seat (ADR-018). It is what makes the
 * reset action, the badged row of the live grid, the badged entry of the
 * grading panel and the badged result row reachable in the mock.
 */
function seedStaffTest() {
  for (const room of rooms) {
    if (room.roster.some((s) => s.email === ME_TEACHER.email)) continue;
    room.roster.push({
      id: "s-me",
      nom: ME_TEACHER.familyName,
      prenom: ME_TEACHER.givenName,
      email: ME_TEACHER.email,
      status: "claimed",
      conflictFlag: false,
      staff: true,
      timeBonusPercent: 0,
      note: null,
      lastLoginAt: iso(-H),
      avatarUrl: null,
      userId: ME_TEACHER.userId,
      githubLogin: null,
    });
  }
  for (const e of evaluations) {
    // Only where the class itself has attempts: a teacher's test on a draft
    // nobody has opened is not a state worth mocking.
    if (!e.rows.some((r) => r.attemptId !== null)) continue;
    e.rows.push(staffRow(e));
  }
}

/** The teacher's own row: every question answered and submitted. */
function staffRow(e: MockEvaluation): MockRowState {
  const maxPoints = evaluationTotal(e.items);
  return {
    attemptId: uuid(),
    seatId: uuid(),
    userId: ME_TEACHER.userId,
    displayName: `${ME_TEACHER.familyName}, ${ME_TEACHER.givenName}`,
    staff: true,
    lastName: ME_TEACHER.familyName,
    firstName: ME_TEACHER.givenName,
    email: ME_TEACHER.email,
    pseudonym: "Staff Test",
    state: "submitted",
    online: false,
    lastSeenAt: iso(-5 * 60_000),
    deadlineAt: null,
    timeBonusPercent: 0,
    attemptCount: 1,
    points: null,
    maxPoints,
    access: PORTAL,
    cells: e.items.map((item, i) => ({
      itemId: item.id,
      status: "in_progress" as const,
      flagged: false,
      verdict: mockVerdict(i * 3),
      provisional: true,
      points: null,
      revision: 1 + i,
      summary: null,
    })),
  };
}
if (flags.mytest && !flags.empty) seedStaffTest();

/** The running evaluation is the one the fake stream keeps moving. */
const runningEvaluation = () => evaluations.find((e) => e.state === "running") ?? null;

/**
 * Mock-only affordance: an evaluation is addressable by its STATE as well as
 * by its id, so `/evaluations/running/live` and `/evaluations/lobby` are
 * stable URLs for the screenshot script and for a quick look. The real API
 * only knows uuids, and so does every id the mock puts on the wire.
 */
export const aliased = new Map<string, string>();
export const findEvaluation = (key: string): MockEvaluation | null => {
  const byId = evaluations.find((x) => x.id === key);
  if (byId) return byId;
  // An alias is resolved ONCE and then pinned to the evaluation it found.
  // Otherwise pausing `/evaluations/running/live` moves that evaluation out
  // of the `running` state, the next request on the same URL matches nothing,
  // and the dashboard that just issued the command gets a 404 (W17).
  const pinned = aliased.get(key);
  if (pinned !== undefined) return evaluations.find((x) => x.id === pinned) ?? null;
  const byState = evaluations.find((x) => x.state === key) ?? null;
  if (byState) aliased.set(key, byState.id);
  return byState;
};

export const evaluationOr404 = (id: string) => {
  const e = findEvaluation(id);
  if (!e) throw new MockError(404, "Evaluation not found");
  return e;
};

/** The server's total: bonus items left out (ADR-052). */
const totalPointsOf = (e: MockEvaluation) => evaluationTotal(e.items);
const attemptCountOf = (e: MockEvaluation) => e.rows.filter((r) => r.attemptId !== null).length;

export const toEvaluation = (e: MockEvaluation) => ({
  id: e.id,
  classroomId: e.classroomId,
  title: e.title,
  mode: e.mode,
  state: e.state,
  settings: e.settings,
  // The server's `drillAllowed` (ADR-041 §2): the setting, else the mode's default.
  allowDrill:
    e.mode !== "poll" &&
    (typeof e.settings["allowDrill"] === "boolean" ? e.settings["allowDrill"] : e.mode === "exercise"),
  gradingScale: e.gradingScale,
  feedbackPolicy: e.feedbackPolicy,
  mcqPolicy: e.mcqPolicy,
  opensAt: e.opensAt,
  closesAt: e.closesAt,
  durationS: e.durationS,
  accessCode: e.accessCode,
  ipAllowlist: e.ipAllowlist,
  startedAt: e.startedAt,
  pausedAt: e.pausedAt,
  closedAt: e.closedAt,
  releasedAt: e.releasedAt,
  correctionPublishedAt: e.correctionPublishedAt,
  modifiedAfterRelease: e.modifiedAfterRelease,
  createdAt: e.createdAt,
  originRevision: e.originRevision,
});

/**
 * THE template of an instance, as the server reads it (F-EVAL-26): its
 * origin, provided it is a template of the classroom's own course — what the
 * badge's revision and the pull both go through.
 */
function templateOfInstance(e: MockEvaluation): MockTemplate | null {
  const courseId = rooms.find((r) => r.id === e.classroomId)?.courseId;
  return templates.find((x) => x.id === e.originTemplateId && x.courseId === courseId) ?? null;
}

const templateRevisionOf = (e: MockEvaluation): number | null => templateOfInstance(e)?.revision ?? null;

/**
 * The server's `inLinkedPool` (F-EVAL-01): the item's question sits in a pool
 * the course links. A question with no pool left is as unlinked as one whose
 * pool left the course.
 */
function inLinkedPool(item: MockItem, courseId: string): boolean {
  const poolId = itemQuestion(item)?.poolId ?? null;
  return poolId !== null && (coursePools[courseId] ?? []).includes(poolId);
}

const evaluationSummary = (e: MockEvaluation) => ({
  id: e.id,
  classroomId: e.classroomId,
  title: e.title,
  mode: e.mode,
  state: e.state,
  itemCount: e.items.length,
  totalPoints: totalPointsOf(e),
  attemptCount: attemptCountOf(e),
  opensAt: e.opensAt,
  closesAt: e.closesAt,
  createdAt: e.createdAt,
  originRevision: e.originRevision,
  templateRevision: templateRevisionOf(e),
});

/**
 * The reader's own seat and test attempt (ADR-018). The seat is read off the
 * classroom roster, exactly as the server reads it off `enrollments`, so
 * clicking "Join as student" here really changes what the button does next.
 */
const selfOf = (e: MockEvaluation) => {
  const seat = (rooms.find((r) => r.id === e.classroomId)?.roster ?? []).find(
    (s) => me !== null && s.email.toLowerCase() === me.email.toLowerCase(),
  );
  return {
    seat: seat !== undefined,
    staffSeat: seat?.staff ?? false,
    attemptId: e.rows.find((r) => r.staff)?.attemptId ?? null,
  };
};

/**
 * The launch checklist's roster counts (#152), read off the classroom roster
 * as the server reads `enrollments`: class seats only for the two flags, and
 * the lobby ring's denominator — the class plus the staff seats that took an
 * attempt — for `enrolled`.
 */
const rosterOf = (e: MockEvaluation) => {
  const seats = (rooms.find((r) => r.id === e.classroomId)?.roster ?? []).filter((s) => !s.staff);
  return {
    enrolled: seats.length + e.rows.filter((r) => r.staff && r.attemptId !== null).length,
    unlinked: seats.filter((s) => s.userId === null).length,
    conflicts: seats.filter((s) => s.conflictFlag).length,
  };
};

/** What an item list says about itself, for an evaluation and a template alike. */
const itemListFacts = (e: MockEvaluation) => ({
  totalPoints: totalPointsOf(e),
  staleItems: e.items
    .filter((i) => i.latestVersionNumber !== null && i.latestVersionNumber > i.versionNumber)
    .map((i) => i.id),
  // Like the server: the questions whose pool this reader may write (#127).
  editableQuestionIds: e.items.flatMap((i) => {
    const q = itemQuestion(i);
    return q && q.poolId && poolSummary(poolOr404(q.poolId)).role !== "reader" ? [q.id] : [];
  }),
});

const evaluationDetail = (e: MockEvaluation) => ({
  evaluation: toEvaluation(e),
  items: e.items.map((i) => ({ ...i })),
  ...itemListFacts(e),
  attemptCount: attemptCountOf(e),
  editable: isConfigEditable(e.state, attemptCountOf(e)),
  self: selfOf(e),
  roster: rosterOf(e),
  templateRevision: templateRevisionOf(e),
  courseId: rooms.find((r) => r.id === e.classroomId)?.courseId ?? "",
});

export const dashboardView = (e: MockEvaluation, includeAnswers: boolean) => {
  // Every denominator is the CLASS: a teacher's own test walk is a row and
  // not a total (ADR-018).
  const classRows = e.rows.filter((r) => !r.staff);
  const started = classRows.filter((r) => r.attemptId !== null).length;
  return {
    evaluation: {
      id: e.id,
      state: e.state,
      startedAt: e.startedAt,
      pausedAt: e.pausedAt,
      closesAt: e.closesAt,
      serverNow: iso(0),
      // The server's `reopenRefusal`: retakes on, or the correction published.
      reopenable: !retakesOnMock(e) && e.correctionPublishedAt === null,
    },
    items: e.items.map((i) => ({
      id: i.id,
      position: i.position,
      points: i.points,
      type: i.type,
      internalName: i.internalName,
      milestone: i.milestone,
    })),
    rows: e.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => ({ ...c, summary: includeAnswers ? c.summary : null })),
    })),
    totals: e.items.map((item) => {
      const done = classRows.filter((r) => {
        const status = r.cells.find((c) => c.itemId === item.id)?.status;
        return status !== undefined && countsAsCompleted(status);
      }).length;
      const graded = classRows
        .map((r) => r.cells.find((c) => c.itemId === item.id))
        .filter((c) => c?.verdict != null);
      const rate =
        graded.length === 0
          ? null
          : round2(
              graded.reduce(
                (sum, c) => sum + (c!.verdict === "correct" ? 1 : c!.verdict === "partial" ? 0.5 : 0),
                0,
              ) / graded.length,
            );
      return {
        itemId: item.id,
        completion: started === 0 ? 0 : round2(done / started),
        successRate: rate,
        provisional: rate !== null,
      };
    }),
  };
};

export const attemptInspect = (e: MockEvaluation, attemptId: string) => {
  const row = e.rows.find((r) => r.attemptId === attemptId);
  if (!row) throw new MockError(404, "Attempt not found");
  // The seed the row's cells were summarised with (`makeRows`), so the paper
  // read here is the answer the cell's glyph and its tooltip describe.
  const rowIndex = e.rows.indexOf(row);
  return {
    attempt: {
      id: attemptId,
      userId: row.userId,
      displayName: row.displayName,
      pseudonym: row.pseudonym,
      state: row.state,
      startedAt: e.startedAt,
      deadlineAt: row.deadlineAt,
      submittedAt: row.state === "submitted" ? iso(-60_000) : null,
    },
    items: e.items.flatMap((item, i) => {
      const q = itemQuestion(item);
      if (q === null) return [];
      const cell = row.cells.find((c) => c.itemId === item.id);
      return [{
        item: {
          id: item.id,
          position: item.position,
          points: item.points,
          type: item.type,
          internalName: item.internalName,
        },
        studentConfig: studentConfigOf(q),
        answer:
          cell && (cell.status === "in_progress" || cell.status === "done")
            ? answerOf(q, rowIndex + i)
            : null,
        revision: cell?.revision ?? 0,
        markedDone: cell?.status === "done",
        skipped: cell?.status === "skipped",
        flagged: cell?.flagged ?? false,
        solution: solutionOf(q),
      }];
    }),
    events: [{ kind: "visibility" as const, at: iso(-120_000), details: null }],
    serverNow: iso(0),
  };
};

/**
 * F-DASH-07: one question's answers for the class, read from the same papers
 * the inspector reads — so a card says what the cell and its paper say.
 */
export const itemAnswers = (e: MockEvaluation, itemId: string) => {
  const item = e.items.find((i) => i.id === itemId);
  if (!item) throw new MockError(404, "Item not found");
  const answers = e.rows.flatMap((row) => {
    if (row.attemptId === null) return [];
    const entry = attemptInspect(e, row.attemptId).items.find((i) => i.item.id === itemId);
    if (!entry) return [];
    const { item: _item, markedDone: _done, ...answer } = entry;
    return [{ attemptId: row.attemptId, ...answer }];
  });
  return {
    item: {
      id: item.id,
      position: item.position,
      points: item.points,
      type: item.type,
      internalName: item.internalName,
    },
    answers,
    serverNow: iso(0),
  };
};

// --- Routes: evaluations --------------------------------------------------

on("GET", "/app/api/classrooms/:id/evaluations", (m) =>
  evaluations.filter((e) => e.classroomId === m.groups!.id).map(evaluationSummary),
);
on("POST", "/app/api/classrooms/:id/evaluations", (m, body) => {
  const e = makeEvaluation(
    roomOr404(m.groups!.id!).id,
    String(body.title),
    "draft",
    0,
    {
      mode: (body.mode as MockEvaluation["mode"]) ?? "exam",
      // Seeded from the creator's preference, exactly like `createEvaluation`.
      mcqPolicy: me?.mcqPolicy ?? "all_or_nothing",
    },
  );
  evaluations.push(e);
  return toEvaluation(e);
});
on("GET", "/app/api/evaluations/:id", (m) => evaluationDetail(evaluationOr404(m.groups!.id!)));
/** The picker's pools: the course's own, like the server (F-EVAL-01), by name. */
const coursePoolList = (courseId: string) =>
  (coursePools[courseId] ?? [])
    .map((id) => poolSummary(poolOr404(id)))
    .sort((a, b) => a.name.localeCompare(b.name));

on("GET", "/app/api/evaluations/:id/pools", (m) =>
  coursePoolList(roomOr404(evaluationOr404(m.groups!.id!).classroomId).courseId),
);
on("PATCH", "/app/api/evaluations/:id", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  // #86: what a patch may touch is the domain's `configLock`, as on the server.
  const lock = configLock(e.state, attemptCountOf(e));
  if (Object.keys(body).some((k) => !isConfigFieldWritable(lock, k))) {
    throw new MockPayload(
      409,
      lock === "running"
        ? {
            error: "running_locked",
            message: "the evaluation is running: its configuration is locked until it closes",
          }
        : { error: "locked", message: "an attempt exists: the structure is frozen" },
    );
  }
  // A poll's feedback moves with its reveal, through the poll route only (#86).
  if (e.mode === "poll" && body.feedbackPolicy !== undefined) {
    throw new MockPayload(409, {
      error: "poll_feedback_locked",
      message: "a poll's feedback follows its reveal: use the poll's reveal route",
    });
  }
  assertConfigPatch(e, body);
  applyConfigPatch(e, body);
  if ("opensAt" in body) e.opensAt = body.opensAt as string | null;
  if ("closesAt" in body) e.closesAt = body.closesAt as string | null;
  return evaluationDetail(e);
});

/**
 * The server's refusals of a configuration patch that do not depend on a run
 * (F-EVAL-15, F-EVAL-11): an evaluation's and a template's alike.
 */
function assertConfigPatch(e: MockEvaluation, body: Record<string, unknown>): void {
  const settings = body.settings as
    | { lobby?: LobbyName; retakes?: { enabled?: boolean } }
    | undefined;
  // ADR-079: a poll has no conditions, as on the server.
  if (e.mode === "poll" && Array.isArray(body.settings && (body.settings as { conditions?: unknown }).conditions)) {
    if (((body.settings as { conditions: unknown[] }).conditions).length > 0) {
      throw new MockPayload(422, {
        error: "conditions_not_allowed",
        message: `an evaluation of mode "${e.mode}" has no conditions (ADR-079)`,
      });
    }
  }
  // F-EVAL-15: an exam takes one attempt, as on the server.
  if (settings?.retakes?.enabled === true && e.mode !== "exercise") {
    throw new MockPayload(422, {
      error: "retakes_not_allowed",
      message: `an evaluation of mode "${e.mode}" takes one attempt (F-EVAL-15)`,
    });
  }
  const feedback = body.feedbackPolicy as { when?: FeedbackWhen } | undefined;
  // F-EVAL-11, #78: the server refuses `immediate` in class, whichever half
  // of the pair the patch moves, and writes nothing.
  if (feedback?.when !== undefined || settings?.lobby !== undefined) {
    const lobby = settings?.lobby ?? (e.settings as { lobby: LobbyName }).lobby;
    const when = feedback?.when ?? (e.feedbackPolicy as { when: FeedbackWhen }).when;
    if (!isFeedbackAllowed({ mode: e.mode, lobby }, when)) {
      throw new MockPayload(422, {
        error: "feedback_not_allowed",
        message: `feedback "${when}" is not allowed for an evaluation sat in class (F-EVAL-11)`,
      });
    }
  }
}

/** The fields an evaluation and a template share, written. */
function applyConfigPatch(e: MockEvaluation, body: Record<string, unknown>): void {
  if (typeof body.title === "string") e.title = body.title;
  if (body.settings) e.settings = { ...e.settings, ...(body.settings as object) };
  if (body.feedbackPolicy) {
    e.feedbackPolicy = { ...e.feedbackPolicy, ...(body.feedbackPolicy as object) };
  }
  if (body.gradingScale) e.gradingScale = body.gradingScale as Record<string, unknown>;
  if (body.mcqPolicy) e.mcqPolicy = body.mcqPolicy as McqScorePolicy;
  if ("durationS" in body) e.durationS = body.durationS as number | null;
}
on("DELETE", "/app/api/evaluations/:id", (m) => {
  const i = evaluations.findIndex((e) => e.id === m.groups!.id);
  if (i >= 0) evaluations.splice(i, 1);
  return undefined;
});
on("POST", "/app/api/evaluations/:id/duplicate", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const copy = makeEvaluation(e.classroomId, String(body.title), "draft", e.items.length, {
    mode: e.mode,
  });
  evaluations.push(copy);
  return toEvaluation(copy);
});

// --- Templates (ADR-031) ---------------------------------------------------
//
// A template is an evaluation kept at the course level. Here it is a shell
// evaluation that no classroom lists, plus the few fields the list shows;
// "Use in a classroom" copies the shell into a new draft, like the server.

interface MockTemplate {
  id: string;
  courseId: string;
  revision: number;
  shell: MockEvaluation;
}

const templates: MockTemplate[] = [];
templateCount.of = (courseId) => templates.filter((x) => x.courseId === courseId).length;

function makeTemplate(courseId: string, source: MockEvaluation): MockTemplate {
  const shell: MockEvaluation = {
    ...source,
    id: uuid(),
    classroomId: "",
    state: "draft",
    opensAt: null,
    closesAt: null,
    accessCode: null,
    ipAllowlist: [],
    startedAt: null,
    pausedAt: null,
    closedAt: null,
    releasedAt: null,
    correctionPublishedAt: null,
    rows: [],
    present: 0,
    items: source.items.map((item) => ({ ...item, id: uuid() })),
  };
  return { id: shell.id, courseId, revision: 1, shell };
}

export const templateOr404 = (id: string) => {
  const found = templates.find((x) => x.id === id);
  if (!found) throw new MockError(404, "Template not found");
  return found;
};

const templateSummary = (x: MockTemplate) => ({
  id: x.id,
  courseId: x.courseId,
  title: x.shell.title,
  mode: x.shell.mode === "poll" ? "exam" : x.shell.mode,
  revision: x.revision,
  itemCount: x.shell.items.length,
  totalPoints: totalPointsOf(x.shell),
});

/**
 * `GET /templates/:id` (F-EVAL-25): the template with its configuration, and
 * its items flagged, like the server, when their pool left the course.
 */
export const templateDetail = (x: MockTemplate) => {
  const e = x.shell;
  return {
    template: {
      ...templateSummary(x),
      settings: e.settings,
      gradingScale: e.gradingScale,
      feedbackPolicy: e.feedbackPolicy,
      mcqPolicy: e.mcqPolicy,
      durationS: e.durationS,
    },
    items: e.items.map((i) => ({ ...i, poolUnlinked: !inLinkedPool(i, x.courseId) })),
    ...itemListFacts(e),
  };
};

// Two templates on the first course, so the course card and the "Start from"
// choice of a new evaluation have something to show (none under `?empty=1`).
if (!flags.empty) {
  const room = rooms[0];
  if (room) {
    const exam = makeTemplate(
      room.courseId,
      makeEvaluation(room.id, "Examen final — programmation C", "draft", 8, {
        createdAt: iso(-300 * D),
      }),
    );
    const series = makeTemplate(
      room.courseId,
      makeEvaluation(room.id, "Série d'exercices — pointeurs", "draft", 5, {
        mode: "exercise",
        durationS: null,
        createdAt: iso(-200 * D),
      }),
    );
    templates.push(exam, series);
    // F-EVAL-26: this classroom's series was made from the template at rev. 1,
    // and the template has moved twice since — the question whose pool left
    // the course dropped, a weight changed, a question moved to its latest
    // version — so the list's badge, the launch checklist's warning and the
    // confirmation's summary can be seen without editing anything. (The
    // exam template keeps its unlinked question: its editor shows the flag.)
    instantiate(series, room.id, "Série d'exercices — pointeurs, classe A", {
      id: TEMPLATE_INSTANCE_ID,
      createdAt: iso(-20 * D),
      // The instance's own timing, which a pull never touches.
      durationS: 45 * 60,
    });
    series.shell.items = series.shell.items.filter((i) => inLinkedPool(i, room.courseId));
    series.shell.items.forEach((i, index) => (i.position = index));
    series.shell.items[0]!.points += 1;
    const stale = series.shell.items.find((i) => (i.latestVersionNumber ?? 0) > i.versionNumber);
    if (stale) stale.versionNumber = stale.latestVersionNumber!;
    series.revision = 3;
  }
}

on("GET", "/app/api/courses/:id/templates", (m) =>
  templates.filter((x) => x.courseId === m.groups!.id).map(templateSummary),
);
on("POST", "/app/api/evaluations/:id/template", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  if (e.mode === "poll") {
    throw new MockPayload(422, { error: "template_poll", message: "a poll cannot be saved as a template" });
  }
  const created = makeTemplate(roomOr404(e.classroomId).courseId, { ...e, title: String(body.title) });
  created.shell.createdAt = iso(0);
  templates.unshift(created);
  return templateSummary(created);
});
on("DELETE", "/app/api/templates/:id", (m) => {
  const i = templates.findIndex((x) => x.id === m.groups!.id);
  if (i >= 0) templates.splice(i, 1);
  // The instances keep running and lose their link (`ON DELETE SET NULL`).
  for (const e of evaluations) if (e.originTemplateId === m.groups!.id) e.originTemplateId = null;
  return undefined;
});
/** "Instantiate": a draft of the template in `roomId`, recording where it came from. */
function instantiate(
  template: MockTemplate,
  roomId: string,
  title: string,
  extra: Partial<MockEvaluation> = {},
) {
  const made = makeEvaluation(roomId, title, "draft", 0, {
    createdAt: iso(0),
    mode: template.shell.mode,
    settings: template.shell.settings,
    gradingScale: template.shell.gradingScale,
    feedbackPolicy: template.shell.feedbackPolicy,
    mcqPolicy: template.shell.mcqPolicy,
    durationS: template.shell.durationS,
    originTemplateId: template.id,
    originRevision: template.revision,
    ...extra,
  });
  made.items = template.shell.items.map((item) => ({ ...item, id: uuid() }));
  evaluations.push(made);
  return made;
}

on("POST", "/app/api/templates/:id/instances", (m, body) => {
  const template = templateOr404(m.groups!.id!);
  const room = roomOr404(String(body.classroomId));
  if (room.courseId !== template.courseId) throw new MockError(404, "Classroom not found");
  const made = instantiate(template, room.id, String(body.title ?? template.shell.title));
  return { evaluation: toEvaluation(made), deprecatedItems: [] };
});

// --- Pulling a template revision (F-EVAL-26) ----------------------------------

/** The instance's template, as the server reads it: of the classroom's course, or none. */
function pullSource(e: MockEvaluation): MockTemplate {
  const template = templateOfInstance(e);
  if (!template) {
    throw new MockPayload(409, { error: "no_template", message: "the evaluation has no template to pull from" });
  }
  return template;
}

const itemRefOf = (i: MockItem) => ({
  position: i.position,
  questionId: i.questionId,
  internalName: i.internalName,
});

/** A copy's warning: the items frozen on a version marked deprecated. */
const deprecatedRefs = (items: readonly MockItem[]) => items.filter((i) => i.deprecated).map(itemRefOf);

/** A copy's refusal: the items whose pool the course no longer links. */
const unlinkedRefs = (template: MockTemplate) =>
  template.shell.items.filter((i) => !inLinkedPool(i, template.courseId)).map(itemRefOf);

on("GET", "/app/api/evaluations/:id/pull-template", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  const template = pullSource(e);
  const pullItem = (i: MockItem) => ({
    ...itemRefOf(i),
    versionNumber: i.versionNumber,
    points: i.points,
    milestone: i.milestone,
    bonus: i.bonus,
    intro: i.intro,
  });
  return {
    templateId: template.id,
    templateTitle: template.shell.title,
    from: e.originRevision,
    to: template.revision,
    ...itemListDiff(e.items.map(pullItem), template.shell.items.map(pullItem)),
    deprecatedItems: deprecatedRefs(template.shell.items),
    unlinkedItems: unlinkedRefs(template),
  };
});

on("POST", "/app/api/evaluations/:id/pull-template", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  const template = pullSource(e);
  if (body.revision !== template.revision) {
    throw new MockPayload(409, {
      error: "template_moved",
      message: "the template has a newer revision than the one confirmed",
      revision: template.revision,
    });
  }
  assertItemListEditable(e);
  const unlinked = unlinkedRefs(template);
  if (unlinked.length > 0) {
    throw new MockPayload(422, {
      error: "template_pool_unlinked",
      message: "some questions are in a pool not linked to the target course",
      items: unlinked,
    });
  }
  if (e.state === "scheduled" && template.shell.items.length === 0) {
    throw new MockPayload(409, {
      error: "illegal_transition",
      message: "an evaluation needs at least one question",
      reason: "no_items",
    });
  }
  // The questions only: everything else of the instance stays its own.
  e.items = template.shell.items.map((item) => ({ ...item, id: uuid() }));
  e.originRevision = template.revision;
  return {
    detail: evaluationDetail(e),
    deprecatedItems: deprecatedRefs(template.shell.items),
  };
});

/**
 * The item-list gate of the API (issue #79), with the same codes: the screen
 * disables its controls, and a stale tab that still tries is refused here
 * exactly as it would be for real.
 */
const ATTEMPTS_REFUSAL = {
  locked: "an attempt exists: the structure is frozen",
  attempts_exist: "versions cannot be updated once an attempt exists",
} as const;

function assertItemListEditable(
  e: MockEvaluation,
  onAttempts: keyof typeof ATTEMPTS_REFUSAL = "locked",
): void {
  const lock = itemListLock(e.state, attemptCountOf(e));
  if (lock === "attempts") {
    throw new MockPayload(409, { error: onAttempts, message: ATTEMPTS_REFUSAL[onAttempts] });
  }
  if (lock === "opened") {
    throw new MockPayload(409, {
      error: "items_frozen",
      message: "the evaluation has been opened: its questions are frozen",
    });
  }
}

// --- Item lists, an evaluation's or a template's -----------------------------
//
// The edits themselves, written once: the evaluation routes gate them with
// the item-list lock, the template routes move the revision after them.

function updateVersionsOf(e: MockEvaluation, ids: string[] | null): void {
  for (const item of e.items) {
    if (ids !== null && !ids.includes(item.id)) continue;
    if (item.latestVersionNumber !== null) item.versionNumber = item.latestVersionNumber;
  }
}

function addItemsTo(e: MockEvaluation, questionIds: string[]): void {
  for (const questionId of questionIds) {
    const q = questions.find((x) => x.id === questionId);
    const latest = q?.versions.at(-1);
    // A question that was never published cannot be added: the picker shows
    // it disabled, and the API refuses it too (F-EVAL-03).
    if (!q || !latest) continue;
    // A question kept after an opinion poll has no key: polls only.
    if (isKeyless(q)) {
      throw new MockPayload(422, {
        error: "question_keyless",
        message: `question ${q.id} has no correct answer: polls only`,
      });
    }
    e.items.push({
      id: uuid(),
      position: e.items.length,
      points: q.type === "code" ? 3 : 1,
      milestone: false,
      bonus: false,
      intro: null,
      questionId: q.id,
      questionVersionId: uuid(),
      type: q.type,
      internalName: q.internalName,
      versionNumber: latest.number,
      latestVersionNumber: latest.number,
      deprecated: latest.deprecatedAt !== null,
    });
  }
}

function patchItemOf(e: MockEvaluation, itemId: string, body: Record<string, unknown>) {
  const item = e.items.find((i) => i.id === itemId);
  if (!item) throw new MockError(404, "Item not found");
  if (typeof body.points === "number") item.points = body.points;
  if (typeof body.milestone === "boolean") item.milestone = body.milestone;
  if (typeof body.bonus === "boolean") item.bonus = body.bonus;
  if (typeof body.intro === "string" || body.intro === null) {
    item.intro = typeof body.intro === "string" && body.intro.trim() !== "" ? body.intro : null;
  }
  return item;
}

function reorderItemsOf(e: MockEvaluation, order: string[]): void {
  e.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  e.items.forEach((i, index) => (i.position = index));
}

function removeItemOf(e: MockEvaluation, itemId: string): void {
  e.items = e.items.filter((i) => i.id !== itemId);
  e.items.forEach((i, index) => (i.position = index));
}

on("POST", "/app/api/evaluations/:id/items/update-versions", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e, "attempts_exist");
  updateVersionsOf(e, (body.itemIds as string[] | undefined) ?? null);
  return e.items.map((i) => ({ ...i }));
});
on("POST", "/app/api/evaluations/:id/items", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  addItemsTo(e, (body.questionIds as string[] | undefined) ?? []);
  return e.items.map((i) => ({ ...i }));
});
on("PATCH", "/app/api/evaluations/:id/items/:itemId", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  return { ...patchItemOf(e, m.groups!.itemId!, body) };
});
on("PUT", "/app/api/evaluations/:id/items/order", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  reorderItemsOf(e, (body.itemIds as string[]) ?? []);
  return e.items.map((i) => ({ ...i }));
});
on("DELETE", "/app/api/evaluations/:id/items/:itemId", (m) => {
  const e = evaluationOr404(m.groups!.id!);
  assertItemListEditable(e);
  removeItemOf(e, m.groups!.itemId!);
  return undefined;
});

// --- Editing a template in place (F-EVAL-25) ---------------------------------
//
// The same edits under `/templates/:id/...`, each answering the whole
// `TemplateDetail`, and moving the revision by one when the content moved —
// anything but the title, as on the server (ADR-031, addendum d).

/**
 * The content the revision follows: the items (order, points, milestones,
 * bonus flags, versions) and every stored setting — everything but the title.
 */
const contentOf = (e: MockEvaluation) =>
  JSON.stringify([
    e.items.map((i) => [i.id, i.points, i.milestone, i.bonus, i.intro, i.versionNumber]),
    e.settings,
    e.gradingScale,
    e.feedbackPolicy,
    e.mcqPolicy,
    e.durationS,
  ]);

/** One write to a template, moving the revision once when the content moved. */
function templateWrite(id: string, edit: (e: MockEvaluation) => void) {
  const template = templateOr404(id);
  const before = contentOf(template.shell);
  edit(template.shell);
  if (contentOf(template.shell) !== before) template.revision += 1;
  return templateDetail(template);
}

on("POST", "/app/api/courses/:id/templates", (m, body) => {
  const course = courses.find((c) => c.id === m.groups!.id);
  if (!course) throw new MockError(404, "Course not found");
  if (body.mode === "poll") {
    throw new MockPayload(422, { error: "template_poll", message: "a poll cannot be a template" });
  }
  const made = makeTemplate(
    course.id,
    makeEvaluation("", String(body.title), "draft", 0, {
      mode: (body.mode as MockEvaluation["mode"]) ?? "exam",
      mcqPolicy: me?.mcqPolicy ?? "all_or_nothing",
      createdAt: iso(0),
    }),
  );
  templates.unshift(made);
  return templateSummary(made);
});
on("GET", "/app/api/templates/:id", (m) => templateDetail(templateOr404(m.groups!.id!)));
on("GET", "/app/api/templates/:id/pools", (m) =>
  coursePoolList(templateOr404(m.groups!.id!).courseId),
);
on("PATCH", "/app/api/templates/:id", (m, body) =>
  templateWrite(m.groups!.id!, (e) => {
    // The route's own schema: strict, so a run field is a 400 (ADR-031, addendum c).
    const parsed = TemplatePatch.safeParse(body);
    if (!parsed.success) throw new MockError(400, parsed.error.message);
    assertConfigPatch(e, body);
    applyConfigPatch(e, body);
  }),
);
on("POST", "/app/api/templates/:id/items/update-versions", (m, body) =>
  templateWrite(m.groups!.id!, (e) =>
    updateVersionsOf(e, (body.itemIds as string[] | undefined) ?? null),
  ),
);
on("POST", "/app/api/templates/:id/items", (m, body) =>
  templateWrite(m.groups!.id!, (e) =>
    addItemsTo(e, (body.questionIds as string[] | undefined) ?? []),
  ),
);
on("PATCH", "/app/api/templates/:id/items/:itemId", (m, body) =>
  templateWrite(m.groups!.id!, (e) => void patchItemOf(e, m.groups!.itemId!, body)),
);
on("PUT", "/app/api/templates/:id/items/order", (m, body) =>
  templateWrite(m.groups!.id!, (e) => reorderItemsOf(e, (body.itemIds as string[]) ?? [])),
);
on("DELETE", "/app/api/templates/:id/items/:itemId", (m) =>
  templateWrite(m.groups!.id!, (e) => removeItemOf(e, m.groups!.itemId!)),
);
on("POST", "/app/api/evaluations/:id/state", (m, body) => {
  const e = evaluationOr404(m.groups!.id!);
  // The server's readiness refusals (`guardTransition`), with the same
  // body, so the launch step's translated messages can be seen here (#76).
  if (body.to !== "draft") {
    if (e.items.length === 0) {
      throw new MockPayload(409, {
        error: "illegal_transition",
        message: "an evaluation needs at least one question",
        reason: "no_items",
      });
    }
    const missing = missingTimingFields({
      mode: e.mode,
      timing: (e.settings as { timing: EvaluationTiming }).timing,
      durationS: e.durationS,
      opensAt: e.opensAt,
      closesAt: e.closesAt,
    });
    if (missing.length > 0) {
      throw new MockPayload(409, {
        error: "illegal_transition",
        message: `the timing settings are incomplete (F-EVAL-04): ${missing.join(", ")}`,
        reason: "timing_incomplete",
        missing,
      });
    }
  }
  if (body.to === "scheduled" && e.opensAt === null) {
    throw new MockPayload(409, {
      error: "illegal_transition",
      message: "a scheduled evaluation needs an opening time",
      reason: "opens_at_missing",
    });
  }
  const past = pastTiming(
    { timing: (e.settings as { timing: EvaluationTiming }).timing, opensAt: e.opensAt, closesAt: e.closesAt },
    e.state,
    body.to as MockEvaluation["state"],
    new Date(),
  );
  if (past) {
    throw new MockPayload(409, { error: "illegal_transition", message: past, reason: past });
  }
  e.state = body.to as MockEvaluation["state"];
  return toEvaluation(e);
});

/*
 * `POST /questions/move` is a route of section 2, and it is registered here
 * because it is the one pool route that reads the EVALUATIONS playing a
 * question (ADR-017's 409). Keeping it in `pool.ts` would make the pool
 * import the evaluations that are built on top of it.
 */
/**
 * `POST /questions/move` (ADR-017): the question keeps its id and changes
 * pool. The mock reproduces the three refusals the screens branch on — a
 * classroom that plays the question while the target pool is not one of its
 * course's, a course this browser is not staff of, and a name already taken
 * there — because each of them is a different dialog.
 */
on("POST", "/app/api/questions/move", (_m, body) => {
  const ids = ((body.questionIds as string[]) ?? []).filter((id, i, all) => all.indexOf(id) === i);
  const moving = ids.map(questionOr404);
  const target = poolOr404(String(body.targetPoolId));
  const writable = (poolId: string) => poolSummary(poolOr404(poolId)).role !== "reader";
  if (!writable(target.id) || moving.some((q) => !writable(q.poolId))) {
    throw new MockError(403, "Read-only access");
  }
  const categoryId = (body.categoryId as string | null | undefined) ?? null;
  if (categoryId !== null && !categories.some((c) => c.id === categoryId && c.poolId === target.id)) {
    throw new MockError(404, "Category not found");
  }

  // Which courses play one of these questions without drawing from the target.
  const blocking = new Map<string, Record<string, unknown>>();
  for (const evaluation of evaluations) {
    if (!evaluation.items.some((item) => ids.includes(item.questionId))) continue;
    const room = rooms.find((r) => r.id === evaluation.classroomId);
    const course = courses.find((c) => c.id === room?.courseId);
    if (!room || !course) continue;
    if ((coursePools[course.id] ?? []).includes(target.id)) continue;
    const entry = blocking.get(course.id) ?? {
      courseId: course.id,
      courseName: course.name,
      courseCode: course.code,
      classrooms: [] as { id: string; name: string }[],
      // As the server does (ADR-068): a seat reaches the course, an owner's links to it.
      reached: course.staff.some((s) => s.userId === (me?.id ?? "u-me")),
      mayLink: course.staff.some((s) => s.userId === (me?.id ?? "u-me") && s.role === "owner"),
    };
    const listed = entry.classrooms as { id: string; name: string }[];
    if (!listed.some((x) => x.id === room.id)) listed.push({ id: room.id, name: room.name });
    blocking.set(course.id, entry);
  }
  const blocked = [...blocking.values()];
  // As the server does: a course the caller cannot open is named by its code only.
  const asSeen = ({ reached, ...c }: Record<string, unknown>) =>
    reached === true
      ? c
      : { courseId: null, courseName: null, courseCode: c.courseCode, classrooms: [], mayLink: false };
  let linkedCourseIds: string[] = [];
  if (blocked.length > 0) {
    if (body.linkCourses !== true) {
      throw new MockPayload(409, {
        error: "pool_not_linked",
        message: "This question is used by a classroom whose course does not draw from that pool",
        courses: blocked.map(asSeen),
        names: [],
      });
    }
    const forbidden = blocked.filter((c) => c.mayLink !== true);
    if (forbidden.length > 0) {
      throw new MockPayload(409, {
        error: "course_forbidden",
        message: "Only an owner of that course may add this pool to it",
        courses: forbidden.map(asSeen),
        names: [],
      });
    }
    linkedCourseIds = blocked.map((c) => String(c.courseId));
    for (const courseId of linkedCourseIds) {
      coursePools[courseId] = [...new Set([...(coursePools[courseId] ?? []), target.id])];
    }
  }

  const taken = questions
    .filter((q) => q.poolId === target.id && !q.deletedAt && !ids.includes(q.id))
    .map((q) => q.internalName.toLowerCase());
  const clashing = moving
    .filter((q) => taken.includes(q.internalName.toLowerCase()))
    .map((q) => q.internalName);
  if (clashing.length > 0) {
    throw new MockPayload(409, {
      error: "name_taken",
      message: "That internal name is already taken in the target pool",
      courses: [],
      names: clashing,
    });
  }

  for (const q of moving) {
    q.poolId = target.id;
    q.categoryId = categoryId;
    q.updatedAt = iso(0);
  }
  return {
    moved: moving.length,
    questionIds: ids,
    targetPoolId: target.id,
    categoryId,
    linkedCourseIds,
  };
});
