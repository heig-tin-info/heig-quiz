/** Section 4 of the mock — see `index.ts` for the layout. */
import {
  clozeStudentTemplate,
  parseCloze,
  studentProjectGroup,
  type StudentActivityGroup,
} from "@quiz/domain";
import type {
  AttemptView,
  AutosaveResponse,
  EvaluationCard,
  EvaluationGradeRow,
  GradeGroup,
  LobbyView,
  ProjectAcceptance,
  ProjectInvitationResent,
  StudentClassroomPage,
  StudentGrades,
  StudentHome as StudentHomeData,
  StudentProject,
  StudentProjectCard,
} from "@quiz/contracts";
import {
  D,
  H,
  MockError,
  MockPayload,
  flags,
  iso,
  mockCalculator,
  now,
  on,
  scene,
} from "./runtime";
import {
  CATEGORIZE_CONFIG,
  DIAGRAM_CONFIG,
  RC_STUDENT,
  RICH_CONFIG,
  ngspiceOutcome,
} from "./pool";
import { codeimageConfig, codeimageRunOutcome, codeimageStudentView } from "./codeimage";
import { richServer } from "@quiz/qt-rich/server";
import type { RichConfig } from "@quiz/qt-rich/client";
import { categorizeServer } from "@quiz/qt-categorize/server";
import type { CategorizeConfig } from "@quiz/qt-categorize/client";
import { diagramServer } from "@quiz/qt-diagram/server";
import type { DiagramConfig } from "@quiz/qt-diagram/client";
import { pollOfTeacher, teacherPolls } from "./poll";
import { hasMockJournal } from "./journal";
import { hasStudentGroups, studentGroupSetCards } from "./groups";
import { studentRooms } from "./org";

// --- 4. The student: home, lobby and player (WP9) --------------------------
//
// The student persona's scenes: a home with three evaluations, the lobby, a
// running attempt holding one question of every MVP type, a pause and a
// closure. `?scene=` (read in section 0) picks which one the fake backend
// serves:
//
//   ?scene=lobby | running | paused | closed | extend | single | marks | forward
//          | exercise                                 (running by default)
//
// `marks` is the question list of issue #89 with every state at once:
// answered, "won't answer", flagged, and nothing yet. `forward` is the same
// paper in `forward_only`, its first question validated and closed, so the
// "Validate and continue" step is on screen.
//
// `exercise` is the `running` paper as an EXERCISE: the player's bar then
// opens with its Home button (issue #125), which an exam never has.
//
// `single` serves the SAME attempt cut down to its first question: the
// one-question evaluation the player draws without a progress strip and
// without previous / next.
//
// `extend` is the teacher granting time: the fake stream pushes an
// `attempt.deadline` four seconds in, which is the only way to see the
// countdown jump without a backend.
//
// This one evaluation is NOT one of section 3's: it is the student's side of
// the story, with its own uuid, its own attempt and payloads written by hand
// rather than derived from a pool question — the player is the only screen
// that shows all four types at once, and the four are chosen to be read side
// by side. The teacher's evaluations stay addressable at the same time, so
// `/evaluations/running/live` and `/take/1111…` both work in one browser.
export const STUDENT_EVAL = "11111111-1111-4111-8111-111111111111";
const STUDENT_EVAL_NEXT = "11111111-1111-4111-8111-111111111112";
const STUDENT_EVAL_PAST = "11111111-1111-4111-8111-111111111113";
const STUDENT_EVAL_NEXT_TODAY = "11111111-1111-4111-8111-111111111121";
const STUDENT_EVAL_NEXT_TOMORROW = "11111111-1111-4111-8111-111111111122";
const STUDENT_EVAL_NEXT_WEEK = "11111111-1111-4111-8111-111111111123";
export const STUDENT_ATTEMPT = "22222222-2222-4222-8222-222222222222";
export const STUDENT_PAST_ATTEMPT = "22222222-2222-4222-8222-222222222223";
/** F-EVAL-15: an exercise the student already sat twice and may sit again. */
export const STUDENT_EVAL_RETAKE = "11111111-1111-4111-8111-111111111114";
export const STUDENT_RETAKE_ATTEMPT = "22222222-2222-4222-8222-222222222224";
/** Issue #203: a quiz handed in while it still runs, results not out yet. */
const STUDENT_EVAL_HANDED_IN = "11111111-1111-4111-8111-111111111115";
const STUDENT_HANDED_IN_ATTEMPT = "22222222-2222-4222-8222-222222222225";
/**
 * An exercise under the immediate policy, handed in, not released, two of its
 * questions still waiting for a grading: points only, no grade (F-RES-04).
 */
export const STUDENT_EARLY_ATTEMPT = "22222222-2222-4222-8222-222222222226";
const studentItem = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

/** The evaluation's state follows the scene; everything else is fixed. */
const studentEvaluationState = () =>
  scene === "lobby"
    ? ("lobby" as const)
    : scene === "paused"
      ? ("paused" as const)
      : ("running" as const);

/** One question of each MVP type, in French, as `toStudent` would publish it. */
const studentPayloads: Record<number, unknown> = {
  // The mcq whose choices hold a FENCED BLOCK, which is what the rich editor
  // can now write into one (markdown/tiptap.ts): a lead line and a snippet,
  // rendered by `MarkdownView` inside the label of the choice.
  1: {
    // A bulleted list and a numbered one, nested: the lists a teacher writes
    // in the editor have to reach the player as lists (issue #100).
    prompt:
      "Quel extrait affiche **l'adresse** de la variable `x` ?\n\n" +
      "- `x` est un `int` local ;\n" +
      "- l'adresse s'affiche avec `%p` :\n" +
      "  1. convertie en `void *`,\n" +
      "  2. sans autre calcul.",
    mode: "single",
    choices: [
      { id: 0, text: 'Avec l\'opérateur d\'adresse :\n\n```c\nprintf("%p\\n", (void *)&x);\n```' },
      { id: 1, text: 'Avec l\'opérateur d\'indirection :\n\n```c\nprintf("%p\\n", (void *)*x);\n```' },
      { id: 2, text: 'En convertissant la valeur :\n\n```c\nprintf("%p\\n", (void *)x);\n```' },
      { id: 3, text: 'Avec une fonction de la bibliothèque :\n\n```c\nprintf("%p\\n", addr(x));\n```' },
    ],
  },
  /*
   * Built by the REAL domain functions from a real config rather than written
   * out by hand: a dropdown inside a TABLE CELL has to reach the player
   * exactly as an inline one does, and a literal payload could not show that
   * it does.
   */
  2: clozeStudentTemplate(
    parseCloze(
      "Complétez la phrase.\n\n- L'orthographe des noms propres n'est pas notée ;\n- les unités s'écrivent au pluriel.\n\n" +
        "La loi d'{{Ohm|ohm}} relie la tension et le courant : pour un conducteur ohmique, " +
        "U = {{R|la résistance}} × I, où la tension U s'exprime en {{=volts|ampères|ohms|watts}}.\n\n" +
        "| Grandeur | Unité |\n" +
        "| --- | --- |\n" +
        "| Résistance | {{=ohms|volts|ampères}} |\n" +
        "| Courant | {{ohms|volts|=ampères}} |",
    ),
    0,
    "student-item-2",
    false,
  ),
  3: {
    prompt:
      "Sur une machine 64 bits compilant en LP64 :\n\n- un `long` occupe 8 octets ;\n- un pointeur aussi.\n\nCombien d'octets occupe un `int` en C ?",
    kind: "number",
    placeholder: "4",
  },
  /*
   * The one question of the mock that really RUNS. `runtime: "runno"` sends it
   * to the browser runner (`src/runner/`), so `pnpm dev:mock` — no API, no
   * container engine, nothing — compiles this C with clang.wasm and executes
   * the three cases for real. Which is the only honest way to look at the
   * screen: a stubbed outcome shows the markup, not the feature.
   *
   * The program takes its input from the COMMAND LINE, and the third case
   * checks nothing but the exit code, so the two things the case shape gained
   * are both on screen.
   */
  4: {
    prompt:
      // A list under a `whitespace-pre-wrap` host: the blank lines marked
      // writes between blocks must not show (issue #100).
      "Corrigez r_parallele pour qu'elle renvoie la résistance équivalente de deux résistances en parallèle, en ohms. Les deux valeurs arrivent sur la ligne de commande.\n\n- Un court-circuit doit renvoyer 0 ;\n- un appel sans les deux arguments doit sortir avec le code 2.",
    language: "c",
    runtime: "runno",
    segments: [
      {
        kind: "locked",
        index: null,
        text: "/* Résistance équivalente de deux résistances en parallèle, en ohms. */\n#include <stdio.h>\n#include <stdlib.h>\n",
      },
      {
        kind: "editable",
        index: 0,
        text: "double r_parallele(double r1, double r2)\n{\n    if (r1 == 0 || r2 == 0)\n        return 0;\n    return r1 * r2 / (r1 - r2);\n}\n",
      },
      {
        kind: "locked",
        index: null,
        text: 'int main(int argc, char **argv)\n{\n    if (argc != 3) {\n        fprintf(stderr, "usage: %s R1 R2\\n", argv[0]);\n        return 2;\n    }\n    printf("%.2f\\n", r_parallele(atof(argv[1]), atof(argv[2])));\n    return 0;\n}\n',
      },
    ],
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    runsPerMinute: 10,
    visibleCases: [
      {
        name: "deux résistances égales",
        args: ["100", "100"],
        stdin: "",
        expected: "50.00",
        compareStdout: true,
        expectedExitCode: 0,
        points: 1,
      },
      {
        name: "court-circuit",
        args: ["0", "470"],
        stdin: "",
        expected: "0.00",
        compareStdout: true,
        expectedExitCode: 0,
        points: 1,
      },
      {
        name: "arguments manquants",
        args: [],
        stdin: "",
        expected: "",
        compareStdout: false,
        expectedExitCode: 2,
        points: 1,
      },
    ],
    hiddenCount: 3,
    hiddenPoints: 3,
    filesPreview: [],
    allOrNothing: false,
  },
  /*
   * The `circuit` item: the student view of the pool question above, written
   * out here because this attempt is not built from the pool. What is NOT in
   * it is the point — no reference, no hidden stimulus, no tolerance
   * (invariant 4) — and `canSimulate` is what puts the button on the screen.
   */
  5: {
    prompt:
      "La sortie analogique du capteur est bruitée au-delà de quelques kilohertz. " +
      "Câblez entre l'entrée et la sortie du quadripôle un filtre **passe-bas** du " +
      "premier ordre, de fréquence de coupure 1 kHz.",
    palette: { kinds: ["R", "C", "L", "GND"], maxComponents: 4 },
    supplies: { vcc: null, vee: null },
    commonGround: true,
    visibleStimuli: [
      {
        name: "sinus 1 kHz",
        source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
        sourceOhms: 0,
        load: { kind: "resistor", ohms: 1_000_000 },
        analysis: { kind: "tran", stopMs: 5, skipMs: 0, points: 500 },
        points: 2,
      },
    ],
    hiddenCount: 1,
    hiddenPoints: 1,
    canSimulate: true,
    showExpected: false,
    simulationsPerMinute: 10,
  },
  /*
   * The `codeimage` item (ADR-021): the pool question's student view — the
   * target travels, the reference solution does not. Its runtime is the
   * server's, so "Run" goes through `POST /attempts/:id/simulate` below and
   * draws the mock's own picture of the student's attempt.
   */
  6: codeimageStudentView(codeimageConfig()),
  /*
   * The `rich` item (issue #192): an essay, whose rubric and model answer the
   * student view never carries — the pool question's own `toStudent`.
   */
  7: richServer.toStudent(RICH_CONFIG as RichConfig, { seed: 0, itemId: "7", shuffle: false }),
  /*
   * The `categorize` item (docs/04 §4.13): the columns without their key,
   * the cards in this student's shuffled order — the type's own `toStudent`.
   */
  8: categorizeServer.toStudent(CATEGORIZE_CONFIG as CategorizeConfig, { seed: 11, itemId: "8", shuffle: true }),
  /*
   * The `diagram` item (docs/04 §4.14): the kind and the starter, never the
   * reference — the type's own `toStudent`.
   */
  9: diagramServer.toStudent(DIAGRAM_CONFIG as DiagramConfig, { seed: 0, itemId: "9", shuffle: false }),
};

/** The attempt's mutable half: what the student typed, and where they are. */
interface StoredAnswer {
  payload: unknown;
  revision: number;
  done: boolean;
  skipped?: boolean;
  flagged?: boolean;
}
const studentAnswers = new Map<string, StoredAnswer>();
/*
 * The circuit item opens with something already on the canvas — the RC with
 * its ground wires missing. An empty box would show the empty state and
 * nothing else, and the strip under the drawing is half of what this type IS.
 */
studentAnswers.set(studentItem(5), { payload: { schematic: RC_STUDENT }, revision: 1, done: false });
// The essay opens half written, so the counter under the field has something to count.
studentAnswers.set(studentItem(7), {
  payload: {
    text:
      "Chaque appel de fonction empile un **cadre** : l'adresse de retour et les variables locales.\n\n" +
      "La pile a une taille fixe. Une récursion sans condition d'arrêt finit par",
  },
  revision: 1,
  done: false,
});
let studentPosition: string | null = studentItem(1);
if (scene === "marks" || scene === "forward") {
  // Q1 answered, Q2 left on purpose, Q3 flagged and still empty (where the
  // student is), Q4 flagged with an answer; Q5 answered, Q6 untouched.
  studentAnswers.set(studentItem(1), {
    payload: { selected: [1] },
    revision: 2,
    done: scene === "forward",
  });
  studentAnswers.set(studentItem(2), { payload: null, revision: 0, done: false, skipped: true });
  studentAnswers.set(studentItem(3), { payload: null, revision: 0, done: false, flagged: true });
  studentAnswers.set(studentItem(4), {
    payload: {
      regions: [
        "double r_parallele(double r1, double r2)\n{\n    if (r1 == 0 || r2 == 0)\n        return 0;\n    return r1 * r2 / (r1 + r2);\n}\n",
      ],
    },
    revision: 3,
    done: false,
    flagged: true,
  });
  studentPosition = studentItem(scene === "forward" ? 2 : 3);
}
export const BASE_DEADLINE = now + 14 * 60_000 + 32_000;
export let studentDeadline = BASE_DEADLINE;
/**
 * The fake SSE stream (`index.ts`) grants time on `?scene=extend`, which is
 * the only write to the deadline from outside this section.
 */
export const setStudentDeadline = (at: number) => {
  studentDeadline = at;
};

export const studentAttemptView = (): AttemptView => ({
  attempt: {
    id: STUDENT_ATTEMPT,
    // `closed` is the deadline case of F-LIVE-07: the server expired the
    // attempt while the evaluation itself is still running for the others.
    state: scene === "closed" ? "expired" : "in_progress",
    startedAt: iso(-6 * 60_000),
    deadlineAt: new Date(studentDeadline).toISOString(),
    lastItemId: studentPosition,
    serverNow: new Date().toISOString(),
    preview: false,
    readOnly: scene === "closed",
  },
  evaluation: {
    id: STUDENT_EVAL,
    title: "Quiz 3 — Pointeurs et lois fondamentales",
    mode: scene === "exercise" ? "exercise" : "exam",
    state: studentEvaluationState(),
    settings: {
      navigation: scene === "forward" ? "forward_only" : "free",
      presentation: "zen",
      lobby: "manual",
      shuffleItems: false,
      shuffleChoices: true,
      timing: "duration",
      showProgressBar: true,
      logVisibility: true,
      requireFullscreen: false,
      ...(flags.negative ? { negativeMarking: true } : {}),
      ...mockCalculator(),
    },
    feedbackPolicy: {
      when: "on_release",
      showAnswer: true,
      showKey: false,
      showExplanation: false,
      showHiddenCaseNames: true,
      showTeacherComment: true,
    },
    pausedAt: scene === "paused" ? iso(-30_000) : null,
    totalPoints: 10,
  },
  items: (scene === "single" ? [1] : [1, 2, 3, 4, 5, 6, 7, 8, 9]).map((n) => {
    const stored = studentAnswers.get(studentItem(n));
    return {
      id: studentItem(n),
      position: n - 1,
      points: n === 4 ? 5 : n === 5 || n === 7 ? 3 : n === 3 ? 1 : 2,
      type:
        n === 1
          ? "mcq"
          : n === 2
            ? "cloze"
            : n === 3
              ? "short"
              : n === 4
                ? "code"
                : n === 5
                  ? "circuit"
                  : n === 6
                    ? "codeimage"
                    : n === 7
                      ? "rich"
                      : n === 8
                        ? "categorize"
                        : "diagram",
      milestone: n === 3,
      // The circuit, a bonus question (ADR-052): the player's label.
      bonus: n === 5,
      // ADR-026: what `toStudent` adds to a choice question under negative marking.
      student:
        n === 1 && flags.negative
          ? { ...(studentPayloads[n] as object), negativeMarking: true }
          : studentPayloads[n],
      answer: stored?.payload ?? null,
      revision: stored?.revision ?? 0,
      markedDone: stored?.done ?? false,
      skipped: stored?.skipped ?? false,
      flagged: stored?.flagged ?? false,
      // `forward_only` closes a validated question (F-LIVE-08).
      locked: scene === "forward" && stored?.done === true,
    };
  }),
});

export const studentLobbyView = (): LobbyView => ({
  evaluation: {
    id: STUDENT_EVAL,
    title: "Quiz 3 — Pointeurs et lois fondamentales",
    state: "lobby",
    announcedDurationS: 20 * 60,
  },
  navigation: "free",
  negativeMarking: flags.negative,
  calculator: mockCalculator().calculator ?? "none",
  present: 18,
  enrolled: 24,
  timeBonusPercent: 33,
  serverNow: new Date().toISOString(),
});

/** `days` from today, at hh:mm on the browser's clock. */
const localAt = (days: number, hh: number, mm: number): string => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
};

/** Later today: 23:30, or ten minutes from now once that is less than half an hour away. */
const todayLater = (): string => {
  const late = localAt(0, 23, 30);
  return Date.parse(late) - now > 30 * 60_000 ? late : iso(10 * 60_000);
};

/** A scheduled card of PRG1-2026, opening at `opensAt`. */
const upcomingCard = (
  id: string,
  title: string,
  mode: "exam" | "exercise",
  opensAt: string,
): EvaluationCard => ({
  id,
  title,
  mode,
  state: "scheduled",
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  opensAt,
  closesAt: new Date(Date.parse(opensAt) + (mode === "exam" ? 45 * 60_000 : 7 * D)).toISOString(),
  durationS: mode === "exam" ? 30 * 60 : null,
  attemptId: null,
  attemptState: null,
  attemptStartedAt: null,
  grade: null,
  deadlineAt: null,
  retakes: null,
  results: "none",
  trustedClients: [],
});

/** The evaluations' half of the home, as the `live` module answers it: the cards before they are tagged. */
interface EvaluationHome {
  polls: StudentHomeData["polls"];
  open: EvaluationCard[];
  upcoming: EvaluationCard[];
  past: EvaluationCard[];
}

const evaluationHome = (): EvaluationHome => {
  if (flags.empty) {
    return { polls: [], open: [], upcoming: [], past: [] };
  }
  const room = { classroomId: "r1", classroomName: "PRG1-2026", courseCode: "PRG1" };
  return {
    // Issue #163: the running polls of the student's classroom, like the API
    // lists them — a classroom's poll, running, whose roster holds this
    // account. An anonymous poll and an ended one are on no home. A poll the
    // teacher persona launches for PRG1-2026 in this tab shows up here too.
    polls: teacherPolls.flatMap((tp) => {
      const poll = pollOfTeacher(tp);
      return tp.classroomId === room.classroomId &&
        poll !== null &&
        poll.state === "running" &&
        !poll.anonymous &&
        poll.offRoster !== true
        ? [{ id: tp.id, code: tp.code, ...room }]
        : [];
    }),
    open: [
      {
        id: STUDENT_EVAL,
        title: "Quiz 3 — Pointeurs et lois fondamentales",
        mode: "exam",
        state: studentEvaluationState(),
        ...room,
        opensAt: iso(-6 * 60_000),
        closesAt: iso(14 * 60_000),
        durationS: 20 * 60,
        attemptId: scene === "lobby" ? null : STUDENT_ATTEMPT,
        attemptState: scene === "lobby" ? null : "in_progress",
        attemptStartedAt: scene === "lobby" ? null : iso(-5 * 60_000),
        grade: null,
        deadlineAt: scene === "lobby" ? null : new Date(studentDeadline).toISOString(),
        retakes: null,
        results: "pending",
        // Issue #270: `?seb=1` makes this exam a Safe Exam Browser one;
        // ADR-051: `?kiosk=1` a kiosk-station one (both: either).
        trustedClients: [...(flags.seb ? ["seb" as const] : []), ...(flags.kiosk ? ["kiosk" as const] : [])],
      },
      {
        id: STUDENT_EVAL_RETAKE,
        title: "Série 3 — Pointeurs, entraînement",
        mode: "exercise",
        state: "running",
        ...room,
        opensAt: iso(-2 * D),
        closesAt: iso(5 * D),
        durationS: null,
        attemptId: STUDENT_RETAKE_ATTEMPT,
        attemptState: "submitted",
        attemptStartedAt: iso(-D),
        grade: null,
        deadlineAt: null,
        retakes: {
          keep: "best",
          maxAttempts: 3,
          attemptCount: 2,
          canRetake: true,
          kept: {
            attemptId: STUDENT_RETAKE_ATTEMPT,
            attemptNumber: 2,
            score: { points: 7.5, totalPoints: 10, pendingCount: 0 },
          },
        },
        // Between two attempts the page is score only (ADR-025).
        results: "pending",
        trustedClients: [],
      },
    ],
    // Grouped by day on the page (Today, Tomorrow, This week, Later): one
    // card per bucket, dated on the browser's clock so that every bucket is
    // drawn whatever the day — but "This week", from Friday on, as in reality.
    upcoming: [
      upcomingCard(STUDENT_EVAL_NEXT, "Série 4 — Récursivité", "exercise", localAt(10, 10, 15)),
      upcomingCard(STUDENT_EVAL_NEXT_TODAY, "Quiz 4 — Structures", "exam", todayLater()),
      upcomingCard(STUDENT_EVAL_NEXT_TOMORROW, "Série 3bis — Chaînes", "exercise", localAt(1, 8, 30)),
      upcomingCard(STUDENT_EVAL_NEXT_WEEK, "Quiz 5 — Fichiers", "exam", localAt(2, 14, 0)),
    ],
    past: [
      // Issue #203: handed in, the quiz still running, `on_release`. Past for
      // the student (nothing left to do), and no button: nothing to read yet.
      {
        id: STUDENT_EVAL_HANDED_IN,
        title: "Quiz 3bis — Allocation dynamique",
        mode: "exam",
        state: "running",
        ...room,
        opensAt: iso(-40 * 60_000),
        closesAt: iso(20 * 60_000),
        durationS: 30 * 60,
        attemptId: STUDENT_HANDED_IN_ATTEMPT,
        attemptState: "submitted",
        attemptStartedAt: iso(-35 * 60_000),
        grade: null,
        deadlineAt: iso(-5 * 60_000),
        retakes: null,
        results: "pending",
        trustedClients: [],
      },
      {
        id: STUDENT_EVAL_PAST,
        title: "Quiz 2 — Tableaux et chaînes",
        mode: "exam",
        state: "released",
        ...room,
        opensAt: iso(-8 * D),
        closesAt: iso(-8 * D + 20 * 60_000),
        durationS: 20 * 60,
        attemptId: STUDENT_PAST_ATTEMPT,
        attemptState: "submitted",
        attemptStartedAt: iso(-8 * D),
        grade: null,
        deadlineAt: null,
        retakes: null,
        results: "available",
        trustedClients: [],
      },
    ],
  };
};

// M3-09a, M3-13 (F-PROJ-04, F-PROJ-05, F-PROJ-07, F-PROJ-15): the student's
// projects of PRG1-2026 under `?projects=1`, one per state of the row's
// button (`docs/merge/05-web.md` §5.3) and of the page: in progress with an
// indicative score (ready), to accept (the project open, no repository), an
// invitation pending, one whose repository GitHub lost, one starting in
// three days, one locked that was never accepted, one released. With
// `?unlinked=1` the persona has no GitHub account, so the open ones lead to
// linking it. Accept (`?provisioning=1`: twenty seconds; `?refused=1`:
// `repo_name_taken`; `?stale=1`: `github_account_stale`) gives the accepting
// card its repository, with the invitation pending, for the rest of the
// page's life; Resend keeps the staff's minute. Hand-written, like the home:
// the teacher's projects of `project.ts` are another persona's world.
// `?notices=1` (M3-09c): the fake stream pushes to the open project's
// repository a moment after the page's first read and hints `projects`, so
// the page's notices can be seen (`arriveStudentProjectActivity`).
export const STUDENT_PROJECT_OPEN = "77777777-7777-4777-8777-777777777701";
export const STUDENT_PROJECT_SOON = "77777777-7777-4777-8777-777777777702";
export const STUDENT_PROJECT_PAST = "77777777-7777-4777-8777-777777777703";
export const STUDENT_PROJECT_ACCEPT = "77777777-7777-4777-8777-777777777704";
export const STUDENT_PROJECT_INVITED = "77777777-7777-4777-8777-777777777705";
export const STUDENT_PROJECT_LOCKED = "77777777-7777-4777-8777-777777777706";
export const STUDENT_PROJECT_DELETED = "77777777-7777-4777-8777-777777777707";
export const STUDENT_PROJECT_IDS = [
  STUDENT_PROJECT_OPEN,
  STUDENT_PROJECT_SOON,
  STUDENT_PROJECT_PAST,
  STUDENT_PROJECT_ACCEPT,
  STUDENT_PROJECT_INVITED,
  STUDENT_PROJECT_LOCKED,
  STUDENT_PROJECT_DELETED,
] as const;
/** The student's repository of a project, `<slug>-<login>` in the classroom's organization, the slug from the title's head ("Labo 1 — …" ⇒ `labo-1`). */
const studentRepoName = (title: string) =>
  `heig-tin-info/${title.split(" — ")[0]!.normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}-lea-perret`;

/** The projects accepted in this page's life (Accept below), their invitation pending. */
const acceptedHere = new Set<string>();
/** When each invitation was last resent here: the staff's minute (F-PROJ-07). */
const resentAt = new Map<string, number>();
/** The pushes to the open project's repository in this page's life (`?notices=1`): each one scores two points more. */
let pushedHere = 0;

/** `?notices=1` (F-PROJ-21, M3-09c): a push lands on the open project's repository, with its score; the stream then hints `projects`. */
export function arriveStudentProjectActivity(): void {
  pushedHere += 1;
}

const studentProjectCards = (): StudentProjectCard[] => {
  if (!flags.projects || flags.empty) return [];
  const base = {
    kind: "project" as const,
    classroomId: "r1",
    classroomName: "PRG1-2026",
    courseCode: "PRG1",
    githubLinked: !flags.unlinked,
  };
  const repo = (title: string, invitation: "pending" | "accepted") => {
    const fullName = studentRepoName(title);
    return { repoFullName: fullName, repoUrl: `https://github.com/${fullName}`, invitation };
  };
  const none = { invitation: null, repoFullName: null, repoUrl: null };
  const toAccept = (id: string, title: string) =>
    acceptedHere.has(id) ? { status: "in_progress" as const, ...repo(title, "pending") } : { status: "to_accept" as const, ...none };
  return [
    { ...base, id: STUDENT_PROJECT_OPEN, title: "Labo 1 — Pointeurs et tableaux", startAt: iso(-3 * D), deadlineAt: iso(6 * D + 4 * H), status: "in_progress", ...repo("Labo 1", "accepted") },
    { ...base, id: STUDENT_PROJECT_ACCEPT, title: "Labo 2 — Listes chaînées", startAt: iso(-D), deadlineAt: iso(13 * D), ...toAccept(STUDENT_PROJECT_ACCEPT, "Labo 2") },
    { ...base, id: STUDENT_PROJECT_INVITED, title: "Mini-projet — Jeu de la vie", startAt: iso(-2 * D), deadlineAt: iso(27 * D), status: "in_progress", ...repo("Mini-projet", "pending") },
    // Provisioned, then deleted on GitHub: the card names no repository (M3-09a).
    { ...base, id: STUDENT_PROJECT_DELETED, title: "Labo 1b — Révision des pointeurs", startAt: iso(-5 * D), deadlineAt: iso(2 * D), status: "in_progress", ...none },
    { ...base, id: STUDENT_PROJECT_SOON, title: "Labo 3 — Arbres binaires", startAt: iso(3 * D), deadlineAt: iso(17 * D), ...toAccept(STUDENT_PROJECT_SOON, "Labo 3") },
    { ...base, id: STUDENT_PROJECT_LOCKED, title: "Exercice préliminaire — Compilation", startAt: iso(-30 * D), deadlineAt: iso(-14 * D), status: "locked", ...none },
    { ...base, id: STUDENT_PROJECT_PAST, title: "Labo 0 — Prise en main", startAt: iso(-21 * D), deadlineAt: iso(-7 * D), status: "released", ...repo("Labo 0", "accepted") },
  ];
};

/**
 * The view of one of the cards above: its repository as the card names it
 * (deleted on the one GitHub lost), a current score on the open one, the
 * frozen score and the release on the past one, nothing yet on a pending
 * invitation.
 */
const studentProjectView = (card: StudentProjectCard): StudentProject => {
  const { invitation, repoFullName, repoUrl, ...facts } = card;
  const sha = (seed: string) => seed.repeat(40).slice(0, 40);
  const released = card.status === "released";
  // The open project's repository moves with each push of `?notices=1`: another commit, two points more.
  const pushes = card.id === STUDENT_PROJECT_OPEN ? pushedHere : 0;
  const at = released ? iso(-7 * D - 3 * H) : pushes > 0 ? new Date().toISOString() : iso(-2 * H);
  const deleted = card.id === STUDENT_PROJECT_DELETED;
  const url = repoUrl ?? `https://github.com/${studentRepoName(card.title)}`;
  const graded = invitation === "accepted" && !deleted;
  const repo: StudentProject["repo"] =
    repoFullName === null && !deleted
      ? null
      : {
          fullName: repoFullName ?? studentRepoName(card.title),
          url,
          invitation: invitation ?? "accepted",
          deleted,
          locked: released,
          lastCommit: graded || deleted ? { sha: sha(`${card.id.slice(-2)}${pushes}`), at } : null,
          ciStatus: graded ? "pass" : "none",
          run: graded
            ? { sha: sha(`${card.id.slice(-2)}${pushes}`), url: `${url}/actions/runs/${card.id.slice(-4)}`, conclusion: "success", completedAt: at }
            : null,
          score: !graded
            ? null
            : released
              ? { points: 18, max: 20, grade: { grade: 5.5, fellBack: false }, frozen: true }
              : { points: Math.min(40, 34 + 2 * pushes), max: 40, grade: { grade: 5.3, fellBack: false }, frozen: false },
        };
  return {
    ...facts,
    gradingMode: "auto",
    repo,
    release: released
      ? { at: iso(-5 * D), points: 18, max: 20, grade: { grade: 5.5, fellBack: false }, comment: "Très bon travail, attention aux fuites mémoire dans la libération de la liste." }
      : null,
    serverNow: new Date().toISOString(),
  };
};

/** The home as the `activity` module serves it: every kind, tagged, the projects grouped by the domain's rule (M3-09a). */
const studentHome = (): StudentHomeData => {
  const home = evaluationHome();
  const tag = (cards: EvaluationCard[]) => cards.map((c) => ({ kind: "evaluation" as const, ...c }));
  const groups: Record<StudentActivityGroup, StudentProjectCard[]> = { open: [], upcoming: [], past: [] };
  for (const card of studentProjectCards()) {
    const facts = {
      startAt: new Date(card.startAt),
      deadlineAt: new Date(card.deadlineAt),
      released: card.status === "released",
      accepted: card.status === "in_progress",
      locked: card.status === "locked",
    };
    groups[studentProjectGroup(facts, new Date(now))].push(card);
  }
  return {
    polls: home.polls,
    groupSets: flags.empty ? [] : studentGroupSetCards(),
    open: [...tag(home.open), ...groups.open],
    upcoming: [...tag(home.upcoming), ...groups.upcoming],
    past: [...tag(home.past), ...groups.past],
    serverNow: new Date().toISOString(),
  };
};

on("GET", "/app/api/student/home", studentHome);

const studentProjectOr404 = (id: string | undefined): StudentProjectCard => {
  const found = studentProjectCards().find((p) => p.id === id);
  if (!found) throw new MockError(404, "Not found");
  return found;
};

on("GET", "/app/api/student/projects/:id", (m): StudentProject => studentProjectView(studentProjectOr404(m.groups!.id)));

/** A refusal of Accept or Resend as the API words it: `{ error, message }`, 502 for GitHub failing, 429 for too soon, 409 otherwise. */
const projectRefusal = (code: string) =>
  new MockPayload(
    code === "provision_failed" || code === "invite_failed" ? 502 : code === "resend_too_soon" ? 429 : 409,
    { error: code, message: code },
  );

on("POST", "/app/api/student/projects/:id/accept", async (m): Promise<ProjectAcceptance> => {
  const card = studentProjectOr404(m.groups!.id);
  if (flags.refused) throw projectRefusal("repo_name_taken");
  if (flags.stale) throw projectRefusal("github_account_stale");
  if (card.repoFullName !== null) return { status: "ok", fullName: card.repoFullName, invitationStatus: card.invitation ?? "accepted" };
  if (card.status !== "to_accept") throw projectRefusal("deadline_passed");
  if (Date.parse(card.startAt) > Date.now()) throw projectRefusal("not_started");
  if (!card.githubLinked) throw projectRefusal("github_not_linked");
  // F-PROJ-05: under a minute; `?provisioning=1` lets the waiting button be seen.
  if (flags.provisioning) await new Promise((r) => setTimeout(r, 20_000));
  acceptedHere.add(card.id);
  return { status: "ok", fullName: studentRepoName(card.title), invitationStatus: "pending" };
});

on("POST", "/app/api/student/projects/:id/invite", (m): ProjectInvitationResent => {
  const card = studentProjectOr404(m.groups!.id);
  if (card.repoFullName === null) throw projectRefusal("repo_unavailable");
  if (card.invitation !== "pending") throw projectRefusal("invitation_not_pending");
  const last = resentAt.get(card.id);
  if (last !== undefined && Date.now() - last < 60_000) throw projectRefusal("resend_too_soon");
  resentAt.set(card.id, Date.now());
  return { invitationStatus: "pending", resentAt: new Date().toISOString() };
});

// F-ORG-14, F-RES-04: the student's Grades — the home's Past of every
// classroom, by classroom, newest first, written by hand like the home: one
// row of each status, an archived classroom (PRG1-2024) last. The grade is
// on a row only where the server would let the student read it. `?many=1`
// is a whole term of weekly series; `?empty=1` nothing finished yet.
on("GET", "/app/api/student/results", (): StudentGrades => {
  if (flags.empty) return [];
  let seq = 0;
  const current = studentRooms()[0]!;
  const header = (over: Partial<GradeGroup["classroom"]>): GradeGroup["classroom"] => ({
    id: current.id,
    name: current.name,
    courseCode: current.courseCode,
    courseName: current.courseName,
    period: current.period,
    archived: false,
    ...over,
  });
  const row = (over: Partial<EvaluationGradeRow> & Pick<EvaluationGradeRow, "title" | "status">): EvaluationGradeRow => ({
    kind: "evaluation",
    evaluationId: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    mode: "exam",
    date: iso(-D),
    feedbackAttemptId: null,
    score: null,
    ...over,
  });
  const score = (points: number, totalPoints: number) => ({
    points,
    totalPoints,
    grade: Math.round((1 + (5 * points) / totalPoints) * 10) / 10,
    pendingCount: 0,
  });
  const series = flags.many
    ? Array.from({ length: 12 }, (_, i) =>
        row({
          title: `Série ${12 - i} — exercices hebdomadaires`,
          mode: "exercise",
          status: "released",
          date: iso(-(10 + 7 * i) * D),
          // The mock's one readable feedback page (`mock/grading.ts`).
          feedbackAttemptId: STUDENT_PAST_ATTEMPT,
          score: score(10 - (i % 5) * 1.5, 10),
        }),
      )
    : [];
  return [
    {
      classroom: header({}),
      rows: [
        // Handed in, the quiz still running, `on_release` (issue #203).
        row({ evaluationId: STUDENT_EVAL_HANDED_IN, title: "Quiz 3bis — Allocation dynamique", status: "pending", date: iso(-35 * 60_000) }),
        // An exercise under the immediate policy: readable, not released —
        // its points, indicative, no grade, and two questions still pending.
        row({
          title: "Série 2 — Tableaux",
          mode: "exercise",
          status: "available",
          date: iso(-3 * D),
          feedbackAttemptId: STUDENT_EARLY_ATTEMPT,
          score: { points: 7, totalPoints: 10, grade: null, pendingCount: 2 },
        }),
        row({
          evaluationId: STUDENT_EVAL_PAST,
          title: "Quiz 2 — Tableaux et chaînes",
          status: "released",
          date: iso(-8 * D),
          feedbackAttemptId: STUDENT_PAST_ATTEMPT,
          score: score(8.5, 12),
        }),
        // Released, never taken: the scale minimum (F-RES-02).
        row({ title: "Quiz 1 — Types et opérateurs", status: "missed", date: iso(-15 * D), score: score(0, 10) }),
        ...series,
        // Newest first, as the server sorts them.
      ].sort((a, b) => b.date.localeCompare(a.date)),
    },
    {
      classroom: header({ id: "r6", name: "PRG1-2024", period: "2024-A", archived: true }),
      rows: [
        // Under the policy `none`: released, and the grade not shared.
        row({ title: "Série 8 — Fichiers", mode: "exercise", status: "withheld", date: iso(-320 * D) }),
        row({
          title: "Examen final — Programmation C",
          status: "released",
          date: iso(-330 * D),
          score: score(31, 40),
        }),
        row({ title: "Série 7 — Listes chaînées", mode: "exercise", status: "submitted", date: iso(-340 * D) }),
      ],
    },
  ];
});

// M5-01: the student's classroom page — the home narrowed to the classroom,
// under the Courses card as its header. `?journal=1` gives PRG1-2026 (`r1`,
// `JOURNAL_ROOM` of `mock/journal.ts`) its Journal tab.
on("GET", "/app/api/student/classrooms/:id", (m): StudentClassroomPage => {
  const id = m.groups!.id!;
  const header = studentRooms().find((r) => r.id === id);
  if (!header) throw new MockError(404, "Not found");
  const home = studentHome();
  const inRoom = <T extends { classroomId: string }>(cards: T[]) =>
    cards.filter((c) => c.classroomId === id);
  return {
    classroom: { ...header, archived: false },
    activities: {
      polls: inRoom(home.polls),
      groupSets: inRoom(home.groupSets),
      open: inRoom(home.open),
      upcoming: inRoom(home.upcoming),
      past: inRoom(home.past),
    },
    hasJournal: hasMockJournal(id),
    hasGroups: hasStudentGroups(id),
    serverNow: home.serverNow,
  };
});

// F-EVAL-15: the retake opens a fresh attempt; the mock hands back the one
// attempt view it has, which is what the player then enters.
on("POST", "/app/api/evaluations/:id/retake", () => ({
  kind: "attempt",
  view: studentAttemptView(),
}));

// Between two attempts the student reads the score and nothing else (ADR-025).
on("GET", `/app/api/attempts/${STUDENT_RETAKE_ATTEMPT}/feedback`, () => ({
  available: false,
  reason: "retakes_open",
  evaluation: { id: STUDENT_EVAL_RETAKE, title: "Série 3 — Pointeurs, entraînement" },
  score: { points: 7.5, totalPoints: 10, pendingCount: 0 },
  // Two of three attempts taken: the page offers the third (issues #120, #121).
  retake: {
    evaluationId: STUDENT_EVAL_RETAKE,
    keep: "best",
    maxAttempts: 3,
    attemptCount: 2,
    refusal: null,
  },
}));

// Issue #203: the player's own attempt is `on_release` and never released in
// the mock, so the Handed-in screen offers Back to home alone.
on("GET", `/app/api/attempts/${STUDENT_ATTEMPT}/feedback`, () => ({
  available: false,
  reason: "results_pending",
  evaluation: { id: STUDENT_EVAL, title: "Quiz 3 — Pointeurs et lois fondamentales" },
}));

on("POST", "/app/api/evaluations/:id/attempt", () =>
  scene === "lobby"
    ? { kind: "lobby", view: studentLobbyView() }
    : { kind: "attempt", view: studentAttemptView() },
);

// Like the API: the lobby until the evaluation starts, the attempt after.
on("GET", "/app/api/attempts/:id", () =>
  scene === "lobby"
    ? { kind: "lobby", view: studentLobbyView() }
    : { kind: "attempt", view: studentAttemptView() },
);

on("PUT", "/app/api/attempts/:id/answers/:itemId", (m, body): AutosaveResponse => {
  const itemId = m.groups!.itemId!;
  const revision = Number(body.revision ?? 1);
  const stored = studentAnswers.get(itemId);
  // The same last-writer-wins rule as the server: a lower revision is stale
  // and comes back with what is stored (§4.7).
  if (stored && stored.revision >= revision) {
    return {
      revision: stored.revision,
      payload: stored.payload,
      accepted: false,
      serverNow: new Date().toISOString(),
    };
  }
  // The server's rule (issue #89): an answer that holds something takes back
  // an "I won't answer". The mock cannot ask the type, so anything non-null
  // counts, which is right for every payload the player sends but an empty
  // mcq selection.
  const empty =
    body.payload === null ||
    (typeof body.payload === "object" &&
      Array.isArray((body.payload as { selected?: unknown }).selected) &&
      (body.payload as { selected: unknown[] }).selected.length === 0);
  studentAnswers.set(itemId, {
    ...(stored ?? { done: false }),
    payload: body.payload,
    revision,
    skipped: empty ? (stored?.skipped ?? false) : false,
  });
  return { revision, accepted: true, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/answers/:itemId/done", (m, body) => {
  const itemId = m.groups!.itemId!;
  const stored = studentAnswers.get(itemId) ?? { payload: null, revision: 0, done: false };
  const done = body.done === true;
  studentAnswers.set(itemId, { ...stored, done });
  return { done, nextItemId: null, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/answers/:itemId/skip", (m, body) => {
  const itemId = m.groups!.itemId!;
  const stored = studentAnswers.get(itemId) ?? { payload: null, revision: 0, done: false };
  const skipped = body.skipped === true;
  studentAnswers.set(itemId, { ...stored, skipped });
  return { skipped, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/answers/:itemId/flag", (m, body) => {
  const itemId = m.groups!.itemId!;
  const stored = studentAnswers.get(itemId) ?? { payload: null, revision: 0, done: false };
  const flagged = body.flagged === true;
  studentAnswers.set(itemId, { ...stored, flagged });
  return { flagged, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/position", (_m, body) => {
  // `null`: no question on screen; the bookmark stays (ADR-039).
  if (typeof body.itemId === "string") studentPosition = body.itemId;
  return undefined;
});

on("POST", "/app/api/attempts/:id/submit", () => ({
  state: "submitted",
  submittedAt: new Date().toISOString(),
  serverNow: new Date().toISOString(),
}));

on("POST", "/app/api/attempts/:id/events", () => undefined);

/*
 * The BACKEND run. The mock's code question asks for the browser instead
 * (`runtime: "runno"`), so this answers only when the browser runner cannot —
 * no `/runtimes` on this deployment, or a question that says `backend`. A free
 * try (`stdin` in the body) gets one case back, the way the API answers it.
 */
/**
 * `POST /attempts/:id/simulate` (WP11): ngspice on the platform runner.
 *
 * It answers a RAW `RunnerOutcome` — one deck per VISIBLE stimulus, in order
 * — and the `circuit` player parses it itself (`parseSimulation`). The
 * stdout below is a real transient, so the plot on the screen is a real RC
 * low-pass and not a drawing of one.
 *
 * Both graceful paths are reachable: `?fail=1` answers the `503` of a
 * deployment with no container engine (decision D14), and the fourth press
 * in one page answers the `429` of the per-attempt budget (N-SEC-07) —
 * a real budget rather than a flag, because that is how a student meets it.
 * `?slow=1` already delays every call, which is the running state.
 */
let simulationsSpent = 0;
on("POST", "/app/api/attempts/:id/simulate", (_m, body): unknown => {
  if (flags.fail) throw new MockError(503, "runner_unavailable");
  simulationsSpent += 1;
  if (simulationsSpent > 3) throw new MockError(429, "rate_limited");
  // The same generic route runs a `codeimage` program (ADR-021): the raw
  // outcome of one run, whose stdout is the picture.
  if ((body as { itemId?: string } | undefined)?.itemId === studentItem(6)) {
    return codeimageRunOutcome();
  }
  return ngspiceOutcome(1);
});

on("POST", "/app/api/attempts/:id/run", (m, body): unknown => {
  const free = body as { stdin?: string; args?: string[]; compileOnly?: boolean } | undefined;
  // The Compile button: a build and no case, like the real route.
  if (free?.compileOnly === true) {
    return {
      requestId: "33333333-3333-4333-8333-333333333335",
      result: { status: "ok", compile: { ok: true, stderr: "" }, cases: [] },
    };
  }
  if (free?.stdin !== undefined) {
    return {
      requestId: "33333333-3333-4333-8333-333333333334",
      result: {
        status: "ok",
        compile: { ok: true, stderr: "" },
        cases: [
          {
            name: "stdin",
            ok: true,
            stdout: `${(free.args ?? []).join(" ")}\n`,
            expected: "",
            ms: 4,
            timedOut: false,
          },
        ],
      },
    };
  }
  return {
  requestId: "33333333-3333-4333-8333-333333333333",
  result: {
    status: "ok",
    compile: { ok: true, stderr: "" },
    cases: [
      {
        name: "deux résistances égales",
        ok: false,
        stdout: "-inf",
        expected: "50.00",
        ms: 3,
        timedOut: false,
      },
      {
        name: "court-circuit",
        ok: true,
        stdout: "0.00",
        expected: "0.00",
        ms: 2,
        timedOut: false,
      },
    ],
  },
  };
});
