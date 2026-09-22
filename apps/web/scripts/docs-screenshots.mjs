// Screenshots for the user guide (docs/), taken from the REAL application.
// Development tool only: never imported, never bundled, never run in CI.
//
// The guide is rendered by zensical and shows one image per theme through
// the `#only-light` / `#only-dark` suffix, so every scene comes out twice:
// `<scene>-light.png` and `<scene>-dark.png` (and `<scene>-phone-light.png`
// / `-phone-dark.png` at 390 px where the scene asks for it). The scene list
// below is the SOURCE OF TRUTH: `docs/assets/screenshots/manifest.json` is
// derived from it and records, per scene, what the page shows and how it was
// reached, so a screenshot can be retaken when the portal evolves.
//
// PROCEDURE
//
//   1. An ISOLATED instance of the API, on a fresh, deterministic seed. It
//      serves the built SPA itself (no Vite), talks to a code runner when one
//      is running on :3200, and lives in its own PGlite directory — the
//      developer's own `pnpm dev` (:3000 / :5173 / apps/api/.data/pglite) is
//      never touched. PGlite is single-process: seed BEFORE starting.
//
//        pnpm --filter @quiz/web build
//        cd apps/api
//        export DATABASE_URL=pglite://.data/pglite-docs ASSETS_DIR=.data/assets-docs
//        export PORT=3100 PUBLIC_URL=http://localhost:3100 AUTH_DEV_LOGIN=1
//        export STATIC_DIR=$PWD/../web/dist RUNNER_MODE=http RUNNER_URL=http://localhost:3200
//        pnpm seed
//        pnpm exec tsx --env-file-if-exists=../../.env src/server.ts &
//        curl localhost:3100/healthz        # database up, runner up
//
//      (A shell variable wins over the same name in `.env`.) To start over,
//      stop the instance and delete `apps/api/.data/pglite-docs`.
//
//   2. `pnpm docs:screenshots` (from the repository root). The script signs
//      in over `POST /app/auth/dev` with the seeded personas, discovers every
//      id over the API (nothing is hardcoded), and walks the demo world
//      through PHASES, in order, taking the scenes of each phase before the
//      next one starts:
//
//        seeded         nothing prepared: the world exactly as `pnpm seed` left it
//                       (the code answers of "Test 0" wait for a runner)
//        graded         one grading pass with the real runner settles them
//        lobby          the exercise "Quiz d'entraînement" gets a short-answer
//                       and a code question (so the player shows all four
//                       types), Léa and Noah wait in its lobby
//        running        the teacher starts it; Noah answers everything and
//                       hands in, Léa answers two questions, Emma one,
//                       Louis only opens it
//        poll-open      a live poll on a multiple-choice question, three
//                       students have answered through the join code
//        poll-revealed  the teacher reveals the answer
//        poll-ended     the teacher ends the poll
//        released       the results of "Test 0 — bases du C" are published
//
//      A phase is one-way (a poll cannot be un-ended), so the light and the
//      dark variants of a scene are taken back to back, before the world
//      moves on. Every preparation step tolerates being run again on the same
//      instance, so re-running the script, or one scene of it, on an
//      instance that has already moved on does not crash — it only replays
//      what still applies.
//
//   3. Flags:
//        --list             print the scene names and exit
//        --only=<substr>    scenes whose name contains it (repeatable). The
//                           preparation phases still run, up to the phase the
//                           scene needs; the manifest is MERGED, not rewritten
//        --dark / --light   one theme instead of both
//      Environment: BASE (default http://localhost:3100), OUT (default
//      docs/assets/screenshots).
//
// Every scene takes the VIEWPORT (1440×900, or 390×844 for a phone) unless it
// says `fullPage: true` because what is below the fold is the point. Nothing
// is masked. Console and page errors are reported per scene, like the mock
// script does (`screenshots.mjs`).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, request } from "playwright-core";

import { writeSceneTable } from "./docs-screenshots-index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const BASE = process.env.BASE ?? "http://localhost:3100";
const OUT = process.env.OUT ?? path.join(ROOT, "docs", "assets", "screenshots");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) =>
  argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const only = opt("only").concat(argv.filter((a) => !a.startsWith("--")));
const THEMES = flag("dark") ? ["dark"] : flag("light") ? ["light"] : ["light", "dark"];

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The order the world moves through. A scene names the phase it needs. */
const PHASES = ["seeded", "graded", "lobby", "running", "poll-open", "poll-revealed", "poll-ended", "released"];

// --- The demo world (apps/api/src/seed/content.ts) ----------------------

const TITLES = {
  draft: "Test 1 — pointeurs",
  scheduled: "Test 2 — chaînes",
  lobby: "Quiz d'entraînement",
  closed: "Test 0 — bases du C",
};
const QUESTIONS = {
  mcq: "prg1-pointeur-non-initialise",
  mcqMultiple: "prg1-operateurs-bit-a-bit",
  short: "prg1-mot-cle-constante",
  cloze: "prg1-boucle-for",
  code: "prg1-code-somme-tableau",
};
/** The reference solution of the seeded C exercise (the smoke test uses the same). */
const SUM_SOLUTION = `
int somme(const int *t, int n) {
    int total = 0;
    for (int i = 0; i < n; i++) {
        total += t[i];
    }
    return total;
}
`;

// --- Scenes, as data -----------------------------------------------------
//
// name      file name, plus the theme and phone suffixes
// caption   what the guide says under the image
// persona   dev-login persona; "none" = no session; "guest" = a fresh browser
// path      URL under BASE, or a function of the discovered world
// phase     the phase the scene needs (default "seeded")
// settle    ms to wait after the load (default 1500)
// act       what to do once the page settled
// action    the same, in one human sentence, for the manifest
// state     which prepared state of the demo world the page shows
// fullPage  the whole page instead of the viewport
// phone     true = a 390 px variant too; "only" = the phone variant alone
// ignore    console messages that are the scene's own (a 401 with no session)

const scenes = [
  // Sign-in
  {
    name: "sign-in",
    caption: "The sign-in screen, with the development login next to the Switch edu-ID button.",
    persona: "none",
    path: "/",
    state: "No session in the browser.",
  },

  // Teacher: home, classroom, roster
  {
    name: "teacher-home",
    caption: "The teacher's home: one card per course, with its classrooms.",
    persona: "teacher",
    path: "/",
    state: "As seeded: the course PRG1 with its classroom PRG1-2026.",
  },
  {
    name: "classroom-evaluations",
    caption: "A classroom, on its evaluations tab.",
    persona: "teacher",
    path: (w) => `/classrooms/${w.classroom.id}`,
    state: "As seeded: four evaluations (draft, scheduled, lobby, closed).",
  },
  {
    name: "classroom-roster",
    caption: "The same classroom, on its roster tab.",
    persona: "teacher",
    path: (w) => `/classrooms/${w.classroom.id}?tab=roster`,
    state: "As seeded: six students, every seat claimed.",
  },
  {
    name: "roster-import",
    caption: "Adding students: paste a list or a CSV export.",
    persona: "teacher",
    path: (w) => `/classrooms/${w.classroom.id}?tab=roster`,
    act: (p) => p.getByRole("button", { name: /^add students$/i }).first().click(),
    action: "Clicked “Add students” on the roster tab.",
    state: "As seeded.",
  },
  {
    name: "help-drawer",
    caption: "Every screen has a help drawer, opened from the question mark.",
    persona: "teacher",
    path: (w) => `/classrooms/${w.classroom.id}`,
    act: (p) => p.getByRole("button", { name: /^help$/i }).first().click(),
    action: "Clicked the “Help” icon of the classroom page.",
    state: "As seeded.",
  },

  // Pools and the question editors
  {
    name: "pools",
    caption: "The question pools of the teacher.",
    persona: "teacher",
    path: "/pools",
    state: "As seeded: the pools “Programmation C” and “Électronique”.",
  },
  {
    name: "pool",
    caption: "A pool: its categories in the sidebar, its questions in the table.",
    persona: "teacher",
    path: (w) => `/pools/${w.pool.id}`,
    state: "As seeded: ten published questions of the four types.",
  },
  {
    name: "pool-filters",
    caption: "The filters of a pool: type, difficulty, tags, state.",
    persona: "teacher",
    path: (w) => `/pools/${w.pool.id}`,
    act: (p) => p.getByRole("button", { name: /^filters/i }).first().click(),
    action: "Clicked “Filters” above the question table.",
    state: "As seeded.",
  },
  {
    name: "pool-share",
    caption: "Sharing a pool with another teacher.",
    persona: "teacher",
    path: "/pools",
    act: async (p) => {
      await openRowMenu(p, /^actions$/i);
      await p.getByRole("menuitem", { name: /^share…$/i }).click();
    },
    action: "Opened the row menu of the first pool and picked “Share…”.",
    state: "As seeded.",
  },
  {
    name: "editor-mcq",
    caption: "The editor of a multiple-choice question.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.mcq.id}`,
    state: "As seeded: the published question “prg1-pointeur-non-initialise”.",
  },
  {
    name: "editor-short",
    caption: "The editor of a short-answer question, with its matchers.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.short.id}`,
    state: "As seeded: the published question “prg1-mot-cle-constante”.",
  },
  {
    name: "editor-cloze",
    caption: "The editor of a fill-in-the-blanks question.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.cloze.id}`,
    state: "As seeded: the published question “prg1-boucle-for”.",
  },
  {
    name: "editor-code",
    caption: "The editor of a code question: template, editable regions, test cases.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.code.id}`,
    settle: 5000,
    state: "As seeded: the published C exercise “prg1-code-somme-tableau”.",
  },
  {
    name: "editor-preview",
    caption: "The student preview of a question, exactly what a student will see.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.mcq.id}`,
    fullPage: true,
    act: (p) => p.keyboard.press("Control+Shift+M"),
    action: "Pressed Ctrl+Shift+M in the editor.",
    state: "As seeded.",
  },
  {
    name: "editor-versions",
    caption: "The versions of a question: every publication, with its note.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.code.id}?tab=versions`,
    settle: 3000,
    state: "As seeded: one published version.",
  },
  {
    name: "editor-publish",
    caption: "Publishing a question: a version number and a change note.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.mcq.id}`,
    act: (p) => p.keyboard.press("Control+Shift+P"),
    action: "Pressed Ctrl+Shift+P in the editor.",
    state: "As seeded.",
  },
  {
    name: "try-mcq-graded",
    caption: "Trying a question as a student, and grading the answer on the spot.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.mcq.id}?tab=try`,
    act: async (p) => {
      // The radio is a clipped `sr-only` input: the row's label is what a
      // mouse hits.
      await p.locator("label").filter({ has: p.locator("input[type=radio]") }).first().click();
      await p.getByRole("button", { name: /^grade my answer$/i }).first().click();
      await p.getByRole("button", { name: /^try again$/i }).waitFor({ timeout: 15000 });
      await p.waitForTimeout(500);
    },
    action: "Chose the first answer, clicked “Grade my answer”.",
    state: "As seeded.",
  },
  {
    name: "try-code",
    caption: "Trying a code question: the program is compiled and run by the code runner.",
    persona: "teacher",
    path: (w) => `/questions/${w.questions.code.id}?tab=try`,
    settle: 5000,
    fullPage: true,
    act: async (p) => {
      await p.getByRole("button", { name: /^run$/i }).first().click();
      await p.getByText(/^Compiled$/).first().waitFor({ timeout: 90000 });
      await p.getByRole("button", { name: /^grade my answer$/i }).first().click();
      await p.getByRole("button", { name: /^try again$/i }).waitFor({ timeout: 90000 });
      await p.waitForTimeout(500);
    },
    action: "Clicked “Run” on the visible cases, then “Grade my answer”, with the template as it is.",
    state: "As seeded; a real code runner compiled and ran the program.",
  },

  // The evaluation configuration
  {
    name: "eval-questions",
    caption: "Configuring an evaluation, step 1: the questions.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.draft.id}?step=questions`,
    state: "As seeded: the draft “Test 1 — pointeurs”, five questions.",
  },
  {
    name: "eval-timing",
    caption: "Step 2: time and mode.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.draft.id}?step=timing`,
    state: "As seeded: the draft “Test 1 — pointeurs”.",
  },
  {
    name: "eval-launch",
    caption: "Step 3: launch.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.draft.id}?step=launch`,
    state: "As seeded: the draft “Test 1 — pointeurs”.",
  },
  {
    name: "eval-preview",
    caption: "The student preview of an evaluation, from the launch step.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.draft.id}?step=launch`,
    act: (p) => p.getByRole("button", { name: /^preview as student$/i }).first().click(),
    action: "Clicked “Preview as student”.",
    state: "As seeded: the draft “Test 1 — pointeurs”.",
  },
  {
    name: "eval-scheduled",
    caption: "A scheduled evaluation: it opens by itself at the announced time.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.scheduled.id}`,
    state: "As seeded: “Test 2 — chaînes”, scheduled two days ahead.",
  },

  // The live dashboard
  {
    name: "live-lobby",
    caption: "The dashboard of an evaluation in its lobby: the class is gathering.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.lobby.id}/live`,
    phase: "lobby",
    settle: 2500,
    state: "“Quiz d'entraînement” in its lobby; Léa and Noah have the lobby page open.",
  },
  {
    name: "live-running",
    caption: "The dashboard during the evaluation: one row per student, one cell per question.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.lobby.id}/live`,
    phase: "running",
    settle: 2500,
    state:
      "“Quiz d'entraînement” running: Noah handed in, Léa answered two questions, Emma one, Louis only opened it.",
  },
  {
    name: "live-inspect",
    caption: "A cell opened: what the student wrote, live.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.lobby.id}/live`,
    phase: "running",
    settle: 2500,
    act: (p) => p.getByRole("button", { name: /· Question 1$/ }).first().click(),
    action: "Clicked the first student's cell of question 1.",
    state: "“Quiz d'entraînement” running (see live-running).",
  },
  {
    name: "live-extend",
    caption: "Giving more time: to the whole class or to one student.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.lobby.id}/live`,
    phase: "running",
    settle: 2500,
    act: (p) => p.getByRole("button", { name: /^extend$/i }).first().click(),
    action: "Clicked “Extend”.",
    state: "“Quiz d'entraînement” running (see live-running).",
  },
  {
    name: "live-closed",
    caption: "The dashboard of a closed evaluation: verdicts and scores.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/live`,
    settle: 2500,
    state: "As seeded: “Test 0 — bases du C”, closed and graded.",
  },

  // Grading and results (before the release)
  {
    name: "grading",
    caption: "The grading panel, by question: the automatic gradings, validated or waiting for the teacher.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/grading`,
    fullPage: true,
    state: "“Test 0” graded by the real runner, results unreleased.",
  },
  {
    name: "grading-short",
    caption: "Grading a short-answer question.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/grading`,
    fullPage: true,
    act: (p) => nextQuestion(p, 1),
    action: "Moved to the next question (the short answer).",
    state: "“Test 0” graded by the real runner, unreleased.",
  },
  {
    name: "grading-cloze",
    caption: "Grading a fill-in-the-blanks question.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/grading`,
    fullPage: true,
    act: (p) => nextQuestion(p, 3),
    action: "Moved three questions forward (the cloze).",
    state: "“Test 0” graded by the real runner, unreleased.",
  },
  {
    name: "grading-code",
    caption: "Grading a code question: compilation and test cases per student.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/grading`,
    fullPage: true,
    act: (p) => nextQuestion(p, 4),
    action: "Moved four questions forward (the code question).",
    state: "“Test 0” graded by the real runner, unreleased.",
  },
  {
    name: "grading-by-student",
    caption: "The same panel, by student.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/grading`,
    fullPage: true,
    act: (p) => p.locator("label").filter({ hasText: /^By student$/ }).first().click(),
    action: "Switched the order to “By student”.",
    state: "“Test 0” graded by the real runner, unreleased.",
  },
  {
    name: "grading-override",
    caption: "Adjusting a grading by hand: points and a comment the student will read.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/grading`,
    act: (p) => p.getByRole("button", { name: /^adjust$/i }).first().click(),
    action: "Clicked “Adjust” on the first grading.",
    state: "“Test 0” graded by the real runner, unreleased.",
  },
  {
    name: "grading-batch",
    caption: "Validating every proposal of a question at once (here the code answers the seed could not run).",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/grading`,
    act: (p) => nextQuestion(p, 4),
    // The click is NOT made: under eleven proposals the button validates on
    // the spot (BatchBar.BATCH_CONFIRM_THRESHOLD), and the seed never holds
    // more than the four code answers. The confirm dialog itself is out of
    // reach of the demo world.
    action: "Moved to the code question; the batch bar offers to validate its proposals.",
    state: "As seeded: the four code answers of “Test 0” are proposals waiting for a runner (reason runner_unavailable), the rest is validated.",
  },
  {
    name: "results",
    caption: "The results of an evaluation, by student, before they are published.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/results`,
    fullPage: true,
    state: "“Test 0” graded, unreleased; Gabriel absent, Chloé never handed in.",
  },
  {
    name: "results-questions",
    caption: "The results by question: success rate and discrimination.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/results?tab=questions`,
    fullPage: true,
    settle: 2500,
    state: "“Test 0” graded by the real runner, unreleased.",
  },
  {
    name: "results-release-confirm",
    caption: "Publishing the results: the students see their feedback from then on.",
    phase: "graded",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/results`,
    act: (p) => p.getByRole("button", { name: /^publish results$/i }).first().click(),
    action: "Clicked “Publish results”.",
    state: "“Test 0” graded by the real runner, unreleased.",
  },

  // Live polls
  {
    name: "poll-launcher",
    caption: "The poll launcher: pick a question, or write one, and start.",
    persona: "teacher",
    path: "/polls",
    phase: "running",
    state: "Reached from the “Poll” button of the navigation; no poll yet.",
  },
  {
    name: "poll-projection",
    caption: "The projection of a running poll: the question, the live tally, the join code and its QR.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.poll.id}/poll`,
    phase: "poll-open",
    settle: 2500,
    state: "A poll on “prg1-pointeur-non-initialise”; three students answered. The tally is live, the correct answer is not revealed yet.",
  },
  {
    name: "join-mcq",
    caption: "A phone joining the poll through the code.",
    persona: "guest",
    path: (w) => `/p/${w.poll.code}`,
    phase: "poll-open",
    phone: "only",
    settle: 2500,
    state: "The same poll, open; a browser with no session (a guest).",
  },
  {
    name: "poll-revealed",
    caption: "The answer revealed: the tally, with the correct choice marked.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.poll.id}/poll`,
    phase: "poll-revealed",
    settle: 2500,
    state: "The same poll after the teacher revealed the answer (two guest phones joined for the join scenes).",
  },
  {
    name: "join-revealed",
    caption: "The phone after the reveal.",
    persona: "guest",
    path: (w) => `/p/${w.poll.code}`,
    phase: "poll-revealed",
    phone: "only",
    settle: 2500,
    state: "The same poll after the reveal; a guest browser.",
  },
  {
    name: "poll-ended",
    caption: "The poll ended.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.poll.id}/poll`,
    phase: "poll-ended",
    settle: 2500,
    state: "The same poll after the teacher ended it.",
  },

  // Chrome: bell, palette, settings, admin
  {
    name: "notifications",
    caption: "The notifications bell, here with nothing new: a pool shared with you shows up in it.",
    persona: "teacher",
    path: "/",
    phase: "running",
    act: (p) => p.getByRole("button", { name: /^notifications/i }).first().click(),
    action: "Clicked the bell in the header.",
    state: "After the exercise started and Noah handed in.",
  },
  {
    name: "palette",
    caption: "The command palette (Ctrl+K): every screen and action, from anywhere.",
    persona: "teacher",
    path: "/",
    act: (p) => p.keyboard.press("Control+k"),
    action: "Pressed Ctrl+K.",
    state: "As seeded.",
  },
  {
    name: "palette-query",
    caption: "The palette filtering on “grad”.",
    persona: "teacher",
    path: "/",
    act: async (p) => {
      await p.keyboard.press("Control+k");
      await p.keyboard.type("grad");
    },
    action: "Pressed Ctrl+K and typed “grad”.",
    state: "As seeded.",
  },
  {
    name: "settings",
    caption: "The settings: language, theme, notifications.",
    persona: "teacher",
    path: "/settings",
    state: "As seeded.",
  },
  {
    name: "admin",
    caption: "The administration screen: who is a teacher.",
    persona: "admin",
    path: "/admin",
    state: "As seeded: one teacher.",
  },

  // Student
  {
    name: "student-home",
    caption: "The student's home: what is open, what is coming, what is past.",
    persona: "lea",
    path: "/",
    phone: true,
    state: "As seeded: one exercise in its lobby, one scheduled test, one past test.",
  },
  {
    name: "student-lobby",
    caption: "The lobby: the student waits for the teacher to start.",
    persona: "lea",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "lobby",
    settle: 2500,
    state: "“Quiz d'entraînement” in its lobby.",
  },
  {
    name: "player-mcq",
    caption: "The player on a multiple-choice question.",
    persona: "lea",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "running",
    phone: true,
    settle: 2500,
    state: "“Quiz d'entraînement” running; Léa has answered the first two questions.",
  },
  {
    name: "player-cloze",
    caption: "The player on a fill-in-the-blanks question.",
    persona: "lea",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "running",
    settle: 2500,
    act: (p) => openQuestion(p, 3),
    action: "Moved to question 3 through the progress strip.",
    state: "“Quiz d'entraînement” running.",
  },
  {
    name: "player-short",
    caption: "The player on a short-answer question.",
    persona: "lea",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "running",
    settle: 2500,
    act: (p) => openQuestion(p, 4),
    action: "Moved to question 4 through the progress strip.",
    state: "“Quiz d'entraînement” running.",
  },
  {
    name: "player-code",
    caption: "The player on a code question: the editable regions of the template.",
    persona: "lea",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "running",
    settle: 2500,
    act: async (p) => {
      await openQuestion(p, 5);
      await p.waitForTimeout(3000);
    },
    action: "Moved to question 5 through the progress strip.",
    state: "“Quiz d'entraînement” running; Léa's region holds a solution, not yet marked done.",
  },
  {
    name: "player-run",
    caption: "Running the program against the visible cases before handing in.",
    persona: "lea",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "running",
    fullPage: true,
    settle: 2500,
    act: async (p) => {
      await openQuestion(p, 5);
      await p.waitForTimeout(3000);
      await p.getByRole("button", { name: /^run$/i }).first().click();
      await p.getByText(/^Compiled$/).first().waitFor({ timeout: 90000 });
      await p.waitForTimeout(800);
    },
    action: "Moved to question 5, clicked “Run”, waited for “Compiled”.",
    state: "“Quiz d'entraînement” running; Léa's region holds a solution.",
  },
  {
    name: "player-submit",
    caption: "Handing in: the confirmation names what is still unanswered.",
    persona: "lea",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "running",
    settle: 2500,
    act: (p) => p.getByRole("button", { name: /^hand in$/i }).first().click(),
    action: "Clicked “Hand in”.",
    state: "“Quiz d'entraînement” running; Léa has answered two questions of five.",
  },
  {
    name: "player-done",
    caption: "After handing in.",
    persona: "noah",
    path: (w) => `/take/${w.evals.lobby.id}`,
    phase: "running",
    settle: 2500,
    state: "“Quiz d'entraînement” running; Noah handed in.",
  },
  {
    name: "feedback-pending",
    caption: "The student's results page while the teacher has not published yet.",
    phase: "graded",
    persona: "lea",
    path: (w) => `/attempts/${w.closedAttempt}/feedback`,
    state: "“Test 0” graded by the real runner, unreleased.",
  },
  {
    name: "results-released",
    caption: "The results after publication.",
    persona: "teacher",
    path: (w) => `/evaluations/${w.evals.closed.id}/results`,
    phase: "released",
    fullPage: true,
    state: "“Test 0” released by the teacher.",
  },
  {
    name: "feedback",
    caption: "The student's feedback: points, verdicts, explanations and the teacher's comments.",
    persona: "lea",
    path: (w) => `/attempts/${w.closedAttempt}/feedback`,
    phase: "released",
    phone: true,
    fullPage: true,
    state: "“Test 0” released by the teacher.",
  },
  {
    name: "student-settings",
    caption: "The settings, as a student.",
    persona: "lea",
    path: "/settings",
    state: "As seeded.",
  },
];

// --- Page helpers (the same idea as the mock script) ---------------------

/** Moves the player to question `n` through its progress strip. */
async function openQuestion(page, n) {
  await page.getByRole("button", { name: new RegExp(`^Question ${n},`) }).click();
  await page.waitForTimeout(400);
}

/** Opens the overflow menu of a table row. */
async function openRowMenu(page, triggerName) {
  const trigger = page.getByRole("button", { name: triggerName }).first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
}

/** Walks the grading panel forward `n` questions with its own control. */
async function nextQuestion(page, n) {
  for (let i = 0; i < n; i += 1) {
    await page.getByRole("button", { name: /^next question$/i }).first().click();
    await page.waitForTimeout(400);
  }
}

// --- API sessions --------------------------------------------------------

/**
 * One persona's session over the API: the dev login sets the cookies, and
 * every mutation carries the double-submit CSRF header, exactly like the
 * SPA (see `api()` in scripts/smoke.sh).
 */
class Api {
  constructor(ctx, persona, csrf) {
    this.ctx = ctx;
    this.persona = persona;
    this.csrf = csrf;
  }

  static async open(persona) {
    const ctx = await request.newContext({ baseURL: BASE });
    const csrf = await login(ctx, persona);
    return new Api(ctx, persona, csrf);
  }

  async call(method, urlPath, body) {
    const res = await this.ctx.fetch(urlPath, {
      method,
      headers: { "x-csrf-token": this.csrf },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok()) {
      const err = new Error(`${method} ${urlPath} → ${res.status()} ${text.slice(0, 200)}`);
      err.status = res.status();
      err.body = json;
      throw err;
    }
    return json;
  }

  get(p) {
    return this.call("GET", p);
  }
  post(p, body = {}) {
    return this.call("POST", p, body);
  }
  put(p, body) {
    return this.call("PUT", p, body);
  }
  patch(p, body) {
    return this.call("PATCH", p, body);
  }
  dispose() {
    return this.ctx.dispose();
  }
}

/** Signs a request context (or a browser context's) in; returns the CSRF token. */
async function login(ctx, persona) {
  const res = await ctx.post(`${BASE}/app/auth/dev`, {
    form: { persona },
    maxRedirects: 0,
  });
  if (res.status() !== 302) throw new Error(`dev login as ${persona}: HTTP ${res.status()}`);
  const state = await ctx.storageState();
  const csrf = state.cookies.find((c) => c.name === "quiz_csrf")?.value;
  if (!csrf) throw new Error(`dev login as ${persona}: no CSRF cookie`);
  return csrf;
}

/** A preparation step that may already have happened: logged, never fatal. */
async function tolerant(what, fn) {
  try {
    await fn();
    console.log(`   ok  ${what}`);
  } catch (e) {
    console.log(`   ..  ${what}: ${String(e.message ?? e).split("\n")[0]}`);
  }
}

// --- The world -----------------------------------------------------------

/** Every id over the API, nothing hardcoded. */
async function discover(world) {
  const teacher = world.api.teacher;
  const courses = await teacher.get("/app/api/courses");
  world.course = courses.find((c) => c.code === "PRG1") ?? courses[0];
  if (!world.course) throw new Error("no course: is the database seeded?");
  const detail = await teacher.get(`/app/api/courses/${world.course.id}`);
  world.classroom =
    detail.classrooms.find((r) => r.name === "PRG1-2026") ?? detail.classrooms[0];
  const pools = await teacher.get("/app/api/pools");
  world.pool = pools.find((p) => p.name === "Programmation C") ?? pools[0];
  const items = (await teacher.get(`/app/api/pools/${world.pool.id}/questions?limit=100`)).items;
  world.questions = {};
  for (const [key, internalName] of Object.entries(QUESTIONS)) {
    const q = items.find((i) => i.internalName === internalName);
    if (!q) throw new Error(`question ${internalName} is not in the pool`);
    world.questions[key] = q;
  }
  await refreshEvaluations(world);
  const home = await world.api.lea.get("/app/api/student/home");
  world.closedAttempt = [...home.past, ...home.open].find(
    (e) => e.id === world.evals.closed.id,
  )?.attemptId;
  if (!world.closedAttempt) throw new Error("Léa has no attempt on the closed evaluation");
}

async function refreshEvaluations(world) {
  const list = await world.api.teacher.get(
    `/app/api/classrooms/${world.classroom.id}/evaluations`,
  );
  world.evals = {};
  for (const [key, title] of Object.entries(TITLES)) {
    const e = list.find((x) => x.title === title);
    if (!e) throw new Error(`evaluation “${title}” is not in the classroom`);
    world.evals[key] = e;
  }
}

/** A plausible answer for an item of the student view. */
function answerFor(item, variant) {
  switch (item.type) {
    case "mcq": {
      const ids = (item.student?.choices ?? []).map((c) => c.id);
      if (ids.length === 0) return { selected: [0] };
      if (item.student?.mode === "multiple") {
        return { selected: [ids[0], ids[Math.min(1 + variant, ids.length - 1)]].sort((a, b) => a - b) };
      }
      return { selected: [ids[variant % ids.length]] };
    }
    case "short":
      return { text: variant === 0 ? "const" : "static" };
    case "cloze": {
      const n = (item.student?.segments ?? []).filter((s) => s.kind !== "text").length || 3;
      const key = ["0", "<", "++"];
      return { blanks: Array.from({ length: n }, (_, i) => (variant === 0 ? key[i] ?? "0" : "0")) };
    }
    case "code":
      return { regions: [SUM_SOLUTION] };
    default:
      return {};
  }
}

/** A revision strictly greater than any earlier run's: seconds since 2026. */
const revision = () => Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000);

/** Enters the evaluation as a student and returns the attempt view (or null in the lobby). */
async function enter(api, evaluationId) {
  const r = await api.post(`/app/api/evaluations/${evaluationId}/attempt`, {});
  return r.kind === "attempt" ? r.view : null;
}

async function answer(api, view, itemIndex, variant, { done = true } = {}) {
  const item = view.items[itemIndex];
  if (!item) return;
  await api.put(`/app/api/attempts/${view.attempt.id}/answers/${item.id}`, {
    payload: answerFor(item, variant),
    revision: revision(),
    clientTs: new Date().toISOString(),
  });
  if (done) {
    await api.post(`/app/api/attempts/${view.attempt.id}/answers/${item.id}/done`, { done: true });
  }
}

/** Keeps a student's page open on a URL, so the dashboard sees them present. */
async function hold(world, persona, urlPath) {
  const ctx = await world.browser.newContext({ viewport: DESKTOP });
  await ctx.addInitScript(() => {
    localStorage.setItem("quiz-locale", "en");
  });
  await login(ctx.request, persona);
  const page = await ctx.newPage();
  await page.goto(BASE + urlPath, { waitUntil: "load" });
  world.held.push(ctx);
}

async function releaseHeld(world) {
  for (const ctx of world.held) await ctx.close().catch(() => {});
  world.held = [];
}

// --- The phases ----------------------------------------------------------

const prepare = {
  seeded: async () => {
    console.log("== phase seeded");
  },

  // The seed grades "Test 0" with no runner: its code answers are PROPOSALS
  // with the reason `runner_unavailable` (decision D14), which is what the
  // batch-validate scene shows. With a runner beside this instance, one more
  // pass settles them with real verdicts — a validated grading is never
  // touched by a pass (`grading/jobs.ts`).
  graded: async (world) => {
    const { teacher } = world.api;
    const closed = world.evals.closed;
    console.log("== phase graded");
    await tolerant("the code answers of “Test 0” are graded by the runner", async () => {
      const progress = await teacher.get(`/app/api/evaluations/${closed.id}/grading/progress`);
      if (progress.pending.runner === 0) return;
      const health = await teacher.get("/healthz");
      if (health.checks?.runner !== "up") throw new Error(`runner is ${health.checks?.runner}`);
      await teacher.post(`/app/api/evaluations/${closed.id}/grade`, {});
      for (let i = 0; i < 120; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const p = await teacher.get(`/app/api/evaluations/${closed.id}/grading/progress`);
        if (p.pending.runner === 0 && p.pending.llm === 0) return;
      }
      throw new Error("the pass did not settle in 60 s");
    });
  },

  lobby: async (world) => {
    const { teacher } = world.api;
    const lobby = world.evals.lobby;
    console.log(`== phase lobby (“${lobby.title}”)`);
    // The seeded exercise has two MCQs and a cloze; the player scenes want
    // the four types, so a short and a code question join it — which is only
    // possible while nobody has opened it (lobby → draft → lobby).
    await tolerant("the exercise carries a short-answer and a code question", async () => {
      const detail = await teacher.get(`/app/api/evaluations/${lobby.id}`);
      const have = new Set(detail.items.map((i) => i.questionId));
      const missing = [world.questions.short, world.questions.code]
        .filter((q) => !have.has(q.id))
        .map((q) => q.id);
      if (missing.length === 0) return;
      if (detail.attemptCount > 0) throw new Error("an attempt exists, items left as they are");
      if (detail.evaluation.state === "lobby") {
        await teacher.post(`/app/api/evaluations/${lobby.id}/state`, { to: "draft" });
      }
      await teacher.post(`/app/api/evaluations/${lobby.id}/items`, { questionIds: missing });
      await teacher.post(`/app/api/evaluations/${lobby.id}/state`, { to: "lobby" });
    });
    await refreshEvaluations(world);
    if (world.evals.lobby.state === "lobby") {
      await tolerant("Léa and Noah wait in the lobby", async () => {
        await hold(world, "lea", `/take/${lobby.id}`);
        await hold(world, "noah", `/take/${lobby.id}`);
        await new Promise((r) => setTimeout(r, 1500));
      });
    }
  },

  running: async (world) => {
    const { teacher, lea, noah, emma, louis } = world.api;
    const lobby = world.evals.lobby;
    console.log(`== phase running (“${lobby.title}”)`);
    await tolerant("the teacher starts the exercise", async () => {
      if (world.evals.lobby.state !== "lobby") throw new Error(`already ${world.evals.lobby.state}`);
      await teacher.post(`/app/api/evaluations/${lobby.id}/start`, { confirm: true });
    });
    await refreshEvaluations(world);
    await tolerant("Noah answers every question and hands in", async () => {
      const view = await enter(noah, lobby.id);
      if (!view) throw new Error("still in the lobby");
      if (view.attempt.state !== "in_progress") throw new Error(`attempt is ${view.attempt.state}`);
      for (let i = 0; i < view.items.length; i += 1) await answer(noah, view, i, 0);
      await noah.post(`/app/api/attempts/${view.attempt.id}/submit`, { confirm: true });
    });
    await tolerant("Léa answers the first two questions and fills the code region", async () => {
      const view = await enter(lea, lobby.id);
      if (!view) throw new Error("still in the lobby");
      if (view.attempt.state !== "in_progress") throw new Error(`attempt is ${view.attempt.state}`);
      await answer(lea, view, 0, 1);
      await answer(lea, view, 1, 1);
      const code = view.items.findIndex((i) => i.type === "code");
      if (code >= 0) await answer(lea, view, code, 0, { done: false });
      // Back on the first question, so the player opens there.
      await lea.post(`/app/api/attempts/${view.attempt.id}/position`, { itemId: view.items[0].id });
    });
    await tolerant("Emma answers one question", async () => {
      const view = await enter(emma, lobby.id);
      if (!view) throw new Error("still in the lobby");
      if (view.attempt.state !== "in_progress") throw new Error(`attempt is ${view.attempt.state}`);
      await answer(emma, view, 0, 0);
    });
    await tolerant("Louis only opens it", async () => {
      await enter(louis, lobby.id);
    });
    // The held lobby pages have moved to the player on their own; they stay
    // open so the dashboard shows Léa and Noah as present.
    await new Promise((r) => setTimeout(r, 1500));
  },

  "poll-open": async (world) => {
    const { teacher, lea, noah, emma } = world.api;
    console.log("== phase poll-open");
    await releaseHeld(world);
    const created = await teacher.post("/app/api/polls", {
      questionId: world.questions.mcq.id,
      classroomId: world.classroom.id,
      anonymous: true,
    });
    world.poll = { id: created.evaluation.id, code: created.evaluation.code };
    console.log(`   ok  poll ${world.poll.code} created`);
    let variant = 0;
    for (const student of [lea, noah, emma]) {
      const v = variant;
      variant += 1;
      await tolerant(`${student.persona} answers the poll`, async () => {
        const view = await student.post(`/app/api/p/${world.poll.code}/join`, {});
        const ids = (view.question?.student?.choices ?? []).map((c) => c.id);
        const pick = ids.length ? ids[Math.min(v === 2 ? 0 : v, ids.length - 1)] : 0;
        await student.post(`/app/api/p/${world.poll.code}/answer`, {
          payload: { selected: [pick] },
        });
      });
    }
  },

  "poll-revealed": async (world) => {
    console.log("== phase poll-revealed");
    await tolerant("the teacher reveals the answer", () =>
      world.api.teacher.post(`/app/api/evaluations/${world.poll.id}/poll/reveal`, { revealed: true }),
    );
  },

  "poll-ended": async (world) => {
    console.log("== phase poll-ended");
    await tolerant("the teacher ends the poll", () =>
      world.api.teacher.post(`/app/api/evaluations/${world.poll.id}/poll/end`, {}),
    );
  },

  released: async (world) => {
    const closed = world.evals.closed;
    console.log(`== phase released (“${closed.title}”)`);
    await tolerant("the teacher publishes the results", async () => {
      if (closed.state === "released") throw new Error("already released");
      await world.api.teacher.post(`/app/api/evaluations/${closed.id}/release`, { confirm: true });
    });
    await refreshEvaluations(world);
  },
};

// --- One scene -----------------------------------------------------------

function fileOf(scene, theme, phone) {
  return `${scene.name}${phone ? "-phone" : ""}-${theme}.png`;
}

async function capture(world, scene, theme, phone) {
  const viewport = phone ? PHONE : DESKTOP;
  const ctx = await world.browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: "en-GB",
  });
  const problems = [];
  try {
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("quiz-locale", "en");
        localStorage.setItem("quiz-theme", t);
      } catch {
        /* a private window; the defaults are then the system's */
      }
    }, theme);
    if (scene.persona !== "none" && scene.persona !== "guest") {
      await login(ctx.request, scene.persona);
    }
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(String(e).split("\n")[0]));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text().split("\n")[0];
      if (scene.ignore?.test(text)) return;
      // A browser with no session is told 401 by `/app/api/me`: that is the
      // page finding out who it is, not an error of the scene.
      if ((scene.persona === "none" || scene.persona === "guest") && /401/.test(text)) return;
      problems.push(text);
    });
    const urlPath = typeof scene.path === "function" ? scene.path(world) : scene.path;
    await page.goto(BASE + urlPath, { waitUntil: "load" });
    // An open SSE stream keeps the network busy for ever: idle is a bonus,
    // the settle delay is the guarantee.
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(scene.settle ?? 1500);
    if (scene.act) {
      await scene.act(page, world);
      // The click leaves the pointer over whatever took the button's place,
      // and a sheet moves the focus to its first control: either raises a
      // tooltip that would sit in the picture. Park the mouse, drop the focus.
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.waitForTimeout(700);
    }
    const file = path.join(OUT, fileOf(scene, theme, phone));
    if (scene.fullPage) {
      // Not Playwright's `fullPage`: the sidebar is viewport-high and sticky,
      // and a stitched capture leaves it floating mid-page. A taller viewport
      // is what a taller screen would show.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 6000) });
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: file });
    return { file, problems, ok: true };
  } catch (e) {
    problems.push(`scene failed: ${String(e.message ?? e).split("\n")[0]}`);
    return { file: null, problems, ok: false };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// --- Main ----------------------------------------------------------------

if (flag("list")) {
  for (const s of scenes) console.log(`${s.name.padEnd(26)} ${s.phase ?? "seeded"}`);
  process.exit(0);
}

const picked = scenes.filter((s) => only.length === 0 || only.some((f) => s.name.includes(f)));
if (picked.length === 0) {
  console.error(`No scene matches ${only.join(", ")}. Try --list.`);
  process.exit(1);
}
const phaseIndex = (s) => PHASES.indexOf(s.phase ?? "seeded");
const lastPhase = Math.max(...picked.map(phaseIndex));

fs.mkdirSync(OUT, { recursive: true });
const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
})();
const takenAt = new Date().toISOString();

const world = { api: {}, held: [], browser: await chromium.launch() };
for (const persona of ["teacher", "lea", "noah", "emma", "louis"]) {
  world.api[persona] = await Api.open(persona);
}
await discover(world);
console.log(`world: course ${world.course.code}, classroom ${world.classroom.name}, pool “${world.pool.name}”, ${Object.keys(world.evals).length} evaluations`);

const manifestPath = path.join(OUT, "manifest.json");
const previous = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).scenes ?? []
  : [];
const results = new Map(previous.map((e) => [e.name, e]));
const failed = [];
let problemCount = 0;

for (let i = 0; i <= lastPhase; i += 1) {
  const phase = PHASES[i];
  await prepare[phase](world);
  for (const scene of picked.filter((s) => phaseIndex(s) === i)) {
    const variants = scene.phone === "only" ? [true] : scene.phone ? [false, true] : [false];
    for (const phone of variants) {
      const entryName = `${scene.name}${phone ? "-phone" : ""}`;
      const files = {};
      const problems = [];
      let ok = true;
      for (const theme of THEMES) {
        const r = await capture(world, scene, theme, phone);
        if (r.ok) files[theme] = path.basename(r.file);
        else ok = false;
        for (const p of r.problems) problems.push(`${theme}: ${p}`);
        console.log(
          `${(r.file ? path.relative(ROOT, r.file) : `${entryName}-${theme} FAILED`).padEnd(60)}${r.problems.length ? `  PROBLEMS: ${r.problems.join(" | ").slice(0, 400)}` : ""}`,
        );
      }
      if (problems.length) problemCount += 1;
      if (!ok) {
        failed.push({ name: entryName, problems });
        results.delete(entryName);
        for (const theme of THEMES) fs.rmSync(path.join(OUT, fileOf(scene, theme, phone)), { force: true });
        continue;
      }
      const viewport = phone ? PHONE : DESKTOP;
      const kept = results.get(entryName) ?? {};
      results.set(entryName, {
        name: entryName,
        caption: scene.caption,
        persona: scene.persona,
        path: typeof scene.path === "function" ? scene.path(world) : scene.path,
        width: viewport.width,
        height: viewport.height,
        fullPage: Boolean(scene.fullPage),
        theme: ["light", "dark"],
        action: scene.action ?? "Nothing: the page as it loads.",
        state: scene.state,
        phase: scene.phase ?? "seeded",
        files: { ...(kept.files ?? {}), ...files },
        takenAt,
        commit,
        base: BASE,
      });
    }
  }
}

await releaseHeld(world);
for (const api of Object.values(world.api)) await api.dispose();
await world.browser.close();

// The manifest keeps the order of the scene list; entries of scenes that no
// longer exist are dropped.
const order = new Map();
scenes.forEach((s, i) => {
  order.set(s.name, i * 2);
  order.set(`${s.name}-phone`, i * 2 + 1);
});
const entries = [...results.values()]
  .filter((e) => order.has(e.name))
  .sort((a, b) => order.get(a.name) - order.get(b.name));
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      generatedBy: "apps/web/scripts/docs-screenshots.mjs",
      base: BASE,
      viewports: { desktop: DESKTOP, phone: PHONE },
      phases: PHASES,
      scenes: entries,
    },
    null,
    2,
  )}\n`,
);
console.log(`\n${entries.length} scene(s) in ${path.relative(ROOT, manifestPath)}`);
// The table of docs/development/screenshots.md follows the manifest.
writeSceneTable();
if (problemCount) console.error(`${problemCount} scene(s) reported console or page errors.`);
if (failed.length) {
  console.error(`${failed.length} scene(s) FAILED and were left out of the manifest:`);
  for (const f of failed) console.error(`  ${f.name}: ${f.problems.join(" | ")}`);
  process.exitCode = 1;
}
