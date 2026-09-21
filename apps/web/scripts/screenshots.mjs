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
  { name: "eval-preview", role: "teacher", path: "/evaluations/draft?step=questions", act: (p) => p.getByRole("button", { name: /preview as student/i }).first().click() },
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
  // state the fake backend serves (see the WP9 block of src/mock/index.ts).
  { name: "student-home-eval", role: "student", path: "/" },
  { name: "student-lobby", role: "student", path: `${TAKE}?scene=lobby` },
  { name: "player-mcq", role: "student", path: `${TAKE}?scene=running` },
  { name: "player-cloze", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 2) },
  { name: "player-short", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 3) },
  { name: "player-code", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 4) },
  { name: "player-run", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 4); await p.getByRole("button", { name: /^run$/i }).click(); } },
  { name: "player-submit", role: "student", path: `${TAKE}?scene=running`, fold: true, act: (p) => p.getByRole("button", { name: /hand in/i }).first().click() },
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
  { name: "pools-empty", role: "teacher", path: "/pools?empty=1" },
  { name: "pools-error", role: "teacher", path: "/pools?fail=1", settle: 2500 },
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
      await p.getByLabel(/^(Category|Catégorie)$/).selectOption("__new__");
      await p.getByLabel(/^(Category name|Nom de la catégorie)$/).fill("Tableaux");
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
  { name: "editor-preview", role: "teacher", path: "/questions/q2", act: (p) => p.keyboard.press("Control+Shift+M") },
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
      ({ role, ls, dark }) => {
        localStorage.clear();
        localStorage.setItem("quiz-mock-role", role);
        if (dark) localStorage.setItem("quiz-theme", "dark");
        for (const [k, v] of Object.entries(ls ?? {})) localStorage.setItem(k, v);
      },
      { role: scene.role, ls: scene.ls, dark },
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
