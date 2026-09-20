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

const scenes = [
  // Teacher home (the courses)
  { name: "teacher-home", role: "teacher", path: "/" },
  { name: "teacher-home-empty", role: "teacher", path: "/?empty=1" },
  { name: "teacher-home-error", role: "teacher", path: "/?fail=1", settle: 2500 },
  { name: "teacher-home-loading", role: "teacher", path: "/?slow=1", settle: 300 },
  { name: "teacher-home-many", role: "teacher", path: "/?many=1" },
  { name: "course-new", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /new course/i }).first().click() },
  { name: "classroom-new", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /new classroom/i }).first().click() },

  // Classroom (the roster)
  { name: "classroom", role: "teacher", path: "/classrooms/r1" },
  { name: "classroom-empty", role: "teacher", path: "/classrooms/r1?empty=1", settle: 800 },
  { name: "classroom-error", role: "teacher", path: "/classrooms/r1?fail=1", settle: 2500 },
  { name: "classroom-loading", role: "teacher", path: "/classrooms/r1?slow=1", settle: 300 },
  { name: "classroom-roster-many", role: "teacher", path: "/classrooms/r1?many=1" },
  { name: "classroom-import", role: "teacher", path: "/classrooms/r1", act: (p) => p.getByRole("button", { name: /add students/i }).first().click() },
  { name: "classroom-menu", role: "teacher", path: "/classrooms/r1", fold: true, act: (p) => p.getByRole("button", { name: /^actions$/i }).first().click() },
  { name: "classroom-row-menu", role: "teacher", path: "/classrooms/r1", fold: true, act: (p) => openRowMenu(p, /^Actions for /) },

  // WP8: evaluation + dashboard. The mock addresses an evaluation by its
  // state as well as by its id, so these URLs are stable across reloads.
  { name: "eval-list", role: "teacher", path: "/classrooms/r1" },
  { name: "eval-config-questions", role: "teacher", path: "/evaluations/draft?step=questions" },
  { name: "eval-config-picker", role: "teacher", path: "/evaluations/draft?step=questions", act: (p) => p.getByRole("button", { name: /add questions/i }).first().click() },
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

  // Command palette (Ctrl+K from anywhere; the mock persona decides the groups)
  { name: "palette", role: "teacher", path: "/", fold: true, act: (p) => p.keyboard.press("Control+k") },
  { name: "palette-query", role: "teacher", path: "/", fold: true, act: async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("set"); } },
  { name: "palette-no-result", role: "teacher", path: "/", fold: true, act: async (p) => { await p.keyboard.press("Control+k"); await p.keyboard.type("qqqq"); } },
  { name: "palette-many", role: "teacher", path: "/?many=1", fold: true, act: (p) => p.keyboard.press("Control+k") },
  { name: "palette-student", role: "student", path: "/", fold: true, act: (p) => p.keyboard.press("Control+k") },

  // The primitive gallery (development route, teacher only)
  { name: "dev-ui", role: "teacher", path: "/dev/ui" },
  // The segmented control hides real radios (sr-only), so the label is what a
  // pointer can reach — the same thing a mouse hits on the screen.
  { name: "dev-ui-preview", role: "teacher", path: "/dev/ui", act: (p) => p.locator("label").filter({ hasText: /^(Preview|Aper\u00e7u)$/ }).first().click() },

  // Settings and administration
  { name: "settings", role: "teacher", path: "/settings" },
  { name: "settings-avatar", role: "teacher", path: "/settings", act: (p) => p.getByRole("button", { name: /change picture/i }).first().click() },
  { name: "admin", role: "admin", path: "/admin" },
  { name: "admin-empty", role: "admin", path: "/admin?empty=1" },
  { name: "admin-error", role: "admin", path: "/admin?fail=1", settle: 2500 },
  { name: "admin-loading", role: "admin", path: "/admin?slow=1", settle: 300 },
];

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
