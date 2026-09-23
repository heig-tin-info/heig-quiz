/** Section 4 of the mock — see `index.ts` for the layout. */
import {
  clozeStudentTemplate,
  parseCloze,
} from "@quiz/domain";
import type {
  AttemptView,
  AutosaveResponse,
  JoinResult,
  LobbyView,
  StudentHome as StudentHomeData,
} from "@quiz/contracts";
import {
  D,
  MockError,
  flags,
  iso,
  now,
  on,
  scene,
} from "./runtime";
import {
  RC_STUDENT,
  ngspiceOutcome,
} from "./pool";

// --- 4. The student: home, lobby and player (WP9) --------------------------
//
// The student persona's scenes: a home with three evaluations, the lobby, a
// running attempt holding one question of every MVP type, a pause and a
// closure. `?scene=` (read in section 0) picks which one the fake backend
// serves:
//
//   ?scene=lobby | running | paused | closed | extend | single
//                                                     (running by default)
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
export const STUDENT_ATTEMPT = "22222222-2222-4222-8222-222222222222";
export const STUDENT_PAST_ATTEMPT = "22222222-2222-4222-8222-222222222223";
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
    prompt: "Quel extrait affiche **l'adresse** de la variable `x` ?",
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
      "Complétez la phrase. L'orthographe des noms propres n'est pas notée.\n\n" +
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
      "Sur une machine 64 bits compilant en LP64, combien d'octets occupe un `int` en C ?",
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
      // Plain text: the `code` player renders its prompt as written (its
      // props carry no markdown renderer), so no backtick survives as syntax.
      "Corrigez r_parallele pour qu'elle renvoie la résistance équivalente de deux résistances en parallèle, en ohms. Les deux valeurs arrivent sur la ligne de commande. Le cas d'un court-circuit doit renvoyer 0, et un appel sans les deux arguments doit sortir avec le code 2.",
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
        analysis: { stopMs: 5, skipMs: 0, points: 500 },
        points: 2,
      },
    ],
    hiddenCount: 1,
    hiddenPoints: 1,
    canSimulate: true,
    showExpected: false,
    simulationsPerMinute: 10,
  },
};

/** The attempt's mutable half: what the student typed, and where they are. */
const studentAnswers = new Map<string, { payload: unknown; revision: number; done: boolean }>();
/*
 * The circuit item opens with something already on the canvas — the RC with
 * its ground wires missing. An empty box would show the empty state and
 * nothing else, and the strip under the drawing is half of what this type IS.
 */
studentAnswers.set(studentItem(5), { payload: { schematic: RC_STUDENT }, revision: 1, done: false });
let studentPosition: string | null = studentItem(1);
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
    mode: "exam",
    state: studentEvaluationState(),
    settings: {
      navigation: "free",
      presentation: "zen",
      lobby: "manual",
      shuffleItems: false,
      shuffleChoices: true,
      timing: "duration",
      showProgressBar: true,
      logVisibility: true,
      requireFullscreen: false,
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
  items: (scene === "single" ? [1] : [1, 2, 3, 4, 5]).map((n) => {
    const stored = studentAnswers.get(studentItem(n));
    return {
      id: studentItem(n),
      position: n,
      points: n === 4 ? 5 : n === 5 ? 3 : n === 3 ? 1 : 2,
      type:
        n === 1 ? "mcq" : n === 2 ? "cloze" : n === 3 ? "short" : n === 4 ? "code" : "circuit",
      milestone: n === 3,
      student: studentPayloads[n],
      answer: stored?.payload ?? null,
      revision: stored?.revision ?? 0,
      markedDone: stored?.done ?? false,
      locked: false,
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
  present: 18,
  enrolled: 24,
  timeBonusPercent: 33,
  serverNow: new Date().toISOString(),
});

on("GET", "/app/api/student/home", (): StudentHomeData => {
  if (flags.empty) {
    return { open: [], upcoming: [], past: [], serverNow: new Date().toISOString() };
  }
  const room = { classroomId: "r1", classroomName: "PRG1-2026", courseCode: "PRG1" };
  return {
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
        grade: null,
        deadlineAt: scene === "lobby" ? null : new Date(studentDeadline).toISOString(),
      },
    ],
    upcoming: [
      {
        id: STUDENT_EVAL_NEXT,
        title: "Série 4 — Récursivité",
        mode: "exercise",
        state: "scheduled",
        ...room,
        opensAt: iso(3 * D),
        closesAt: iso(7 * D),
        durationS: null,
        attemptId: null,
        attemptState: null,
        grade: null,
        deadlineAt: null,
      },
    ],
    past: [
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
        grade: null,
        deadlineAt: null,
      },
    ],
    serverNow: new Date().toISOString(),
  };
});

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
  studentAnswers.set(itemId, { payload: body.payload, revision, done: stored?.done ?? false });
  return { revision, accepted: true, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/answers/:itemId/done", (m, body) => {
  const itemId = m.groups!.itemId!;
  const stored = studentAnswers.get(itemId) ?? { payload: null, revision: 0, done: false };
  const done = body.done === true;
  studentAnswers.set(itemId, { ...stored, done });
  return { done, nextItemId: null, serverNow: new Date().toISOString() };
});

on("POST", "/app/api/attempts/:id/position", (_m, body) => {
  studentPosition = String(body.itemId);
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
on("POST", "/app/api/attempts/:id/simulate", (): unknown => {
  if (flags.fail) throw new MockError(503, "runner_unavailable");
  simulationsSpent += 1;
  if (simulationsSpent > 3) throw new MockError(429, "rate_limited");
  return ngspiceOutcome(1);
});

on("POST", "/app/api/attempts/:id/run", (m, body): unknown => {
  const free = body as { stdin?: string; args?: string[] } | undefined;
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

on("POST", "/app/api/join/:code", (m): JoinResult => ({
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  status: m.groups!.code!.toUpperCase() === "PRG1-2026" ? "already" : "joined",
}));
