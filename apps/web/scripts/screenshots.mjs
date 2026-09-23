// Screenshots of the mocked web app, for the visual check required by
// `.claude/skills/quiz-ui/SKILL.md`. Development tool only: it is never
// imported by the app, never bundled and never runs in CI.
//
//   pnpm --filter @quiz/web dev:mock          # in one terminal
//   pnpm --filter @quiz/web screenshots       # in another
//
// Flags: --dark, --width=390|768|1440 (repeatable), --only=<substring>,
//        --fold (viewport only, instead of the full page), --list.
// Environment: BASE (default http://localhost:5173), OUT (default
// apps/web/screenshots).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = process.env.OUT ?? path.resolve(here, "..", "screenshots");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) =>
  argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const dark = flag("dark");
const fullPage = !flag("fold");
const only = opt("only").concat(argv.filter((a) => !a.startsWith("--")));
const widths = opt("width").map(Number).filter(Boolean);

// --- Scenes, as data ---------------------------------------------------
//
// name   file name (plus the theme and width suffixes)
// role   mock persona: teacher | student | admin
// path   URL under BASE; scene flags of the mock go in the query string
// ls     extra localStorage entries, written before the first paint
// ss     extra sessionStorage entries (the student view lives there: it is a
//        property of the WINDOW, not of the browser)
// act    what to open once the page settled (a sheet, a menu, a dialog)
// fold   viewport only, whatever --fold says. For a scene whose layer is
//        `fixed`: full-page, the backdrop covers the viewport and everything
//        below the fold comes out undimmed, which reads as a bug and is not
//        what anyone sees.

/** The mock's evaluation, taken by the student persona (WP9). */
const TAKE = "/take/11111111-1111-4111-8111-111111111111";
/**
 * The student persona's two attempts (WP9 + WP10). The first is pinned on the
 * evaluation the mock leaves CLOSED and unreleased — its feedback page is the
 * "not published yet" state — and the second on the RELEASED one.
 */
const ATTEMPT_OPEN = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_PAST = "22222222-2222-4222-8222-222222222223";

const scenes = [
  // Teacher home (the courses)
  { name: "teacher-home", role: "teacher", path: "/" },
  { name: "teacher-home-empty", role: "teacher", path: "/?empty=1" },
  { name: "teacher-home-error", role: "teacher", path: "/?fail=1", settle: 2500 },
  { name: "teacher-home-loading", role: "teacher", path: "/?slow=1", settle: 300 },
  { name: "teacher-home-many", role: "teacher", path: "/?many=1" },
  // The same list as a table; the choice lives in localStorage.
  { name: "teacher-home-list", role: "teacher", path: "/", ls: { "quiz-courses-view": "list" } },
  { name: "teacher-home-list-many", role: "teacher", path: "/?many=1", ls: { "quiz-courses-view": "list" } },
  { name: "course-link-pool", role: "teacher", path: "/", fold: true, act: (p) => p.getByRole("button", { name: /link a pool|lier une banque/i }).first().click() },
  { name: "course-new", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /new course/i }).first().click() },
  { name: "classroom-new", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /new classroom/i }).first().click() },

  // Classroom. Two tabs: the roster and the evaluations. Without `?tab=` the
  // page opens on the evaluations, which is where the work is once the
  // classroom has students, so every roster scene names its tab.
  { name: "classroom", role: "teacher", path: "/classrooms/r1" },
  { name: "classroom-roster", role: "teacher", path: "/classrooms/r1?tab=roster" },
  { name: "classroom-empty", role: "teacher", path: "/classrooms/r1?empty=1", settle: 800 },
  { name: "classroom-error", role: "teacher", path: "/classrooms/r1?fail=1", settle: 2500 },
  { name: "classroom-loading", role: "teacher", path: "/classrooms/r1?slow=1", settle: 300 },
  { name: "classroom-roster-many", role: "teacher", path: "/classrooms/r1?tab=roster&many=1" },
  { name: "classroom-import", role: "teacher", path: "/classrooms/r1?tab=roster", act: (p) => p.getByRole("button", { name: /add students/i }).first().click() },
  { name: "classroom-menu", role: "teacher", path: "/classrooms/r1", fold: true, act: (p) => p.getByRole("button", { name: /^actions$/i }).first().click() },
  // The title renamed in place: the pencil is the affordance (it only exists
  // under the pointer), and the field that replaces the name must keep the
  // baseline it had.
  { name: "classroom-rename-hover", role: "teacher", path: "/classrooms/r1", fold: true, act: (p) => p.getByRole("button", { name: /^rename classroom/i }).first().hover() },
  { name: "classroom-rename", role: "teacher", path: "/classrooms/r1", fold: true, act: (p) => p.getByRole("button", { name: /^rename classroom/i }).first().click() },
  { name: "classroom-row-menu", role: "teacher", path: "/classrooms/r1?tab=roster", fold: true, act: (p) => openRowMenu(p, /^Actions for /) },

  // WP8: evaluation + dashboard. The mock addresses an evaluation by its
  // state as well as by its id, so these URLs are stable across reloads.
  { name: "eval-list", role: "teacher", path: "/classrooms/r1" },
  { name: "eval-config-questions", role: "teacher", path: "/evaluations/draft?step=questions" },
  { name: "eval-config-picker", role: "teacher", path: "/evaluations/draft?step=questions", act: (p) => p.getByRole("button", { name: /add questions/i }).first().click() },
  { name: "eval-config-milestone-gap", role: "teacher", path: "/evaluations/draft?step=questions", act: (p) => p.getByRole("button", { name: /^reorder /i }).first().hover() },
  { name: "eval-config-timing", role: "teacher", path: "/evaluations/draft?step=timing" },
  { name: "eval-config-advanced", role: "teacher", path: "/evaluations/draft?step=timing", act: (p) => p.getByRole("button", { name: /^advanced options$/i }).first().click() },
  { name: "eval-config-launch", role: "teacher", path: "/evaluations/draft?step=launch" },
  { name: "eval-config-loading", role: "teacher", path: "/evaluations/draft?slow=1", settle: 300 },
  { name: "eval-config-error", role: "teacher", path: "/evaluations/draft?fail=1", settle: 2500 },
  // The heading renames itself in place: closed, then open on the input.
  { name: "eval-rename", role: "teacher", path: "/evaluations/draft?step=questions", fold: true },
  { name: "eval-rename-editing", role: "teacher", path: "/evaluations/draft?step=questions", fold: true, act: (p) => p.getByRole("button", { name: /^(rename evaluation|renommer l'évaluation)/i }).first().click() },
  // ADR-018: the overflow of a teacher who already walked it (`?mytest=1`).
  { name: "eval-reset-attempt-menu", role: "teacher", path: "/evaluations/closed?mytest=1", fold: true, act: (p) => p.getByRole("button", { name: /^actions$/i }).first().click() },
  { name: "eval-reset-attempt-confirm", role: "teacher", path: "/evaluations/closed?mytest=1", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^actions$/i }).first().click();
      await p.getByRole("menuitem", { name: /reset my test attempt|réinitialiser ma tentative/i }).click();
    } },
  // The staff row, badged, in the three places attempts are listed.
  { name: "live-running-staff", role: "teacher", path: "/evaluations/running/live?mytest=1" },
  { name: "grading-staff", role: "teacher", path: "/evaluations/closed/grading?mytest=1" },
  { name: "results-staff", role: "teacher", path: "/evaluations/closed/results?mytest=1" },
  // The banner the walk comes back through: the student view, entered from an
  // evaluation, with "Back to teacher view" pointing at it.
  { name: "student-view-banner", role: "teacher", path: "/", ss: { "quiz-view-as": "student", "quiz-view-as-return": "/evaluations/closed" } },
  // The frame's teacher/student switch (ADR-018 addendum), both ways round.
  { name: "view-switch-teacher", role: "teacher", path: "/evaluations/running/live", fold: true, settle: 3000 },
  { name: "view-switch-student", role: "teacher", path: "/", fold: true, settle: 3000, ss: { "quiz-view-as": "student", "quiz-view-as-return": "/evaluations/running/live" } },
  { name: "live-running", role: "teacher", path: "/evaluations/running/live" },
  { name: "live-running-many", role: "teacher", path: "/evaluations/running/live?many=1" },
  { name: "live-lobby", role: "teacher", path: "/evaluations/lobby/live" },
  { name: "live-closed", role: "teacher", path: "/evaluations/closed/live" },
  { name: "live-inspect", role: "teacher", path: "/evaluations/running/live", act: (p) => p.getByRole("button", { name: /· Question 1$/ }).first().click() },
  { name: "live-extend-menu", role: "teacher", path: "/evaluations/running/live", fold: true, act: (p) => p.getByRole("button", { name: /^extend$/i }).first().click() },
  { name: "live-fullscreen", role: "teacher", path: "/evaluations/running/live", fold: true, act: (p) => p.getByRole("button", { name: /^full screen$/i }).first().click() },
  { name: "live-empty", role: "teacher", path: "/evaluations/running/live?empty=1", settle: 900 },
  { name: "live-loading", role: "teacher", path: "/evaluations/running/live?slow=1", settle: 300 },
  { name: "live-error", role: "teacher", path: "/evaluations/running/live?fail=1", settle: 2500 },

  // Student
  { name: "student-home", role: "student", path: "/" },
  { name: "student-empty", role: "student", path: "/?empty=1" },
  { name: "student-error", role: "student", path: "/?fail=1", settle: 2500 },
  { name: "student-loading", role: "student", path: "/?slow=1", settle: 300 },
  { name: "student-settings", role: "student", path: "/settings" },

  // WP9: student player. `TAKE` is the mock's evaluation; `?scene=` picks the
  // state the fake backend serves (see the WP9 block of src/mock/student.ts).
  { name: "student-home-eval", role: "student", path: "/" },
  { name: "student-lobby", role: "student", path: `${TAKE}?scene=lobby` },
  { name: "player-mcq", role: "student", path: `${TAKE}?scene=running` },
  { name: "player-cloze", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 2) },
  { name: "player-short", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 3) },
  { name: "player-code", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 4) },
  // The run is REAL here: the mock's code question says `runtime: "runno"`,
  // so this clicks Run and waits for clang.wasm to compile the program and
  // for the three cases to execute in a Web Worker (ADR-015). The first run
  // of a browser fetches ~53 MB of runtime, hence the wait.
  { name: "player-run", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 4); await p.getByRole("button", { name: /^(run|exécuter)$/i }).click(); await p.getByText(/^(Compiled|Compilé)$/).waitFor({ timeout: 60000 }); await p.waitForTimeout(500); } },
  { name: "player-run-manual", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 4); await p.getByLabel(/^(Arguments)$/).fill("220\n470"); await p.getByRole("button", { name: /^(run once|exécuter une fois)$/i }).click(); await p.getByLabel(/^(Output|Sortie)$/).waitFor({ timeout: 60000 }); await p.waitForTimeout(300); } },
  { name: "player-submit", role: "student", path: `${TAKE}?scene=running`, fold: true, act: (p) => p.getByRole("button", { name: /hand in/i }).first().click() },
  // A ONE-question evaluation: no progress strip and no previous / next,
  // and, once the question is marked done, "Hand in" takes the accent while
  // the footer offers the named way back.
  { name: "player-single", role: "student", path: `${TAKE}?scene=single` },
  { name: "player-single-done", role: "student", path: `${TAKE}?scene=single`, act: async (p) => { await p.getByRole("button", { name: /mark as done/i }).click(); await p.getByRole("button", { name: /reopen the question/i }).waitFor(); } },
  { name: "player-paused", role: "student", path: `${TAKE}?scene=paused`, fold: true },
  { name: "player-timeup", role: "student", path: `${TAKE}?scene=closed` },

  // Command palette (Ctrl+K from anywhere; the mock persona decides the groups)
  { name: "palette", role: "teacher", path: "/", fold: true, act: (p) => p.keyboard.press("Control+k") },
  { name: "palette-query", role: "teacher", path: "/", fold: true, act: async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("set"); } },
  { name: "palette-no-result", role: "teacher", path: "/", fold: true, act: async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("qqqq"); } },
  { name: "palette-many", role: "teacher", path: "/?many=1", fold: true, act: (p) => p.keyboard.press("Control+k") },
  { name: "palette-student", role: "student", path: "/", fold: true, act: (p) => p.keyboard.press("Control+k") },


  // Pools, the question editors and the try panel (WP7). The mock question
  // ids are stable: q1 code, q2 mcq, q3 short, q4 cloze.
  { name: "pools", role: "teacher", path: "/pools" },
  { name: "pools-list", role: "teacher", path: "/pools", ls: { "quiz-pools-view": "list" } },
  { name: "pools-empty", role: "teacher", path: "/pools?empty=1" },
  { name: "pools-error", role: "teacher", path: "/pools?fail=1", settle: 2500 },
  // The icon picker, reached the way a teacher reaches it: the New pool form
  // first, then the round button beside the name.
  { name: "pools-icon", role: "teacher", path: "/pools", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(new pool|nouvelle banque)$/i }).first().click();
      await p.waitForTimeout(300);
      await p.getByRole("button", { name: /^(change the icon|changer l'icône)$/i }).first().click();
      // The click leaves the pointer over whichever icon took that spot, and
      // its tooltip then sits in the middle of the grid.
      await p.mouse.move(0, 0);
    } },
  { name: "pool-share", role: "teacher", path: "/pools", fold: true, act: async (p) => {
      await openRowMenu(p, /^(actions)$/i);
      await p.getByRole("menuitem", { name: /^(share|partager)…$/i }).click();
    } },
  // The invite picker with a few letters typed: the colleagues it offers.
  { name: "pool-share-pick", role: "teacher", path: "/pools", fold: true, act: async (p) => {
      await openRowMenu(p, /^(actions)$/i);
      await p.getByRole("menuitem", { name: /^(share|partager)…$/i }).click();
      await p.getByRole("combobox", { name: /^(teacher|enseignant)$/i }).fill("ri");
    } },
  // ... and the field once a colleague is picked: the name in it, the address on the label line.
  { name: "pool-share-picked", role: "teacher", path: "/pools", fold: true, act: async (p) => {
      await openRowMenu(p, /^(actions)$/i);
      await p.getByRole("menuitem", { name: /^(share|partager)…$/i }).click();
      await p.getByRole("combobox", { name: /^(teacher|enseignant)$/i }).fill("ri");
      await p.getByRole("option", { name: /Ritchie/ }).click();
    } },

  // The bell, and the same bell with more than nine unread ("9+").
  { name: "notifications", role: "teacher", path: "/", fold: true, act: (p) => p.getByRole("button", { name: /^notifications/i }).first().click() },
  { name: "notifications-many", role: "teacher", path: "/?many=1", fold: true, act: (p) => p.getByRole("button", { name: /^notifications/i }).first().click() },

  // WP: live polls. The launcher is a sheet opened from the navigation; the
  // projection is a page, and the mock addresses its three polls by name.
  { name: "poll-launcher", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /^(poll|sondage)$/i }).first().click() },
  { name: "poll-projection", role: "teacher", path: "/evaluations/poll/poll", fold: true },
  { name: "poll-projection-revealed", role: "teacher", path: "/evaluations/poll/poll?revealed=1", fold: true },
  { name: "poll-ended", role: "teacher", path: "/evaluations/poll-ended/poll", fold: true },
  // The worst case of the wall: a three-line question and eight choices that
  // wrap. It must come back with no scrollbar and nothing cut off — the band
  // shrinks itself (`fitScale`), so the fold IS the whole screen.
  { name: "poll-projection-long", role: "teacher", path: "/evaluations/poll-long/poll", fold: true },
  { name: "poll-projection-long-revealed", role: "teacher", path: "/evaluations/poll-long/poll?revealed=1", fold: true },
  // The participant's half, as a GUEST: no session at all, which is what a
  // phone in the room has (`?as=guest` in src/mock/poll.ts).
  { name: "join-mcq", role: "teacher", path: "/p/QZ4F7K?as=guest" },
  { name: "join-revealed", role: "teacher", path: "/p/QZ4F7K?as=guest&revealed=1" },
  { name: "join-ended", role: "teacher", path: "/p/EN6D3D?as=guest" },
  { name: "pool", role: "teacher", path: "/pools/p1" },
  { name: "pool-empty", role: "teacher", path: "/pools/p1?empty=1", settle: 800 },
  { name: "pool-error", role: "teacher", path: "/pools/p1?fail=1", settle: 2500 },
  { name: "pool-loading", role: "teacher", path: "/pools/p1?slow=1", settle: 300 },
  { name: "pool-many", role: "teacher", path: "/pools/p1?many=1" },
  { name: "pool-filters", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.getByRole("button", { name: /^filtres|^filters/i }).first().click() },
  // The row no longer opens an inspection panel: it opens the question. What
  // is worth a scene here is the row's own three actions, and the confirm
  // dialog the last one goes through.
  { name: "pool-row-delete", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.getByRole("button", { name: /^(Delete|Supprimer) ptr-arith-01$/ }).first().click() },
  { name: "pool-bulk", role: "teacher", path: "/pools/p1", act: async (p) => {
      await p.getByLabel(/ptr-arith-01/).first().check();
      await p.getByLabel(/ptr-null-check/).first().check();
    } },
  // The bulk bar's move dialog, on its "New category…" branch: the option is
  // last in the select and reveals the name field.
  { name: "pool-bulk-move", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      await p.getByLabel(/ptr-arith-01/).first().check();
      await p.getByRole("button", { name: /^(move to a category|déplacer)$/i }).first().click();
      // Scoped to the dialog: the toolbar's "Group by" has a Category pill too.
      const sheet = p.getByRole("dialog");
      await sheet.getByLabel(/^(Category|Catégorie)$/).selectOption("__new__");
      await sheet.getByLabel(/^(Category name|Nom de la catégorie)$/).fill("Tableaux");
    } },
  // ADR-017: the sidebar showing EVERY pool (the third state of the
  // "Question pools" row), which is what a question is dragged onto.
  { name: "pool-nav-all", role: "teacher", path: "/pools/p1", ls: { "quiz-pools-nav": "all" } },
  // The bulk bar's "Move to another pool", with a target picked so its
  // category select is on screen too.
  { name: "pool-move-pool", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      await p.getByLabel(/ptr-null-check/).first().check();
      await p.getByRole("button", { name: /^(move to another pool|déplacer vers une autre banque)$/i }).first().click();
      await p.getByLabel(/^(Target pool|Banque de destination)$/).selectOption({ index: 1 });
    } },
  // The refusal that becomes a question: a classroom already plays this
  // question and the target pool is not one of its course's.
  { name: "pool-move-used", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      await p.getByLabel(/ptr-arith-01/).first().check();
      await p.getByRole("button", { name: /^(move to another pool|déplacer vers une autre banque)$/i }).first().click();
      await p.getByLabel(/^(Target pool|Banque de destination)$/).selectOption({ index: 1 });
      await p.getByRole("button", { name: /^(move|déplacer)$/i }).first().click();
    } },
  { name: "pool-new-question", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.getByRole("button", { name: /nouvelle question|new question/i }).first().click() },
  // The categories live in the frame's sidebar now, so on a phone they are
  // inside the drawer: the scene opens it first when there is one.
  { name: "pool-category-menu", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      const drawer = p.getByRole("button", { name: /open menu|ouvrir le menu/i });
      if (await drawer.isVisible()) {
        await drawer.click();
        await p.waitForTimeout(400);
      }
      await openRowMenu(p, /^actions$/i);
    } },

  { name: "editor-mcq", role: "teacher", path: "/questions/q2" },
  { name: "editor-code", role: "teacher", path: "/questions/q1", settle: 5000 },
  { name: "editor-short", role: "teacher", path: "/questions/q3" },
  { name: "editor-cloze", role: "teacher", path: "/questions/q4" },
  // "Student preview": a page of its own, opened by the editor in a new tab.
  { name: "question-preview", role: "teacher", path: "/questions/q2/preview", settle: 3000 },
  { name: "question-preview-code", role: "teacher", path: "/questions/q1/preview", settle: 8000 },
  { name: "editor-publish", role: "teacher", path: "/questions/q2", fold: true, act: (p) => p.keyboard.press("Control+Shift+P") },
  { name: "editor-versions", role: "teacher", path: "/questions/q1?tab=versions", settle: 3000 },
  { name: "editor-loading", role: "teacher", path: "/questions/q2?slow=1", settle: 300 },
  { name: "editor-error", role: "teacher", path: "/questions/q2?fail=1", settle: 2500 },

  { name: "try-mcq", role: "teacher", path: "/questions/q2?tab=try" },
  { name: "try-mcq-graded", role: "teacher", path: "/questions/q2?tab=try", act: async (p) => {
      await p.getByRole("radio").first().check();
      await p.getByRole("button", { name: /corriger|grade/i }).first().click();
      // The verdict is a round trip away; 700 ms of grace is the act's own.
      await p.waitForTimeout(1200);
    } },
  { name: "try-code-runner", role: "teacher", path: "/questions/q1?tab=try", settle: 5000, act: async (p) => {
      await p.getByRole("button", { name: /corriger|grade/i }).first().click();
      await p.waitForTimeout(1200);
    } },
  { name: "palette-pool", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.keyboard.press("Control+k") },

  // The primitive gallery (development route, teacher only)
  { name: "dev-ui", role: "teacher", path: "/dev/ui" },
  // The segmented control hides real radios (sr-only), so the label is what a
  // pointer can reach — the same thing a mouse hits on the screen.
  { name: "dev-ui-preview", role: "teacher", path: "/dev/ui", act: (p) => p.locator("label").filter({ hasText: /^(Preview|Aper\u00e7u)$/ }).first().click() },

  // Grading panel, results and the student feedback (WP10). An evaluation is
  // addressable by its STATE in the mock: `closed` is the one still being
  // graded and `released` the published one, and both are the very
  // evaluations the classroom list shows.
  { name: "grading", role: "teacher", path: "/evaluations/closed/grading" },
  { name: "grading-short", role: "teacher", path: "/evaluations/closed/grading", act: (p) => nextQuestion(p, 1) },
  { name: "grading-cloze", role: "teacher", path: "/evaluations/closed/grading", act: (p) => nextQuestion(p, 2) },
  { name: "grading-code", role: "teacher", path: "/evaluations/closed/grading", act: (p) => nextQuestion(p, 3) },
  { name: "grading-by-student", role: "teacher", path: "/evaluations/closed/grading", act: (p) => p.locator("label").filter({ hasText: /^(By student|Par étudiant)$/ }).first().click() },
  { name: "grading-override", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: (p) => p.getByRole("button", { name: /^(Adjust|Modifier)$/ }).first().click() },
  { name: "grading-batch-confirm", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => {
      await nextQuestion(p, 3);
      await p.getByRole("button", { name: /^(Validate|Valider) \d+/ }).first().click();
    } },
  { name: "grading-regrade", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: (p) => p.getByRole("button", { name: /re-grade this question|re-corriger cette question/i }).first().click() },
  { name: "grading-empty", role: "teacher", path: "/evaluations/closed/grading?empty=1", settle: 800 },
  { name: "grading-error", role: "teacher", path: "/evaluations/closed/grading?fail=1", settle: 2500 },
  { name: "grading-loading", role: "teacher", path: "/evaluations/closed/grading?slow=1", settle: 300 },

  { name: "results", role: "teacher", path: "/evaluations/closed/results" },
  { name: "results-released", role: "teacher", path: "/evaluations/released/results" },
  { name: "results-questions", role: "teacher", path: "/evaluations/closed/results?tab=questions", settle: 2500 },
  { name: "results-release-confirm", role: "teacher", path: "/evaluations/closed/results", fold: true, act: (p) => p.getByRole("button", { name: /publish results|publier les résultats/i }).first().click() },
  { name: "results-empty", role: "teacher", path: "/evaluations/closed/results?empty=1", settle: 800 },
  { name: "results-error", role: "teacher", path: "/evaluations/closed/results?fail=1", settle: 2500 },

  { name: "feedback", role: "student", path: `/attempts/${ATTEMPT_PAST}/feedback` },
  { name: "feedback-pending", role: "student", path: `/attempts/${ATTEMPT_OPEN}/feedback` },
  { name: "feedback-error", role: "student", path: `/attempts/${ATTEMPT_PAST}/feedback?fail=1`, settle: 2500 },

  // The signed-out door. The mock has no "no persona" mode: signing out from
  // the account menu is how a browser gets there, and it is the same path a
  // teacher takes.
  { name: "landing", role: "teacher", path: "/", act: async (p) => {
      await p.getByRole("button", { name: /^(user menu|menu du compte)$/i }).first().click();
      await p.getByRole("menuitem", { name: /sign out|se déconnecter/i }).click();
    } },

  // Settings and administration
  { name: "settings", role: "teacher", path: "/settings" },
  { name: "settings-avatar", role: "teacher", path: "/settings", act: (p) => p.getByRole("button", { name: /change picture/i }).first().click() },
  { name: "admin", role: "admin", path: "/admin" },
  { name: "admin-empty", role: "admin", path: "/admin?empty=1" },
  { name: "admin-error", role: "admin", path: "/admin?fail=1", settle: 2500 },
  { name: "admin-loading", role: "admin", path: "/admin?slow=1", settle: 300 },
];

/**
 * WP9: moves the player to question `n` through its progress segment, which
 * is how a student does it with a mouse. The bars carry their number and
 * their state in the accessible name, so the selector is the same one a
 * screen reader follows.
 */
async function openQuestion(page, n) {
  await page.getByRole("button", { name: new RegExp(`^Question ${n},`) }).click();
  await page.waitForTimeout(400);
}

/**
 * Opens the overflow menu of a table row (and optionally picks an item). The
 * row is brought into view first so the trigger is clickable; the menu itself
 * ignores the scroll its own opening causes, so no extra settling is needed.
 */
async function openRowMenu(page, triggerName, item) {
  const trigger = page.getByRole("button", { name: triggerName }).first();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  if (item) await page.getByRole("menuitem", { name: item }).click();
}

/**
 * Walks the grading panel forward `n` questions. The traversal is the
 * screen's own "next question" control, so the scene exercises the same path
 * a teacher does.
 */
async function nextQuestion(page, n) {
  for (let i = 0; i < n; i += 1) {
    await page.getByRole("button", { name: /next question|question suivante/i }).first().click();
    await page.waitForTimeout(400);
  }
}

if (flag("list")) {
  for (const s of scenes) console.log(s.name);
  process.exit(0);
}

// --- Runner ------------------------------------------------------------

const picked = scenes.filter((s) => only.length === 0 || only.some((f) => s.name.includes(f)));
if (picked.length === 0) {
  console.error(`No scene matches ${only.join(", ")}. Try --list.`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failures = 0;

for (const width of widths.length ? widths : [1440]) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 700 ? 844 : 900 },
    deviceScaleFactor: 1,
    colorScheme: dark ? "dark" : "light",
  });
  for (const scene of picked) {
    const page = await ctx.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(m.text());
    });
    await page.addInitScript(
      ({ role, ls, ss, dark }) => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem("quiz-mock-role", role);
        if (dark) localStorage.setItem("quiz-theme", "dark");
        for (const [k, v] of Object.entries(ls ?? {})) localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(ss ?? {})) sessionStorage.setItem(k, v);
      },
      { role: scene.role, ls: scene.ls, ss: scene.ss, dark },
    );
    try {
      await page.goto(BASE + scene.path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(scene.settle ?? 1500);
      if (scene.act) {
        await scene.act(page);
        await page.waitForTimeout(700);
      }
    } catch (e) {
      problems.push(`scene failed: ${String(e).split("\n")[0]}`);
    }
    const suffix = `${dark ? "-dark" : ""}${width === 1440 ? "" : `-${width}`}`;
    const file = path.join(OUT, `${scene.name}${suffix}.png`);
    await page.screenshot({ path: file, fullPage: fullPage && !scene.fold });
    if (problems.length) failures += 1;
    console.log(
      `${path.relative(process.cwd(), file)}${problems.length ? `  PROBLEMS: ${problems.join(" | ").slice(0, 400)}` : ""}`,
    );
    await page.close();
  }
  await ctx.close();
}

await browser.close();
if (failures) console.error(`${failures} scene(s) reported console or page errors.`);
