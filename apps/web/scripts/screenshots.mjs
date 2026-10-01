// Screenshots of the mocked web app, for the visual check required by
// `.claude/skills/quiz-ui/SKILL.md`. Development tool only: it is never
// imported by the app, never bundled and never runs in CI.
//
//   pnpm --filter @quiz/web dev:mock          # in one terminal
//   pnpm --filter @quiz/web screenshots       # in another
//
// Flags: --dark, --width=390|768|1440 (repeatable), --height=<px>, --only=<substring>,
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
/** --height=768: a laptop screen instead of the default 900 (844 on a phone). */
const heightOpt = opt("height").map(Number).find(Boolean);

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

/**
 * The live dashboard with names, answers and results on. They start OFF on a
 * first visit (#227), which is right in front of a class and says nothing in
 * a user guide: the scenes about what the grid shows turn them on, as a
 * teacher who flipped the switches would have.
 */
const LIVE_ALL_ON = { "quiz-live-toggles-v2": JSON.stringify({ names: true, answers: true, results: true }) };

/** The mock's evaluation, taken by the student persona (WP9). */
const TAKE = "/take/11111111-1111-4111-8111-111111111111";
/**
 * The student persona's two attempts (WP9 + WP10). The first is pinned on the
 * evaluation the mock leaves CLOSED and unreleased — its feedback page is the
 * "not published yet" state — and the second on the RELEASED one.
 */
const ATTEMPT_OPEN = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_PAST = "22222222-2222-4222-8222-222222222223";
/** The mock's draft made from a template that has moved since (F-EVAL-26). */
const TEMPLATE_INSTANCE = "eeeeeeee-0000-4000-8000-000000000026";
/** The journal page the editor scenes open (M4-06). */
const JOURNAL_EDIT = "/classrooms/r1/journal/10-semaine-1/10-pointeurs.md";

/** A pending pairing of the mock's station n° 7, code BCDF-GHJK (ADR-051 §7). */
const KIOSK_PAIRING = {
  "quiz-mock-kiosk-pairing": JSON.stringify({
    deviceCode: "mock-device",
    userCode: "BCDF-GHJK",
    expiresAt: Date.now() + 3_600_000,
    state: "pending",
    evaluationId: null,
  }),
};

const scenes = [
  // The Activities section (#190): the three views, the states.
  { name: "activities", role: "teacher", path: "/activities" },
  { name: "activities-cards", role: "teacher", path: "/activities", ls: { "quiz-activities-view": "cards" } },
  { name: "activities-schedule", role: "teacher", path: "/activities", ls: { "quiz-activities-view": "schedule" } },
  { name: "activities-empty", role: "teacher", path: "/activities?empty=1" },
  { name: "activities-error", role: "teacher", path: "/activities?fail=1", settle: 2500 },
  // Teacher home (the courses)
  { name: "teacher-home", role: "teacher", path: "/" },
  { name: "teacher-home-empty", role: "teacher", path: "/?empty=1" },
  { name: "teacher-home-error", role: "teacher", path: "/?fail=1", settle: 2500 },
  { name: "teacher-home-loading", role: "teacher", path: "/?slow=1", settle: 300 },
  { name: "teacher-home-many", role: "teacher", path: "/?many=1" },
  // The same list as a table; the choice lives in localStorage.
  { name: "teacher-home-list", role: "teacher", path: "/", ls: { "quiz-courses-view": "list" } },
  { name: "teacher-home-list-many", role: "teacher", path: "/?many=1", ls: { "quiz-courses-view": "list" } },
  // The staff lives on the title line as a row of discs; the card behind one
  // of them is where a colleague's address and their seat are.
  { name: "teacher-home-staff", role: "teacher", path: "/", fold: true, act: (p) => p.getByRole("button", { name: "Prof Démo", exact: true }).first().click() },
  { name: "course-link-pool", role: "teacher", path: "/", fold: true, act: (p) => p.getByRole("button", { name: /link a pool|lier une banque/i }).first().click() },
  { name: "course-new", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /new course/i }).first().click() },
  { name: "classroom-new", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /new classroom/i }).first().click() },
  // F-ORG-12: the page of one course — classrooms, pools, templates. PRG1
  // holds the mock's two templates, EMB none (the empty state), and an id
  // nobody reaches is the not-found state.
  { name: "course-page", role: "teacher", path: "/courses/c1" },
  { name: "course-page-no-templates", role: "teacher", path: "/courses/c2" },
  { name: "course-page-actions", role: "teacher", path: "/courses/c1", fold: true, act: async (p) => { await p.getByRole("button", { name: /^actions$/i }).first().click(); } },
  { name: "course-page-not-found", role: "teacher", path: "/courses/nope" },
  { name: "course-page-error", role: "teacher", path: "/courses/c1?fail=1", settle: 2500 },
  { name: "course-page-loading", role: "teacher", path: "/courses/c1?slow=1", settle: 300 },
  // ADR-031: the course's evaluation templates, on its page, and the dialog
  // that makes a classroom's evaluation from one.
  { name: "course-template-use", role: "teacher", path: "/courses/c1", fold: true, act: (p) => p.getByRole("button", { name: /use in a classroom|utiliser dans une classe/i }).first().click() },
  // F-EVAL-24 / F-EVAL-25: "New template" on the course page, and a
  // template's editor — the mock's exam template carries a stale item, and a
  // circuit question from a pool the course does not link — its settings tab
  // with the advanced options open, a new (empty) one, and an unknown id.
  { name: "template-new", role: "teacher", path: "/courses/c1", fold: true, act: async (p) => { await p.getByRole("button", { name: /^(new template|nouveau modèle)$/i }).first().click(); } },
  { name: "template-editor", role: "teacher", path: "/courses/c1", act: openTemplate },
  { name: "template-editor-settings", role: "teacher", path: "/courses/c1", act: async (p) => {
      await openTemplate(p);
      await p.getByRole("tab", { name: /^(settings|réglages)$/i }).click();
      await p.getByRole("button", { name: /^(advanced options|options avancées)$/i }).click();
    } },
  { name: "template-editor-picker", role: "teacher", path: "/courses/c1", fold: true, act: async (p) => {
      await openTemplate(p);
      await p.getByRole("button", { name: /^(add questions|ajouter des questions)$/i }).first().click();
      // The question looked at (issue #207), docked beside the list at 1440.
      await p.getByRole("dialog").getByRole("button", { name: /^(Preview|Aperçu de) / }).nth(1).click();
      await p.waitForTimeout(800);
    } },
  { name: "template-editor-empty", role: "teacher", path: "/courses/c1", act: async (p) => {
      await p.getByRole("button", { name: /^(new template|nouveau modèle)$/i }).first().click();
      await p.getByRole("dialog").getByRole("textbox").first().fill("Examen de rattrapage");
      await p.getByRole("button", { name: /^(create template|créer le modèle)$/i }).click();
      await p.waitForURL(/\/templates\//);
      await p.waitForTimeout(600);
    } },
  { name: "template-editor-not-found", role: "teacher", path: "/templates/nope" },
  { name: "eval-new-from-template", role: "teacher", path: "/classrooms/r1", fold: true, act: (p) => p.getByRole("button", { name: /new evaluation|nouvelle évaluation/i }).first().click() },
  // F-EVAL-26: an instance behind its template — the list's badge, the
  // confirmation it opens, and the launch checklist's warning.
  { name: "classroom-template-behind", role: "teacher", path: "/classrooms/r1" },
  { name: "template-pull-confirm", role: "teacher", path: "/classrooms/r1", fold: true, act: async (p) => { await p.getByRole("button", { name: /from its template|depuis son modèle/i }).first().click(); } },
  { name: "launch-template-behind", role: "teacher", path: `/evaluations/${TEMPLATE_INSTANCE}?step=launch` },
  { name: "launch-template-pull-confirm", role: "teacher", path: `/evaluations/${TEMPLATE_INSTANCE}?step=launch`, fold: true, act: async (p) => { await p.getByRole("button", { name: /^(update…|mettre à jour…)$/i }).first().click(); } },
  { name: "eval-save-template", role: "teacher", path: "/evaluations/draft?step=questions", fold: true, act: async (p) => { await p.getByRole("button", { name: /^actions$/i }).first().click(); await p.getByRole("menuitem", { name: /save as template|enregistrer comme modèle/i }).click(); } },
  // #155: a hidden course brought back by "Show hidden", the course menu with
  // "Hide for me", and a course's archived classrooms behind "Show archived".
  { name: "teacher-home-hidden", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /show hidden|afficher les masqués/i }).first().click() },
  { name: "course-menu", role: "teacher", path: "/", fold: true, act: (p) => p.getByRole("button", { name: /^actions$/i }).first().click() },
  { name: "course-archived", role: "teacher", path: "/", act: (p) => p.getByRole("button", { name: /show archived|afficher les archivées/i }).first().click() },

  // Classroom. Two tabs: the roster and the evaluations. Without `?tab=` the
  // page opens on the evaluations, which is where the work is once the
  // classroom has students, so every roster scene names its tab.
  { name: "classroom", role: "teacher", path: "/classrooms/r1" },
  // #153: the sidebar's Classrooms section, one label per row, on the
  // classroom whose name outgrows 240 px — and that row's tip.
  { name: "sidebar-classrooms", role: "teacher", path: "/classrooms/r4", fold: true },
  { name: "sidebar-classroom-tip", role: "teacher", path: "/classrooms/r4", fold: true, act: async (p) => {
      await p.getByRole("button", { name: "Prog-C-2026-2027-test", exact: true }).first().hover();
      await p.getByLabel(/internal name|nom interne/i).waitFor();
    await p.waitForTimeout(250); // the slide
    } },
  // #154: the course → classroom tree under "Courses", in its two states,
  // and a second course's row in "all" with its code's tip. The rows open the
  // course page (F-ORG-12), so the tip is hovered, not clicked.
  ...["active", "all"].map((state) => ({
    name: `sidebar-courses-${state}`, role: "teacher", path: "/classrooms/r4", fold: true,
    ls: { "quiz-courses-nav": state },
  })),
  { name: "sidebar-courses-all-tip", role: "teacher", path: "/classrooms/r4", fold: true, ls: { "quiz-courses-nav": "all" }, act: async (p) => {
      await p.getByRole("button", { name: "EMB", exact: true }).first().hover();
      await p.getByLabel(/internal name|nom interne/i).waitFor();
    await p.waitForTimeout(250); // the slide
    } },
  { name: "classroom-roster", role: "teacher", path: "/classrooms/r1?tab=roster" },
  { name: "classroom-empty", role: "teacher", path: "/classrooms/r1?empty=1&tab=roster", settle: 800 },
  { name: "classroom-error", role: "teacher", path: "/classrooms/r1?fail=1", settle: 2500 },
  { name: "classroom-loading", role: "teacher", path: "/classrooms/r1?slow=1", settle: 300 },
  { name: "classroom-roster-many", role: "teacher", path: "/classrooms/r1?tab=roster&many=1" },
  // ADR-041 (#317, slice 4): the classroom's Drill tab — the students'
  // activity and the mastery per tag, a student's weekly progression, the
  // drill on with nothing yet (r2) and the drill off (r3).
  { name: "classroom-drill", role: "teacher", path: "/classrooms/r1?tab=drill" },
  { name: "classroom-drill-student", role: "teacher", path: "/classrooms/r1?tab=drill", fold: true, act: async (p) => { await p.getByRole("button", { name: /^(Progression of|Progression de)/ }).first().click(); await p.getByText(/^(Reviews per week|Révisions par semaine)$/).first().waitFor(); } },
  { name: "classroom-drill-none", role: "teacher", path: "/classrooms/r2?tab=drill" },
  { name: "classroom-drill-off", role: "teacher", path: "/classrooms/r3?tab=drill" },
  { name: "classroom-import", role: "teacher", path: "/classrooms/r1?tab=roster", act: (p) => p.getByRole("button", { name: /add students/i }).first().click() },
  // #156: the period dialog — the months, the two semester presets, the label
  // — opened from the period beside the title (the header's overflow menu
  // left for the Settings tab, D24).
  { name: "classroom-period", role: "teacher", path: "/classrooms/r1", fold: true, act: (p) => p.getByRole("button", { name: /^(change period|changer la période)/i }).first().click() },
  // F-ORG-13 (D24, M2-07): the Settings tab. A classroom that is not
  // connected (r2, its course's organization suggested): "Connect to GitHub"
  // is the one accent, and the connect sheet it opens; PRG1-2026 connected,
  // every check green, then with the warnings (free plan, no LLM secret) and
  // with its organization gone from GitHub; the rename dialog.
  { name: "classroom-settings", role: "teacher", path: "/classrooms/r2/settings" },
  { name: "classroom-settings-github-connect", role: "teacher", path: "/classrooms/r2/settings?connect=1", fold: true },
  { name: "classroom-settings-github-installed", role: "teacher", path: "/classrooms/r1/settings" },
  { name: "classroom-settings-github-checks-warn", role: "teacher", path: "/classrooms/r1/settings?ghwarn=1" },
  { name: "classroom-settings-github-org-missing", role: "teacher", path: "/classrooms/r1/settings?ghmissing=1" },
  { name: "classroom-settings-rename", role: "teacher", path: "/classrooms/r1/settings", fold: true, act: (p) => p.getByRole("button", { name: /^(rename|renommer)$/i }).first().click() },
  // F-JRN-01 to F-JRN-05 (M4-05, M4-09): the Journal section. PRG1-2026
  // (r1) is connected and has no journal by default: the mode's segmented
  // control, In Quiz chosen (`journal-settings-mode`), In a GitHub
  // repository chosen, and chosen on r2, not connected (the "needs the
  // GitHub connection" line). `?journal=1` gives r1 a Quiz-mode journal,
  // `?journalgithub=1` a GitHub-mode one, `?journalerror=1` a GitHub-mode
  // one whose last synchronisation failed. Removing a Quiz-mode journal
  // with pages asks for the classroom's name (`journal-remove-quiz`).
  { name: "journal-settings-mode", role: "teacher", path: "/classrooms/r1/settings" },
  { name: "classroom-settings-journal-none", role: "teacher", path: "/classrooms/r1/settings", act: chooseGithubMode },
  { name: "journal-settings-mode-not-connected", role: "teacher", path: "/classrooms/r2/settings", act: chooseGithubMode },
  { name: "classroom-settings-journal-create", role: "teacher", path: "/classrooms/r1/settings", fold: true, act: async (p) => { await chooseGithubMode(p); await p.getByRole("button", { name: /^(create…|créer…)$/i }).click(); } },
  { name: "classroom-settings-journal-name-taken", role: "teacher", path: "/classrooms/r1/settings", fold: true, act: journalNameTaken },
  { name: "classroom-settings-journal-use", role: "teacher", path: "/classrooms/r1/settings", fold: true, act: journalUse },
  { name: "classroom-settings-journal-set", role: "teacher", path: "/classrooms/r1/settings?journal=1" },
  { name: "classroom-settings-journal-set-github", role: "teacher", path: "/classrooms/r1/settings?journal=1&journalgithub=1" },
  { name: "classroom-settings-journal-sync-error", role: "teacher", path: "/classrooms/r1/settings?journal=1&journalerror=1" },
  { name: "journal-remove-quiz", role: "teacher", path: "/classrooms/r1/settings?journal=1", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(remove…|retirer…)$/i }).click();
      await p.getByLabel(/^(type|tapez) PRG1-2026/i).fill("PRG1-20");
    } },
  { name: "classroom-settings-journal-remove", role: "teacher", path: "/classrooms/r1/settings?journal=1&journalgithub=1", fold: true, act: (p) => p.getByRole("button", { name: /^(remove…|retirer…)$/i }).click() },
  { name: "classroom-settings-delete-journal", role: "teacher", path: "/classrooms/r1/settings?journal=1", fold: true, act: async (p) => {
      await p.getByText(/pages, written and kept in Quiz|pages, écrites et conservées dans Quiz/).waitFor();
      await p.getByRole("button", { name: /^(delete classroom|supprimer la classe)/i }).click();
    } },
  // F-JRN-07 (M4-05, M4-09): the teacher's Journal tab, its staff bar: Quiz
  // mode (Edit, the Pages menu opened), GitHub mode (Edit on GitHub, Refresh
  // just clicked).
  { name: "classroom-journal-teacher", role: "teacher", path: "/classrooms/r1/journal?journal=1" },
  { name: "journal-quiz-pages-menu", role: "teacher", path: `${JOURNAL_EDIT}?journal=1`, fold: true, act: (p) => p.getByRole("button", { name: /^(pages)$/i }).click() },
  { name: "journal-github-readonly", role: "teacher", path: `${JOURNAL_EDIT}?journal=1&journalgithub=1` },
  { name: "classroom-journal-teacher-refreshing", role: "teacher", path: "/classrooms/r1/journal?journal=1&journalgithub=1", fold: true, act: (p) => p.getByRole("button", { name: /^(refresh|actualiser)$/i }).click() },
  { name: "classroom-row-menu", role: "teacher", path: "/classrooms/r1?tab=roster", fold: true, act: (p) => openRowMenu(p, /^Actions for /) },
  // ADR-034: an admin's row menu offers the impersonation link — with Super
  // Powers on (ADR-054); the private window it opens shows the student's
  // portal under the mode banner.
  { name: "classroom-row-menu-admin", role: "admin", path: "/classrooms/r1?tab=roster&superpowers=1", fold: true, act: (p) => openRowMenu(p, /^Actions for /) },
  { name: "impersonation-link", role: "admin", path: "/classrooms/r1?tab=roster&superpowers=1", fold: true, act: async (p) => {
      await openRowMenu(p, /^Actions for /);
      await p.getByRole("menuitem", { name: /as this student|en tant que cet étudiant/ }).first().click();
      await p.getByRole("dialog").waitFor();
    } },
  { name: "impersonation-banner", role: "student", path: "/?impersonating=1", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(Got it|Compris)$/ }).first().click({ timeout: 3000 }).catch(() => {});
      await p.evaluate(() => window.scrollTo(0, 0));
    } },

  // WP8: evaluation + dashboard. The mock addresses an evaluation by its
  // state as well as by its id, so these URLs are stable across reloads.
  { name: "eval-list", role: "teacher", path: "/classrooms/r1" },
  { name: "eval-config-questions", role: "teacher", path: "/evaluations/draft?step=questions" },
  // Issue #79: once opened, the list is frozen — in the lobby nobody has
  // entered yet, while running somebody has an attempt; two messages.
  { name: "eval-config-questions-opened", role: "teacher", path: "/evaluations/lobby?step=questions" },
  { name: "eval-config-questions-locked", role: "teacher", path: "/evaluations/running?step=questions" },
  // Issue #127: one item as the student sees it, at its frozen version, and
  // the editor opened from a row with its way back to the evaluation.
  { name: "eval-config-item-preview", role: "teacher", path: "/evaluations/draft?step=questions", fold: true, act: (p) => p.getByRole("button", { name: /^preview /i }).first().click() },
  { name: "eval-config-item-preview-answers", role: "teacher", path: "/evaluations/draft?step=questions", fold: true, act: async (p) => { await p.getByRole("button", { name: /^preview /i }).nth(1).click(); await p.getByRole("button", { name: /show answers|afficher les réponses/i }).click(); await p.waitForTimeout(600); } },
  { name: "eval-config-item-edit", role: "teacher", path: "/evaluations/draft?step=questions", fold: true, act: (p) => p.getByRole("button", { name: /^edit /i }).first().click() },
  { name: "eval-config-picker", role: "teacher", path: "/evaluations/draft?step=questions", act: (p) => p.getByRole("button", { name: /add questions/i }).first().click() },
  // The picker with a question looked at (issue #207): docked beside the list
  // from 1280 px, in place of the list below.
  { name: "eval-config-picker-preview", role: "teacher", path: "/evaluations/draft?step=questions", fold: true, act: async (p) => { await p.getByRole("button", { name: /add questions/i }).first().click(); await p.getByRole("dialog").getByRole("button", { name: /^(Preview|Aperçu de) / }).nth(1).click(); await p.waitForTimeout(800); } },
  // "Add favourites" (F-POOL-10): what it added and skipped, and the offer to unstar.
  { name: "eval-config-picker-favourites", role: "teacher", path: "/evaluations/draft?step=questions", fold: true, act: async (p) => { await p.getByRole("button", { name: /add questions/i }).first().click(); await p.getByRole("button", { name: /^(Add favourites|Ajouter les favoris)$/ }).click(); await p.waitForTimeout(600); } },
  { name: "eval-config-milestone-gap", role: "teacher", path: "/evaluations/draft?step=questions", act: (p) => p.getByRole("button", { name: /^reorder /i }).first().hover() },
  { name: "eval-config-timing", role: "teacher", path: "/evaluations/draft?step=timing" },
  { name: "eval-config-advanced", role: "teacher", path: "/evaluations/draft?step=timing", act: (p) => p.getByRole("button", { name: /^advanced options$/i }).first().click() },
  // Issue #86: running, the configuration is locked in the editor but for the title and the feedback.
  { name: "eval-config-timing-running", role: "teacher", path: "/evaluations/running?step=timing" },
  // F-EVAL-15: the retake rule of an exercise, editable (a draft) and frozen
  // (the paused exercise, which students are sitting).
  { name: "eval-config-retakes", role: "teacher", path: "/evaluations/eeeeeeee-0000-4000-8000-000000000015?step=timing" },
  { name: "eval-config-retakes-locked", role: "teacher", path: "/evaluations/paused?step=timing" },
  { name: "eval-config-advanced-running", role: "teacher", path: "/evaluations/running?step=timing", act: (p) => p.getByRole("button", { name: /^advanced options$/i }).first().click() },
  // #152: the pre-flight checklist — ready with warnings (the draft exam),
  // scheduled, no waiting room (the retake exercise opens straight into
  // `running`), blocked (an empty classroom has no question), and the
  // one-field Schedule dialog. `fold`: on a phone the dock is sticky, and a
  // full-page capture would pin it to the very bottom of the page.
  { name: "eval-config-launch", role: "teacher", path: "/evaluations/draft?step=launch" },
  { name: "eval-config-launch-fold", role: "teacher", path: "/evaluations/draft?step=launch", fold: true },
  { name: "eval-config-launch-scheduled", role: "teacher", path: "/evaluations/scheduled?step=launch" },
  { name: "eval-config-launch-skip", role: "teacher", path: "/evaluations/eeeeeeee-0000-4000-8000-000000000015?step=launch" },
  {
    name: "eval-config-launch-blocked", role: "teacher", path: "/evaluations/eeeeeeee-0000-4000-8000-000000000015?step=questions", fold: true,
    act: async (p) => {
      // A draft emptied of its questions: the one blocker a click can make.
      // By its id, not the `draft` alias: the item routes invalidate the
      // query of the real id, which an alias-keyed page never refetches.
      await skipCoach(p);
      const remove = p.getByRole("button", { name: /^remove .* from the evaluation$|^retirer .* de l'évaluation$/i });
      await remove.first().waitFor({ timeout: 5000 });
      for (let i = 0; i < 20 && (await remove.count()) > 0; i++) {
        await remove.first().click({ timeout: 2000 }).catch(() => {});
        await p.getByLabel(/internal name|nom interne/i).waitFor();
    await p.waitForTimeout(250); // the slide
      }
      await p.getByRole("tab", { name: /^(launch|lancement)$/i }).click();
      await p.waitForTimeout(300);
    },
  },
  { name: "eval-config-launch-schedule", role: "teacher", path: "/evaluations/draft?step=launch", fold: true, act: async (p) => {
      await skipCoach(p);
      await p.getByRole("button", { name: /^schedule…$|^planifier…$/i }).first().click();
    } },
  // The waiting-room preview: a side column from `lg` up (in the scenes
  // above), a row opening a sheet on a phone.
  { name: "eval-config-launch-preview-sheet", role: "teacher", path: "/evaluations/draft?step=launch", fold: true, act: async (p) => {
      await skipCoach(p);
      await p.getByRole("button", { name: /^what students will see|^ce que verront les étudiants/i }).first().click();
    } },
  { name: "eval-config-loading", role: "teacher", path: "/evaluations/draft?slow=1", settle: 300 },
  { name: "eval-config-error", role: "teacher", path: "/evaluations/draft?fail=1", settle: 2500 },
  // Issue #75: the stateless preview of the whole evaluation — the player
  // under its banner, then the full correction after "Hand in".
  { name: "eval-preview", role: "teacher", path: "/evaluations/draft/preview" },
  {
    name: "eval-preview-correction",
    role: "teacher",
    path: "/evaluations/draft/preview",
    act: async (p) => {
      await p.getByRole("radio").first().click({ timeout: 2000 }).catch(() => {});
      await p.getByRole("button", { name: /^(hand in|rendre)$/i }).first().click();
      await p.getByRole("dialog").getByRole("button", { name: /^(hand in|rendre)$/i }).click();
      await p.getByRole("heading", { name: /preview correction|correction de l'aperçu/i }).waitFor();
    },
  },
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
  { name: "live-running-staff", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live?mytest=1" },
  { name: "grading-staff", role: "teacher", path: "/evaluations/closed/grading?mytest=1" },
  { name: "results-staff", role: "teacher", path: "/evaluations/closed/results?mytest=1" },
  // The banner the walk comes back through: the student view, entered from an
  // evaluation, with "Back to teacher view" pointing at it.
  { name: "student-view-banner", role: "teacher", path: "/", ss: { "quiz-view-as": "student", "quiz-view-as-return": "/evaluations/closed" } },
  // The same banner above the full-screen attempt, which has no frame (#200):
  // it sticks over the player's own top bar, and the fold shows both.
  { name: "student-view-attempt", role: "teacher", path: `${TAKE}?scene=running`, fold: true, ss: { "quiz-view-as": "student", "quiz-view-as-return": "/evaluations/running/live" } },
  // The frame's teacher/student switch (ADR-018 addendum), both ways round.
  { name: "view-switch-teacher", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live", fold: true, settle: 3000 },
  { name: "view-switch-student", role: "teacher", path: "/", fold: true, settle: 3000, ss: { "quiz-view-as": "student", "quiz-view-as-return": "/evaluations/running/live" } },
  { name: "live-running", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live" },
  { name: "live-running-many", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live?many=1" },
  // ADR-051 §8: stations (one suspended, one not attested) and a SEB row, and the supervisor's fallback.
  { name: "live-kiosk", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live?kiosk=1&seb=1" },
  { name: "live-kiosk-assign", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live?kiosk=1&seb=1", fold: true, act: (p) => p.getByRole("button", { name: "Assign a station" }).first().dispatchEvent("click") },
  { name: "live-lobby", role: "teacher", path: "/evaluations/lobby/live" },
  { name: "live-closed", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/closed/live" },
  { name: "live-inspect", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live", act: (p) => p.getByRole("button", { name: /· Question 1$/ }).first().click() },
  // #94: the complete answer of one cell, on hover (fetched on demand).
  { name: "live-tip-code", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live", fold: true, act: (p) => p.getByRole("button", { name: /^Rochat, Louis · Question 1( · flagged.*)?$/ }).hover() },
  { name: "live-tip-cloze", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live", fold: true, act: (p) => p.getByRole("button", { name: /^Favre, Ethan · Question 5$/ }).hover() },
  { name: "live-tip-mcq", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live", fold: true, act: (p) => p.getByRole("button", { name: /^Gauthier, Samuel · Question 6$/ }).hover() },
  { name: "live-extend-menu", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live", fold: true, act: (p) => p.getByRole("button", { name: /^extend$/i }).first().click() },
  { name: "live-fullscreen", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/running/live", fold: true, act: (p) => p.getByRole("button", { name: /^full screen$/i }).first().click() },
  { name: "live-empty", role: "teacher", path: "/evaluations/running/live?empty=1", settle: 900 },
  { name: "live-loading", role: "teacher", path: "/evaluations/running/live?slow=1", settle: 300 },
  { name: "live-error", role: "teacher", path: "/evaluations/running/live?fail=1", settle: 2500 },
  // F-EVAL-15: an exercise with retakes — attempt badges, no Reopen.
  { name: "live-retakes", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/paused/live" },
  // ADR-050: an exercise's correction, published without closing it — the
  // overflow item, its confirmation, the header once done, and the projection.
  { name: "live-correction-menu", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/paused/live", fold: true, act: (p) => p.getByRole("button", { name: /^(actions)$/i }).first().click() },
  { name: "live-correction-confirm", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/paused/live", fold: true, act: correctionAsk },
  { name: "live-correction-published", role: "teacher", ls: LIVE_ALL_ON, path: "/evaluations/paused/live", fold: true, act: correctionPublish },
  { name: "correction-open-exercise", role: "teacher", path: "/evaluations/paused/live", fold: true, act: correctionPresent },

  // The drill (ADR-041, #317): the student's tab, and the teacher's switches.
  { name: "drill-today", role: "student", path: "/drill" },
  { name: "drill-card", role: "student", path: "/drill", act: drillStart },
  { name: "drill-feedback", role: "student", path: "/drill", act: drillAnswer },
  { name: "drill-done", role: "student", path: "/drill", act: drillWalk },
  { name: "drill-empty", role: "student", path: "/drill?reviewed=1" },
  { name: "drill-off", role: "student", path: "/drill?empty=1" },
  { name: "drill-error", role: "student", path: "/drill?fail=1", settle: 2500 },
  { name: "drill-optout", role: "student", path: "/drill", fold: true, act: (p) => p.getByRole("switch", { name: /PRG1-2026/ }).click() },
  { name: "drill-classroom", role: "teacher", path: "/classrooms/r1?tab=evaluations" },
  // Turned on where it was off: the backfill says how many cards it made.
  { name: "drill-classroom-on", role: "teacher", path: "/classrooms/r3/settings", act: (p) => p.getByRole("switch", { name: /^(drill|entraînement)$/i }).click() },
  { name: "drill-eval-draft", role: "teacher", path: "/evaluations/draft?step=timing" },
  { name: "drill-eval-released", role: "teacher", path: "/evaluations/released?step=timing" },
  { name: "drill-eval-remove", role: "teacher", path: "/evaluations/released?step=timing", fold: true, act: (p) => p.getByRole("button", { name: /remove these questions|retirer ces questions/i }).click() },

  // Student
  { name: "student-home", role: "student", path: "/" },
  { name: "student-empty", role: "student", path: "/?empty=1" },
  { name: "student-error", role: "student", path: "/?fail=1", settle: 2500 },
  { name: "student-loading", role: "student", path: "/?slow=1", settle: 300 },
  { name: "student-settings", role: "student", path: "/settings" },
  // M5-02 (F-ORG-14, F-ORG-15, D07): the student's Courses, and the page of a
  // classroom — PRG1-2026 (`r1`) holds the home's activities, PRG1-2025
  // (`r2`) none; `?journal=1` gives `r1` its Journal tab.
  { name: "student-courses", role: "student", path: "/courses" },
  { name: "student-courses-empty", role: "student", path: "/courses?empty=1" },
  { name: "student-courses-error", role: "student", path: "/courses?fail=1", settle: 2500 },
  { name: "student-classroom", role: "student", path: "/classrooms/r1" },
  { name: "student-classroom-journal", role: "student", path: "/classrooms/r1/journal?journal=1" },
  { name: "student-classroom-empty", role: "student", path: "/classrooms/r2" },
  { name: "student-classroom-error", role: "student", path: "/classrooms/r1?fail=1", settle: 2500 },
  { name: "student-classroom-notfound", role: "student", path: "/classrooms/nope" },
  { name: "student-classroom-loading", role: "student", path: "/classrooms/r1?slow=1", settle: 300 },
  // F-ORG-14, F-RES-04: the student's Grades, by classroom — every status
  // once, PRG1-2024 archived; `?many=1` a term of weekly series.
  { name: "student-grades", role: "student", path: "/grades" },
  { name: "student-grades-empty", role: "student", path: "/grades?empty=1" },
  { name: "student-grades-error", role: "student", path: "/grades?fail=1", settle: 2500 },
  { name: "student-grades-many", role: "student", path: "/grades?many=1" },
  { name: "student-grades-loading", role: "student", path: "/grades?slow=1", settle: 300 },
  // F-EVAL-15: the exercise card with its kept score and the Retake button,
  // and the score-only feedback between two attempts.
  { name: "student-home-retake", role: "student", path: "/" },
  { name: "student-feedback-retake", role: "student", path: "/attempts/22222222-2222-4222-8222-222222222224/feedback" },

  // WP9: student player. `TAKE` is the mock's evaluation; `?scene=` picks the
  // state the fake backend serves (see the WP9 block of src/mock/student.ts).
  { name: "student-home-eval", role: "student", path: "/" },
  // Issue #270: an exam sat in Safe Exam Browser — its card opens the steps.
  { name: "student-seb", role: "student", path: "/?seb=1", act: (p) => p.getByRole("button", { name: /^(open in safe exam browser|ouvrir dans safe exam browser)$/i }).first().click() },
  { name: "student-lobby", role: "student", path: `${TAKE}?scene=lobby` },
  { name: "player-mcq", role: "student", path: `${TAKE}?scene=running` },
  { name: "player-cloze", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 2) },
  { name: "player-short", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 3) },
  { name: "player-code", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 4) },
  // The run is REAL here: the mock's code question says `runtime: "runno"`,
  // so this clicks Run and waits for clang.wasm to compile the program and
  // for the three cases to execute in a Web Worker (ADR-015). The first run
  // of a browser fetches ~53 MB of runtime, hence the wait.
  { name: "player-run", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 4); await p.getByRole("button", { name: /^(run the tests|lancer les tests)$/i }).click(); await p.getByText(/^(Compiled|Compilé)$/).waitFor({ timeout: 60000 }); await p.waitForTimeout(500); } },
  // Issue #129: Compile has no cooldown, so the toolbar right after it is
  // all ready; after the tests, only Run the tests (and Free try) refill.
  { name: "player-compile", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 4); await p.getByRole("button", { name: /^(compile|compiler)$/i }).click(); await p.getByText(/^(Compiled|Compilé|Compilation failed|Compilation échouée)$/).waitFor({ timeout: 60000 }); await p.waitForTimeout(500); } },
  { name: "player-run-manual", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 4); await p.getByRole("button", { name: /^(free try|essai libre)$/i }).click(); await p.getByRole("button", { name: /^(run once|exécuter une fois)$/i }).click(); await p.getByLabel(/^(Output|Sortie)$/).waitFor({ timeout: 60000 }); await p.waitForTimeout(300); } },
  // `codeimage` (ADR-021): question 6. Its runtime is the server's, so Run
  // goes through the mock's `POST /attempts/:id/simulate`.
  { name: "player-circuit", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 5) },
  // The circuit in the attempt's expand layer (ADR-046, second addendum): the clock, the save state, the way back.
  { name: "player-circuit-expanded", role: "student", path: `${TAKE}?scene=running`, fold: true, act: async (p) => { await openQuestion(p, 5); await p.getByRole("button", { name: /^(Expand|Agrandir)$/ }).click(); await p.waitForTimeout(400); } },
  { name: "player-codeimage", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 6) },
  // The essay (issue #192): the formatted field and its counter, then past the limit.
  { name: "player-rich", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 7) },
  { name: "player-rich-over", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 7); await p.locator("[contenteditable=true]").first().click(); await p.keyboard.press("Control+End"); await p.keyboard.insertText(" écrire bien au-delà de la limite.".repeat(40)); await p.waitForTimeout(300); } },
  // The categorize item (docs/04 §4.13): the board empty, then three cards placed by click-then-click and a fourth selected.
  { name: "player-categorize", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 8) },
  { name: "player-categorize-placed", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 8); for (const [card, column] of [["int", "Entier"], ["double", "Virgule flottante"], ["char *", "Pointeur"]]) { await p.getByRole("button", { name: card, exact: true }).click(); await p.getByRole("button", { name: new RegExp(`${column}$`) }).click(); } await p.getByRole("button", { name: "void *", exact: true }).click(); await p.waitForTimeout(300); } },
  // The diagram item (docs/04 §4.14): the canvas inline under the prompt, then
  // expanded over the page, under the bar with the clock and the way back.
  { name: "player-diagram", role: "student", path: `${TAKE}?scene=running`, act: (p) => openQuestion(p, 9) },
  { name: "player-diagram-expanded", role: "student", path: `${TAKE}?scene=running`, fold: true, act: async (p) => { await openQuestion(p, 9); await p.getByRole("button", { name: /^(Expand|Agrandir)$/ }).click(); await p.waitForTimeout(400); } },
  { name: "player-codeimage-run", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 6); await p.getByRole("button", { name: /^(run|exécuter)$/i }).click(); await p.getByText(/pixels (correct|corrects)/).waitFor(); } },
  { name: "player-codeimage-diff", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 6); await p.getByRole("button", { name: /^(run|exécuter)$/i }).click(); await p.getByText(/pixels (correct|corrects)/).waitFor(); await p.getByRole("radio", { name: /^(difference|différence)$/i }).check({ force: true }); } },
  { name: "player-codeimage-single", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await openQuestion(p, 6); await p.getByRole("button", { name: /^(run|exécuter)$/i }).click(); await p.getByText(/pixels (correct|corrects)/).waitFor(); await p.getByRole("radio", { name: /^(single|seule)$/i }).check({ force: true }); await p.getByRole("radio", { name: /^(difference|différence)$/i }).check({ force: true }); } },
  { name: "player-submit", role: "student", path: `${TAKE}?scene=running`, fold: true, act: (p) => p.getByRole("button", { name: /hand in/i }).first().click() },
  // Issue #203: the Handed-in screen of an `on_release` exam — Back to home
  // alone, since the results page would only say "not published yet".
  { name: "player-handed-in", role: "student", path: `${TAKE}?scene=running`, act: async (p) => { await p.getByRole("button", { name: /hand in/i }).first().click(); await p.getByRole("dialog").getByRole("button", { name: /hand in/i }).click(); await p.getByRole("heading", { name: /handed in/i }).waitFor(); } },
  // A ONE-question evaluation: no progress strip and no previous / next,
  // and, once the question holds an answer, "Hand in" takes the accent
  // (issue #89: answered with no click). "Clear my selection" takes it back.
  { name: "player-single", role: "student", path: `${TAKE}?scene=single` },
  { name: "player-single-answered", role: "student", path: `${TAKE}?scene=single`, act: async (p) => { await p.getByRole("radio").first().check({ force: true }); await p.getByRole("button", { name: /clear my selection/i }).waitFor(); } },
  // Issue #89: the question list with its four states at once — answered,
  // left unanswered, flagged, nothing yet — on the flagged empty question.
  { name: "player-marks", role: "student", path: `${TAKE}?scene=marks` },
  // The same list, the student having left the question unanswered: the flag
  // in the card's corner and "Leave unanswered" under it, both pressed.
  { name: "player-marks-skipped", role: "student", path: `${TAKE}?scene=marks`, act: async (p) => { await p.getByRole("button", { name: /^leave unanswered$/i }).click(); await p.getByRole("button", { name: /^leave unanswered$/i, pressed: true }).waitFor(); } },
  // Issue #125: an exercise opens its bar with a Home button; an exam never.
  { name: "player-exercise", role: "student", path: `${TAKE}?scene=exercise`, fold: true },
  // `forward_only`: the first question validated and closed, the explicit
  // "Validate and continue" step as the primary, and its confirmation.
  { name: "player-forward", role: "student", path: `${TAKE}?scene=forward` },
  { name: "player-forward-confirm", role: "student", path: `${TAKE}?scene=forward`, fold: true, act: async (p) => { await p.getByRole("button", { name: /^(validate|leave blank) and continue$/i }).first().click(); await p.getByRole("dialog").waitFor(); } },
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
  { name: "pools-admin-all", role: "admin", path: "/pools", act: (p) => p.getByRole("switch", { name: /other teachers/i }).click() },
  { name: "pools-list", role: "teacher", path: "/pools", ls: { "quiz-pools-view": "list" } },
  { name: "pools-empty", role: "teacher", path: "/pools?empty=1" },
  { name: "pools-error", role: "teacher", path: "/pools?fail=1", settle: 2500 },
  // The icon picker, reached the way a teacher reaches it: the New pool form
  // first, then the round button beside the name.
  { name: "pool-new", role: "teacher", path: "/pools", fold: true, act: (p) => p.getByRole("button", { name: /^(new pool|nouvelle banque)$/i }).first().click() },
  { name: "pools-icon", role: "teacher", path: "/pools", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(new pool|nouvelle banque)$/i }).first().click();
      await p.waitForTimeout(300);
      await p.getByRole("button", { name: /^(change the icon|changer l'icône)$/i }).first().click();
      // The click leaves the pointer over whichever icon took that spot, and
      // its tooltip then sits in the middle of the grid.
      await p.mouse.move(0, 0);
    } },
  // #213: the same step with a colour picked — the swatch ringed, every tile
  // previewing its icon in it.
  { name: "pools-icon-color", role: "teacher", path: "/pools", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(new pool|nouvelle banque)$/i }).first().click();
      await p.waitForTimeout(300);
      await p.getByRole("button", { name: /^(change the icon|changer l'icône)$/i }).first().click();
      await p.waitForTimeout(300);
      // The radio is visually hidden: its swatch (the label) takes the click.
      await p.getByRole("radio", { name: /^(teal|sarcelle)$/i }).locator("..").click();
      await p.waitForTimeout(300);
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
  { name: "notifications", role: "teacher", path: "/", fold: true, act: async (p) => { await p.getByRole("button", { name: /^user menu/i }).first().click(); await p.getByRole("menuitem", { name: /^notifications/i }).click(); } },
  { name: "notifications-many", role: "teacher", path: "/?many=1", fold: true, act: async (p) => { await p.getByRole("button", { name: /^user menu/i }).first().click(); await p.getByRole("menuitem", { name: /^notifications/i }).click(); } },

  // WP: live polls. The launcher is the `/polls` page (the navigation's
  // "Poll" entry, hidden in the drawer on a phone); the projection is a page,
  // and the mock addresses its three polls by name.
  { name: "poll-launcher", role: "teacher", path: "/polls" },
  // "Ask a new question": the type's own editor, without marks, and saved
  // nowhere (ADR-014, addendum 2026-09-23). The second scene presses "Start
  // the poll" on the blank question, which the schema refuses.
  { name: "poll-launcher-new", role: "teacher", path: "/polls", act: (p) => p.getByRole("tab", { name: /ask a new question|poser une nouvelle question/i }).click() },
  {
    name: "poll-launcher-new-refused",
    role: "teacher",
    path: "/polls",
    act: async (p) => {
      await p.getByRole("tab", { name: /ask a new question|poser une nouvelle question/i }).click();
      await p.getByRole("button", { name: /start the poll|lancer le sondage/i }).click();
    },
  },
  // "From pools" (#162): the pool screen's search over every pool; with a
  // classroom as the audience, the "Classroom pools | All pools" control.
  { name: "poll-launcher-pools", role: "teacher", path: "/polls", act: (p) => p.getByRole("tab", { name: /from pools|depuis les pools/i }).click() },
  { name: "poll-launcher-pools-room", role: "teacher", path: "/polls", ls: { "quiz-poll-classroom": "r1" }, act: (p) => p.getByRole("tab", { name: /from pools|depuis les pools/i }).click() },
  {
    name: "poll-launcher-pools-filters",
    role: "teacher",
    path: "/polls",
    fold: true,
    act: async (p) => {
      await p.getByRole("tab", { name: /from pools|depuis les pools/i }).click();
      await p.getByRole("button", { name: /^(filters|filtres)/i }).click();
    },
  },
  { name: "poll-projection", role: "teacher", path: "/evaluations/poll/poll", fold: true },
  { name: "poll-projection-revealed", role: "teacher", path: "/evaluations/poll/poll?revealed=1", fold: true },
  { name: "poll-ended", role: "teacher", path: "/evaluations/poll-ended/poll", fold: true },
  // An ended mcq as one large donut (Space): the room's split, by choice.
  { name: "poll-ended-donut", role: "teacher", path: "/evaluations/poll-ended/poll", fold: true, act: async (p) => { await p.keyboard.press("v"); await p.keyboard.press("r"); await p.waitForTimeout(300); await p.keyboard.press("Space"); } },
  { name: "poll-ended-donut-light", role: "teacher", path: "/evaluations/poll-ended/poll", ls: { "quiz-theme": "light" }, fold: true, act: async (p) => { await p.keyboard.press("v"); await p.keyboard.press("r"); await p.waitForTimeout(300); await p.keyboard.press("Space"); } },
  { name: "poll-ended-donut-revealed", role: "teacher", path: "/evaluations/poll-ended/poll", fold: true, act: async (p) => { await p.keyboard.press("v"); await p.waitForTimeout(300); await p.keyboard.press("Space"); } },
  // "Keep this question" (ADR-014, addenda item 6): beside "Run again" once
  // the poll is over, then "Kept in Polls"; a bookmark icon while it runs.
  { name: "poll-kept", role: "teacher", path: "/evaluations/poll-ended/poll", fold: true, act: (p) => p.getByRole("button", { name: /keep this question|garder cette question/i }).click() },
  { name: "poll-projection-votes", role: "teacher", path: "/evaluations/poll/poll?votes=1", fold: true },
  // No question kept yet: where they come from, and the other tab.
  { name: "poll-launcher-empty", role: "teacher", path: "/polls?empty=1" },
  // The evaluation's picker on the Polls pool: the opinion question is out of reach.
  { name: "eval-config-picker-keyless", role: "teacher", path: "/evaluations/draft?step=questions", act: async (p) => { await p.getByRole("button", { name: /add questions/i }).first().click(); await p.getByLabel(/^pool$|^banque$/i).selectOption({ label: "Polls" }); } },
  // The same question in the editor: one muted line, nothing to fix to view it.
  { name: "question-keyless", role: "teacher", path: "/pools/p0", act: (p) => p.getByRole("button", { name: /^(Edit|Modifier) Le rythme des laboratoires/ }).first().click() },
  // The worst case of the wall: a three-line question and eight choices that
  // wrap. It must come back with no scrollbar and nothing cut off — the band
  // shrinks itself (`fitScale`), so the fold IS the whole screen.
  { name: "poll-projection-long", role: "teacher", path: "/evaluations/poll-long/poll", fold: true },
  { name: "poll-projection-long-revealed", role: "teacher", path: "/evaluations/poll-long/poll?revealed=1", fold: true },
  // An opinion poll: no key, so the reveal marks nothing and says "Results
  // shown"; the phone gets the distribution instead of a verdict.
  { name: "poll-projection-opinion-revealed", role: "teacher", path: "/evaluations/poll-opinion/poll?votes=1", fold: true },
  // The participant's half, as a GUEST: no session at all, which is what a
  // phone in the room has (`?as=guest` in src/mock/poll.ts).
  // ADR-051 §7: the kiosk station's screen, and the phone that pairs it. The
  // mock keeps the one pending pairing in localStorage (mock/kiosk.ts), so
  // the phone's scenes seed it.
  { name: "kiosk-station", role: "student", path: "/kiosk", settle: 1500, fold: true },
  { name: "pair", role: "student", path: "/pair?code=BCDF-GHJK", ls: KIOSK_PAIRING },
  { name: "pair-code", role: "student", path: "/pair" },
  { name: "pair-invalid", role: "student", path: "/pair?code=CCCC-DDDD", ls: KIOSK_PAIRING },
  { name: "pair-none", role: "student", path: "/pair?code=BCDF-GHJK&empty=1", ls: KIOSK_PAIRING },
  { name: "join-mcq", role: "teacher", path: "/p/QZ4F7K?as=guest" },
  { name: "join-revealed", role: "teacher", path: "/p/QZ4F7K?as=guest&revealed=1" },
  // Votes and key both shown while the poll runs: the question and Send stay
  // (ADR-014, addendum 2026-09-29).
  { name: "join-revealed-votes", role: "teacher", path: "/p/QZ4F7K?as=guest&revealed=1&votes=1" },
  { name: "join-ended", role: "teacher", path: "/p/EN6D3D?as=guest" },
  { name: "join-opinion-revealed", role: "teacher", path: "/p/AV3R8T?as=guest&votes=1" },
  // A classroom's poll, and this account is on neither its roster nor its staff
  // (ADR-014, addendum 2026-09-27): the refusal, and nothing of the question.
  { name: "join-not-on-roster", role: "student", path: "/p/CL5S9P" },
  { name: "pool", role: "teacher", path: "/pools/p1" },
  { name: "pool-empty", role: "teacher", path: "/pools/p1?empty=1", settle: 800 },
  { name: "pool-error", role: "teacher", path: "/pools/p1?fail=1", settle: 2500 },
  { name: "pool-loading", role: "teacher", path: "/pools/p1?slow=1", settle: 300 },
  { name: "pool-many", role: "teacher", path: "/pools/p1?many=1" },
  { name: "pool-filters", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.getByRole("button", { name: /^filtres|^filters/i }).first().click() },
  // F-STAT-03: the statistics block at the foot of the sheet, a bound typed,
  // then the list it leaves behind (the three questions of `p1` with stats).
  { name: "pool-filters-stats", role: "teacher", path: "/pools/p1", fold: true, act: statsBound },
  { name: "pool-stats-filtered", role: "teacher", path: "/pools/p1", act: async (p) => {
    await statsBound(p);
    await p.getByRole("button", { name: /^(Done|Terminé|OK)$/ }).first().click();
    await p.waitForTimeout(500);
  } },
  // A click on a row shows the question as a student reads it: docked beside
  // the list from 1280 px (the table drops its low-priority columns), in the
  // list's place below. Run at 1920, 1440 and 1024 to see all three.
  { name: "pool-preview", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      await p.getByRole("table").getByText("ptr-arith-01", { exact: true }).click();
      // The code player loads its editor lazily.
      await p.waitForTimeout(1500);
    } },
  { name: "pool-preview-cards", role: "teacher", path: "/pools/p1", ls: { "quiz-pool-view": "cards" }, fold: true, act: async (p) => {
      await p.getByText("ptr-arith-01", { exact: true }).first().click();
      await p.waitForTimeout(1500);
    } },
  // Favourites (F-POOL-10): the mock starts with three starred questions of
  // p1 — the stars on the cards, and the confirm of "Clear favourites".
  { name: "pool-stars-cards", role: "teacher", path: "/pools/p1", ls: { "quiz-pool-view": "cards" }, act: skipCoach },
  { name: "pool-stars-clear", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.getByRole("button", { name: /^(Clear favourites|Effacer les favoris)$/ }).first().click() },
  // The row's own three actions, and the confirm dialog the last one goes through.
  { name: "pool-row-delete", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.getByRole("button", { name: /^(Delete|Supprimer) ptr-arith-01$/ }).first().click() },
  // A question's statistics (ADR-038): the panel with its reset, the reset's
  // confirmation, and a pool this browser only reads (no reset).
  { name: "pool-stats", role: "teacher", path: "/pools/p1", fold: true, act: (p) => p.getByRole("button", { name: /^(Statistics of|Statistiques de) / }).first().click() },
  { name: "pool-stats-reset", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(Statistics of|Statistiques de) / }).first().click();
      await p.getByRole("button", { name: /^(Reset statistics|Réinitialiser les statistiques)$/ }).click();
    } },
  { name: "pool-stats-reader", role: "teacher", path: "/pools/p3", fold: true, act: (p) => p.getByRole("button", { name: /^(Statistics of|Statistiques de) / }).first().click() },
  // The cards, and the question the mock gives a NEGATIVE rate (ADR-026).
  { name: "pool-stats-negative", role: "teacher", path: "/pools/p1", ls: { "quiz-pool-view": "cards" }, fold: true, act: (p) => p.getByRole("button", { name: /^(Statistics of|Statistiques de) / }).nth(1).click() },
  // The choices picked on a multiple-choice question (ADR-043): a strong
  // distractor, a multiple-answer question, and too few answers yet.
  ...[
    ["pool-stats-choices", "ptr-null-check"],
    ["pool-stats-choices-multiple", "fopen-modes"],
    ["pool-stats-choices-none", "array-decay"],
  ].map(([name, question]) => ({ name, role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      await p.getByRole("button", { name: new RegExp(`^(Statistics of|Statistiques de) ${question}$`) }).first().click();
      await p.getByRole("dialog").locator("section").last().evaluate((el) => el.scrollIntoView({ block: "end" }));
    } })),
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
  // The categories page of a pool: the tree, its counts, the row menu and a
  // name being renamed in place; and the sidebar's tooltip on a cut name.
  { name: "pool-categories", role: "teacher", path: "/pools/p1/categories" },
  { name: "pool-categories-error", role: "teacher", path: "/pools/p1/categories?fail=1", settle: 2500 },
  { name: "pool-categories-menu", role: "teacher", path: "/pools/p1/categories", fold: true, act: (p) => p.getByRole("button", { name: /^(Actions for|Actions pour) Tableaux$/ }).first().click() },
  { name: "pool-categories-rename", role: "teacher", path: "/pools/p1/categories", fold: true, act: (p) => p.getByRole("button", { name: /^(Rename|Renommer) Tableaux$/ }).first().click() },
  { name: "pool-categories-move", role: "teacher", path: "/pools/p1/categories", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(Actions for|Actions pour) Fichiers$/ }).first().click();
      await p.getByRole("menuitem", { name: /^(Move to…|Déplacer vers…)$/ }).click();
    } },
  { name: "pool-categories-tip", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      // The sidebar is a drawer on a phone, and a phone has no hover.
      if ((p.viewportSize()?.width ?? 1440) < 1024) return;
      await p.getByRole("button", { name: /^Numération et codage des entiers$/ }).first().hover();
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
  // Its second step: a type chosen, the name field holding the focus.
  { name: "pool-new-question-name", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
    await p.getByRole("button", { name: /nouvelle question|new question/i }).first().click();
    await p.getByRole("button", { name: /^(code|code image)\b/i }).first().click();
    await p.getByLabel(/internal name|nom interne/i).waitFor();
    await p.waitForTimeout(250); // the slide
  } },
  // The categories live in the frame's sidebar now, so on a phone they are
  // inside the drawer: the scene opens it first when there is one.
  { name: "pool-category-menu", role: "teacher", path: "/pools/p1", fold: true, act: async (p) => {
      const drawer = p.getByRole("button", { name: /open menu|ouvrir le menu/i });
      if (await drawer.isVisible()) {
        await drawer.click();
        await p.getByLabel(/internal name|nom interne/i).waitFor();
    await p.waitForTimeout(250); // the slide
      }
      await openRowMenu(p, /^actions$/i);
    } },

  { name: "editor-mcq", role: "teacher", path: "/questions/q2" },
  // A choice emptied: the autosave's issue, on the field and named under the list.
  { name: "editor-mcq-issues", role: "teacher", path: "/questions/q2", settle: 3000, act: async (p) => { await p.getByRole("textbox", { name: "Text of choice B" }).fill(""); await p.waitForTimeout(2500); } },
  { name: "editor-code", role: "teacher", path: "/questions/q1", settle: 5000 },
  { name: "editor-short", role: "teacher", path: "/questions/q3" },
  // Issue #97: every field of an accepted answer labelled, and the sentence
  // saying what it accepts — a number with a tolerance, a date and a time.
  { name: "editor-short-matchers", role: "teacher", path: "/questions/q3", act: async (p) => {
      await p.getByLabel(/^(tolerance|tolérance) 1$/i).fill("0.5");
      await p.getByLabel(/^(unit required|unité obligatoire) 1$/i).check();
      const add = p.getByRole("button", { name: /add an accepted answer|ajouter une réponse acceptée/i });
      await add.click();
      await p.getByLabel(/^(matcher|critère) 2$/i).selectOption("date");
      await p.getByLabel(/^(value|valeur) 2$/i).fill("2026-09-20");
      await p.getByLabel(/^(tolerance|tolérance) \((days|jours)\) 2$/i).fill("2");
      await p.getByLabel(/^points 2$/i).fill("0.5");
      await add.click();
      await p.getByLabel(/^(matcher|critère) 3$/i).selectOption("time");
      await p.getByLabel(/^(value|valeur) 3$/i).fill("14:05");
      await p.getByLabel(/^(tolerance|tolérance) \(minutes\) 3$/i).fill("10");
      await p.getByLabel(/^(matcher|critère) 1$/i).scrollIntoViewIfNeeded();
    } },
  // ADR-056: a parameterized question opens on its variables and five draws;
  // one draw played with its key; a row's issue; the pool's pill.
  { name: "editor-parameterized", role: "teacher", path: "/questions/q-fall", settle: 3000 },
  { name: "editor-parameterized-draw", role: "teacher", path: "/questions/q-fall", settle: 3000, act: async (p) => {
      await p.getByRole("button", { name: /^(show draw|voir le tirage) 2$/i }).click();
      await p.getByRole("button", { name: /^(show answers|montrer les réponses|afficher les réponses)$/i }).click();
      await p.waitForTimeout(800);
    } },
  { name: "editor-parameterized-issue", role: "teacher", path: "/questions/q-fall", settle: 3000, act: async (p) => {
      await p.getByRole("button", { name: /^(add a variable|ajouter une variable)$/i }).click();
      // A valid name with no expression yet: its own issue, and the unused warning.
      await p.getByLabel(/^(name|nom) 4$/i).fill("v0");
      await p.getByLabel(/^format 4$/i).selectOption("figures");
      await p.waitForTimeout(2000);
    } },
  { name: "pool-parameterized", role: "teacher", path: "/pools/p2" },
  { name: "editor-cloze", role: "teacher", path: "/questions/q4" },
  // `codeimage` (ADR-021): the last question of the mock pool. The try runs
  // through the mock's `POST /try`, whose details carry the reference image.
  { name: "editor-codeimage", role: "teacher", path: "/questions/q16", settle: 5000 },
  { name: "editor-circuit", role: "teacher", path: "/questions/q8" },
  // The teacher's expand layer over the reference circuit: its title, the save state, "Close".
  { name: "editor-circuit-expanded", role: "teacher", path: "/questions/q8", fold: true, settle: 2000, act: async (p) => { await p.getByRole("button", { name: /^(Expand|Agrandir)$/ }).first().click(); await p.waitForTimeout(400); } },
  { name: "editor-rich", role: "teacher", path: "/questions/q17", settle: 3000 },
  { name: "editor-categorize", role: "teacher", path: "/questions/q18", settle: 3000 },
  // The diagram (ADR-046): published, so its kind is shown locked; the new draft's grid is `editor-diagram-new`.
  { name: "editor-diagram", role: "teacher", path: "/questions/q19", settle: 3000 },
  // The reference diagram expanded, text tab and all (the starter has a button of its own).
  { name: "editor-diagram-expanded", role: "teacher", path: "/questions/q19", fold: true, settle: 3000, act: async (p) => { await p.getByRole("button", { name: /^(Expand|Agrandir)$/ }).first().click(); await p.waitForTimeout(400); } },
  { name: "editor-diagram-new", role: "teacher", path: "/pools/p1", settle: 3000, act: async (p) => { await p.getByRole("button", { name: /nouvelle question|new question/i }).first().click(); await p.getByRole("button", { name: /^(diagram|diagramme)\b/i }).first().click(); await p.getByLabel(/internal name|nom interne/i).fill("uml-demo"); await p.keyboard.press("Enter"); await p.waitForURL(/\/questions\//); await p.waitForTimeout(2500); } },
  // A column left unnamed and a card emptied: the autosave's issues, on the fields and under the board.
  // The tray emptied of its distractor: it takes no room above the "new card" field.
  { name: "editor-categorize-empty-tray", role: "teacher", path: "/questions/q18", settle: 3000, act: async (p) => { await p.locator("li", { hasText: "string" }).getByRole("button", { name: /^Remove card/ }).click(); await p.waitForTimeout(500); } },
  // ...and opens again while a card is dragged, to take it back (the pointer stays down).
  { name: "editor-categorize-empty-tray-drag", role: "teacher", path: "/questions/q18", settle: 3000, act: async (p) => { await p.locator("li", { hasText: "string" }).getByRole("button", { name: /^Remove card/ }).click(); const grip = p.locator("li", { hasText: "double" }).getByRole("button", { name: /^Move card/ }); const b = await grip.boundingBox(); await p.mouse.move(b.x + 5, b.y + 5); await p.mouse.down(); await p.mouse.move(b.x + 20, b.y - 20, { steps: 4 }); await p.mouse.move(b.x + 40, b.y - 110, { steps: 8 }); await p.waitForTimeout(300); } },
  { name: "editor-categorize-issues", role: "teacher", path: "/questions/q18", settle: 3000, act: async (p) => { await p.getByRole("textbox", { name: "Column name 2" }).fill(""); await p.getByRole("textbox", { name: "Text of card 1" }).fill(""); await p.waitForTimeout(2500); } },
  { name: "editor-codeimage-try", role: "teacher", path: "/questions/q16", settle: 5000, act: async (p) => { await p.getByRole("button", { name: /try the reference solution|essayer la solution de référence/i }).click(); await p.getByRole("button", { name: /use as target|utiliser comme cible/i }).waitFor(); await p.getByRole("button", { name: /use as target|utiliser comme cible/i }).scrollIntoViewIfNeeded(); } },
  // "Student preview": a page of its own, opened by the editor in a new tab.
  { name: "question-preview", role: "teacher", path: "/questions/q2/preview", settle: 3000 },
  // "Show answers": the player replaced by the type's review of the key.
  { name: "question-preview-answers", role: "teacher", path: "/questions/q2/preview", settle: 1500, act: (p) => p.getByRole("button", { name: /show answers|afficher les réponses/i }).click() },
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
      // For `code`, grading is running every test: the button says so.
      await p.getByRole("button", { name: /lancer tous les tests|run all the tests/i }).first().click();
      await p.waitForTimeout(1200);
    } },
  // Issue #267: an essay's grade is a proposal, so the try shows no score.
  { name: "try-rich-graded", role: "teacher", path: "/questions/q17?tab=try", settle: 3000, act: async (p) => {
      await p.locator("[contenteditable=true]").last().click();
      await p.keyboard.insertText("Un pointeur contient l'adresse d'une variable.");
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
  // One scene per question type of the table (ADR-044): the closed
  // evaluation holds, in order, code, mcq, circuit, short, rich, categorize,
  // codeimage and diagram (`itemSource` in src/mock/evaluation.ts).
  { name: "grading", role: "teacher", path: "/evaluations/closed/grading" },
  { name: "grading-code-expanded", role: "teacher", path: "/evaluations/closed/grading", act: async (p) => {
      await p.locator('[role="button"][aria-expanded="false"]').first().click();
    } },
  { name: "grading-mcq", role: "teacher", path: "/evaluations/closed/grading", act: (p) => nextQuestion(p, 1) },
  { name: "grading-circuit", role: "teacher", path: "/evaluations/closed/grading", act: (p) => nextQuestion(p, 2) },
  { name: "grading-short", role: "teacher", path: "/evaluations/closed/grading", act: (p) => nextQuestion(p, 3) },
  { name: "grading-rich", role: "teacher", path: "/evaluations/closed/grading", settle: 3000, act: (p) => nextQuestion(p, 4) },
  { name: "grading-categorize", role: "teacher", path: "/evaluations/closed/grading", settle: 3000, act: (p) => nextQuestion(p, 5) },
  { name: "grading-codeimage", role: "teacher", path: "/evaluations/closed/grading", settle: 3000, act: (p) => nextQuestion(p, 6) },
  { name: "grading-diagram", role: "teacher", path: "/evaluations/closed/grading", settle: 3000, act: (p) => nextQuestion(p, 7) },
  { name: "grading-diagram-panel", role: "teacher", path: "/evaluations/closed/grading", settle: 3000, fold: true, act: async (p) => { await nextQuestion(p, 7); await openRow(p, 1); } },
  // ADR-056 §9: the parameterized question, the closed evaluation's tenth —
  // the question as written on the key's row, the rows by verdict, an
  // answer's own values and key, and the variables on the key's panel.
  { name: "grading-param", role: "teacher", path: "/evaluations/closed/grading", act: (p) => nextQuestion(p, 9) },
  { name: "grading-param-panel", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => { await nextQuestion(p, 9); await openRow(p, 1); } },
  { name: "grading-param-expected", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => { await nextQuestion(p, 9); await openRow(p, 0); } },
  // ADR-044: the table and its layers — the question menu, the answer
  // panel (an answer, the key, the adjustment), the filters, a sort, names.
  { name: "grading-menu", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^Question 1 (of|sur) / }).first().click();
    } },
  { name: "grading-panel", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => {
      await openRow(p, 1);
    } },
  { name: "grading-panel-expected", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => {
      await openRow(p, 0);
    } },
  { name: "grading-override", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => {
      await openRow(p, 1);
      await p.getByRole("dialog").getByRole("button", { name: /^(Adjust|Modifier)$/ }).click();
    } },
  { name: "grading-batch-confirm", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => {
      await nextQuestion(p, 3);
      await p.getByRole("button", { name: /^(Validate|Valider) \d+/ }).first().click();
    } },
  { name: "grading-todo", role: "teacher", path: "/evaluations/closed/grading", act: async (p) => {
      await nextQuestion(p, 3);
      await p.locator("label").filter({ hasText: /^(To validate|À valider)/ }).first().click();
    } },
  { name: "grading-ai", role: "teacher", path: "/evaluations/closed/grading", act: async (p) => {
      await nextQuestion(p, 3);
      await p.locator("label").filter({ hasText: /^(AI|IA)$/ }).first().click();
    } },
  { name: "grading-sorted", role: "teacher", path: "/evaluations/closed/grading", act: async (p) => {
      await p.getByRole("button", { name: /^(Points)$/ }).first().click();
    } },
  { name: "grading-names", role: "teacher", path: "/evaluations/closed/grading", act: async (p) => {
      await p.getByRole("switch", { name: /^(Anonymise|Anonymiser)$/ }).click();
      await p.waitForTimeout(500);
    } },
  { name: "grading-regrade", role: "teacher", path: "/evaluations/closed/grading", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(Re-grade|Re-corriger)/ }).first().click();
    } },
  { name: "grading-empty", role: "teacher", path: "/evaluations/closed/grading?empty=1", settle: 800 },
  { name: "grading-error", role: "teacher", path: "/evaluations/closed/grading?fail=1", settle: 2500 },
  { name: "grading-loading", role: "teacher", path: "/evaluations/closed/grading?slow=1", settle: 300 },

  { name: "results", role: "teacher", path: "/evaluations/closed/results" },
  { name: "results-released", role: "teacher", path: "/evaluations/released/results" },
  { name: "results-questions", role: "teacher", path: "/evaluations/closed/results?tab=questions", settle: 2500 },
  // The correction on a beamer (ADR-033): hidden, revealed (R), and walked
  // down to the cloze, the eighth question, whose blanks carry their bars.
  { name: "correction", role: "teacher", path: "/evaluations/closed/correction", fold: true, settle: 2500, act: (p) => projectNext(p, 1) },
  { name: "correction-revealed", role: "teacher", path: "/evaluations/closed/correction", fold: true, settle: 2500, act: async (p) => { await projectNext(p, 1); await p.keyboard.press("r"); } },
  { name: "correction-code-revealed", role: "teacher", path: "/evaluations/closed/correction", fold: true, settle: 2500, act: (p) => p.keyboard.press("r") },
  { name: "correction-cloze", role: "teacher", path: "/evaluations/closed/correction", fold: true, settle: 2500, act: (p) => projectNext(p, 7) },
  { name: "correction-param-revealed", role: "teacher", path: "/evaluations/closed/correction", fold: true, settle: 2500, act: async (p) => { await projectNext(p, 9); await p.keyboard.press("r"); } },
  { name: "correction-cloze-revealed", role: "teacher", path: "/evaluations/closed/correction", fold: true, settle: 2500, act: async (p) => { await projectNext(p, 7); await p.keyboard.press("r"); } },
  { name: "results-release-confirm", role: "teacher", path: "/evaluations/closed/results", fold: true, act: (p) => p.getByRole("button", { name: /publish results|publier les résultats/i }).first().click() },
  { name: "results-empty", role: "teacher", path: "/evaluations/closed/results?empty=1", settle: 800 },
  { name: "results-error", role: "teacher", path: "/evaluations/closed/results?fail=1", settle: 2500 },

  { name: "feedback", role: "student", path: `/attempts/${ATTEMPT_PAST}/feedback` },
  // ADR-026 (#130): negative marking, the mock's `?negative=1` scene flag.
  { name: "negative-eval-advanced", role: "teacher", path: "/evaluations/draft?step=timing&negative=1", act: (p) => p.getByRole("button", { name: /^advanced options$/i }).first().click() },
  { name: "negative-lobby", role: "student", path: `${TAKE}?scene=lobby&negative=1` },
  { name: "negative-player-mcq", role: "student", path: `${TAKE}?scene=running&negative=1` },
  { name: "negative-grading", role: "teacher", path: "/evaluations/closed/grading?negative=1", act: (p) => nextQuestion(p, 1) },
  { name: "negative-grading-override", role: "teacher", path: "/evaluations/closed/grading?negative=1", fold: true, act: async (p) => { await openRow(p, 1); await p.getByRole("dialog").getByRole("button", { name: /^(Adjust|Modifier)$/ }).click(); } },
  { name: "negative-results", role: "teacher", path: "/evaluations/released/results?negative=1" },
  { name: "negative-feedback", role: "student", path: `/attempts/${ATTEMPT_PAST}/feedback?negative=1` },
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
  // F-GH-05 (M2-07): the GitHub card, linked and not.
  { name: "settings-github-linked", role: "teacher", path: "/settings", fold: true, act: (p) => p.getByRole("heading", { name: "GitHub" }).scrollIntoViewIfNeeded() },
  { name: "settings-github-unlinked", role: "teacher", path: "/settings?unlinked=1", fold: true, act: (p) => p.getByRole("heading", { name: "GitHub" }).scrollIntoViewIfNeeded() },
  { name: "settings-github-student", role: "student", path: "/settings?unlinked=1", fold: true, act: (p) => p.getByRole("heading", { name: "GitHub" }).scrollIntoViewIfNeeded() },
  // ADR-054: an admin's Super Powers, off and on, and the red banner above
  // everything — its minutes, its last-five-minutes countdown, and stacked
  // over the student view's banner.
  { name: "settings-admin", role: "admin", path: "/settings?superpowers=0&lastminutes=0" },
  { name: "settings-superpowers", role: "admin", path: "/settings?superpowers=1&lastminutes=0" },
  { name: "superpowers-banner", role: "admin", path: "/?superpowers=1&lastminutes=0", fold: true },
  { name: "superpowers-ending", role: "admin", path: "/?superpowers=0&lastminutes=1", fold: true },
  { name: "superpowers-student-view", role: "admin", path: "/?superpowers=1&lastminutes=0", fold: true, ss: { "quiz-view-as": "student", "quiz-view-as-return": "/" } },
  // The App channel's toast (ADR-030 §a): `?notify=1` makes a student join
  // PRG1-2026 a moment after the page loads, and the bell's toast shows it.
  {
    name: "notification-toast",
    role: "teacher",
    path: "/?notify=1",
    fold: true,
    act: (p) => p.getByText(/students joined PRG1-2026|étudiants ont rejoint PRG1-2026/).waitFor({ timeout: 5000 }),
  },
  { name: "settings-avatar", role: "teacher", path: "/settings", act: (p) => p.getByRole("button", { name: /change picture/i }).first().click() },
  { name: "settings-tokens-empty", role: "teacher", path: "/settings?empty=1" },
  // ADR-023: the consent page an assistant sends the teacher to.
  { name: "oauth-consent", role: "teacher", path: "/oauth/authorize/0190d3c4-0000-7000-8000-000000000001" },
  { name: "oauth-consent-loopback", role: "teacher", path: "/oauth/authorize/0190d3c4-0000-7000-8000-000000000001?loopback=1" },
  { name: "oauth-invalid", role: "teacher", path: "/oauth/authorize/invalid?reason=invalid_redirect_uri" },
  // ADR-030: the page the HEIG Quiz tab in Teams opens in the browser; a
  // token starting with `expired` is one the mock refuses.
  { name: "teams-link", role: "student", path: `/teams/link?token=${"T".repeat(43)}` },
  { name: "teams-link-expired", role: "student", path: `/teams/link?token=expired${"T".repeat(36)}` },
  // ADR-030: the tab itself, inside the mock's fake Teams (`mock/teams.ts`).
  { name: "teams-tab-outside", role: "student", path: "/teams" },
  { name: "teams-tab-unlinked", role: "student", path: "/teams?teams=unlinked" },
  { name: "teams-tab-linked", role: "student", path: "/teams?teams=linked" },
  { name: "teams-tab-target", role: "student", path: "/teams?teams=target" },
  { name: "teams-tab-sso", role: "student", path: "/teams?teams=sso" },
  { name: "teams-tab-refused", role: "student", path: "/teams?teams=refused" },
  { name: "settings-token-new", role: "teacher", path: "/settings", fold: true, act: (p) => p.getByRole("button", { name: /new token/i }).first().click() },
  {
    name: "settings-token-created",
    role: "teacher",
    path: "/settings",
    fold: true,
    act: async (p) => {
      await p.getByRole("button", { name: /new token/i }).first().click();
      await p.getByRole("dialog").getByRole("textbox").fill("Claude Desktop");
      await p.getByRole("button", { name: /create token/i }).click();
      await p.getByRole("dialog", { name: /token created/i }).waitFor();
    },
  },
  { name: "admin", role: "admin", path: "/admin" },
  { name: "admin-empty", role: "admin", path: "/admin?empty=1" },
  { name: "admin-error", role: "admin", path: "/admin?fail=1", settle: 2500 },
  { name: "admin-loading", role: "admin", path: "/admin?slow=1", settle: 300 },
  // F-ADMIN-06: the scheduled tasks, one of each state.
  { name: "admin-tasks", role: "admin", path: "/admin?tab=tasks" },
  { name: "admin-tasks-error", role: "admin", path: "/admin?tab=tasks&fail=1", settle: 2500 },
  // N-OPS-03 (ADR-055): the system status, healthy, degraded, and its states.
  { name: "admin-system", role: "admin", path: "/admin?tab=system&degraded=0" },
  { name: "admin-system-degraded", role: "admin", path: "/admin?tab=system&degraded=1" },
  { name: "admin-system-error", role: "admin", path: "/admin?tab=system&fail=1", settle: 2500 },
  { name: "admin-system-loading", role: "admin", path: "/admin?tab=system&slow=1", settle: 300 },
  // ADR-055 §5: the administrators' health alert, in the bell and in the settings.
  { name: "notifications-admin", role: "admin", path: "/", fold: true, act: async (p) => { await p.getByRole("button", { name: /^user menu/i }).first().click(); await p.getByRole("menuitem", { name: /^notifications/i }).click(); } },
  { name: "settings-admin", role: "admin", path: "/settings" },
  // F-JRN-07 (M4-04): the journal reader. `?journal=1` gives PRG1-2026 (r1)
  // its journal; without it a teacher is sent to the classroom (no Journal tab, M4-05). The student
  // reads the home page and its TOC, under the strip of pages; below 1280 px
  // the TOC is an "On this page" disclosure (opened by the phone scene); a
  // folder's menu, opened from its chevron; the teacher reads a draft with its
  // badges and warnings; a page nobody has is the not-found page.
  { name: "journal-student", role: "student", path: "/classrooms/r1/journal?journal=1" },
  { name: "journal-phone", role: "student", path: "/classrooms/r1/journal/README.md?journal=1", fold: true, act: async (p) => {
      // From 1280 px the TOC is a column, not a disclosure: nothing to open.
      const toggle = p.getByRole("button", { name: /^(on this page|sur cette page)$/i });
      if (await toggle.isVisible()) await toggle.click();
    } },
  { name: "journal-folder-menu", role: "teacher", path: "/classrooms/r1/journal/10-semaine-1/10-pointeurs.md?journal=1", fold: true, act: async (p) => {
      await p.getByRole("button", { name: /^(pages in|pages de) semaine 1 /i }).click();
    } },
  { name: "journal-teacher-hidden", role: "teacher", path: "/classrooms/r1/journal/20-semaine%202%20%C3%A9t%C3%A9/20-brouillon.md?journal=1" },
  { name: "journal-not-found", role: "student", path: "/classrooms/r1/journal/99-nulle-part.md?journal=1" },
  { name: "journal-loading", role: "student", path: "/classrooms/r1/journal?journal=1&slow=1", settle: 300 },
  { name: "journal-error", role: "student", path: "/classrooms/r1/journal?journal=1&fail=1", settle: 2500 },
  // F-JRN-10 (M4-06): the editor, opened from Edit in the staff bar on a page
  // with front matter, `_` emphasis, a fence, KaTeX, a table and raw HTML;
  // its source view with the server's preview; a save refused because the
  // file moved (`?journalconflict=1`), the draft kept; the front matter as
  // fields, edited; and leaving with unsaved changes.
  { name: "journal-edit", role: "teacher", path: `${JOURNAL_EDIT}?journal=1&journalconflict=0`, act: openEditor },
  { name: "journal-edit-source", role: "teacher", path: `${JOURNAL_EDIT}?journal=1&journalconflict=0`, act: async (p) => {
      await openEditor(p);
      await p.getByRole("button", { name: /^(markdown source|source markdown)$/i }).first().click();
      await p.getByRole("button", { name: /^(preview|aperçu)$/i }).click();
      await p.waitForTimeout(600);
    } },
  { name: "journal-edit-conflict", role: "teacher", path: `${JOURNAL_EDIT}?journal=1&journalconflict=1`, act: async (p) => {
      await openEditor(p);
      await typeInEditor(p);
      await p.getByRole("button", { name: /^(save|enregistrer)$/i }).click();
      await p.getByText(/^(someone saved this page|quelqu'un a enregistré cette page)/i).waitFor();
    } },
  { name: "journal-edit-frontmatter", role: "teacher", path: `${JOURNAL_EDIT}?journal=1&journalconflict=0`, act: async (p) => {
      await openEditor(p);
      await p.getByLabel(/^(title|titre)$/i).fill("Les pointeurs, pas à pas");
      await p.getByRole("switch", { name: /^(draft|brouillon)$/i }).click();
    } },
  { name: "journal-edit-unsaved", role: "teacher", path: `${JOURNAL_EDIT}?journal=1&journalconflict=0`, fold: true, act: async (p) => {
      await openEditor(p);
      await typeInEditor(p);
      await p.getByRole("button", { name: /^(cancel|annuler)$/i }).click();
    } },
  // ADR-057 (M4-09): a Quiz-mode page's history, an older version on view,
  // and the deleted pages.
  { name: "journal-revisions", role: "teacher", path: `${JOURNAL_EDIT}?journal=1`, fold: true, act: async (p) => {
      await journalPagesMenu(p, /^(history|historique)$/i);
      await p.getByRole("dialog").getByRole("button", { name: /Anne Dupuis/ }).click();
      await p.waitForTimeout(600);
    } },
  { name: "journal-revisions-source", role: "teacher", path: `${JOURNAL_EDIT}?journal=1`, fold: true, act: async (p) => {
      await journalPagesMenu(p, /^(history|historique)$/i);
      await p.getByRole("radio", { name: /^markdown$/i }).check({ force: true });
      await p.waitForTimeout(400);
    } },
  { name: "journal-deleted", role: "teacher", path: `${JOURNAL_EDIT}?journal=1`, fold: true, act: (p) => journalPagesMenu(p, /^(deleted pages|pages supprimées)$/i) },
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
 * Dismisses the first-visit coach mark when it is up: on a laptop-height
 * window it sits over the grading header's step picker.
 */
async function skipCoach(page) {
  const skip = page.getByRole("button", { name: /^(Skip|Passer)$/ }).locator("visible=true").first();
  // It shows a moment after the page settles, or not at all.
  if (await skip.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await skip.click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

/** The pool's filter sheet, scrolled to its statistics, with "success from 40 %" typed. */
async function statsBound(page) {
  await skipCoach(page);
  await page.getByRole("button", { name: /^filtres|^filters/i }).first().click();
  const from = page.getByLabel(/^(Success rate, from|Taux de réussite, à partir de)$/);
  await from.fill("40");
  await from.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
}

/** The course page's first template (the mock's exam), opened from its row. */
async function openTemplate(page) {
  await page.getByRole("button", { name: /Examen final/ }).first().click();
  await page.waitForURL(/\/templates\//);
  await page.waitForTimeout(600);
}

/** Opens a row of the grading table in its panel: 0 is the expected row. */
async function openRow(page, n) {
  await page.locator("tbody tr").nth(n).click();
  await page.waitForTimeout(400);
}

/**
 * Walks the grading panel forward `n` questions, with the screen's own "next
 * question" control, so the scene exercises the path a teacher takes.
 */
async function nextQuestion(page, n) {
  for (let i = 0; i < n; i += 1) {
    await page.getByRole("button", { name: /^(next question|question suivante)$/i }).first().click();
    await page.waitForTimeout(400);
  }
}

/** Walks the correction projection forward `n` questions with J, as a clicker would. */
async function projectNext(page, n) {
  for (let i = 0; i < n; i += 1) {
    await page.keyboard.press("j");
    await page.waitForTimeout(250);
  }
}

/** ADR-050: the live header's overflow, "Publish the correction", its confirmation open. */
async function correctionAsk(page) {
  await page.getByRole("button", { name: /^actions$/i }).first().click();
  await page.getByRole("menuitem", { name: /(publish the correction|publier le corrigé)/i }).click();
  await page.waitForTimeout(400);
}

/** …confirmed: the badge in the header, the toast. */
async function correctionPublish(page) {
  await correctionAsk(page);
  await page.getByRole("dialog").getByRole("button", { name: /(publish the correction|publier le corrigé)/i }).click();
  await page.waitForTimeout(800);
}

/** …and the projection it opens, counting the papers handed in so far. */
async function correctionPresent(page) {
  await correctionPublish(page);
  await page.getByRole("button", { name: /^actions$/i }).first().click();
  await page.getByRole("menuitem", { name: /(present the correction|projeter le corrigé)/i }).click();
  await page.waitForTimeout(1200);
}

/** How the journal's editor scenes open the editor (M4-06). */
async function openEditor(page) {
  await page.getByRole("button", { name: /^(edit|modifier)$/i }).click();
  await page.getByRole("textbox", { name: /^(page text|texte de la page)$/i }).waitFor();
}
/** A sentence typed at the end of the page's first paragraph. */
async function typeInEditor(page) {
  const surface = page.getByRole("textbox", { name: /^(page text|texte de la page)$/i });
  await surface.locator("p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Un ajout.");
}

/** The Journal section's mode: In a GitHub repository. */
async function chooseGithubMode(page) {
  await page.getByRole("radio", { name: /^(in a github repository|dans un dépôt github)$/i }).check({ force: true });
}

/** An item of the journal's Pages menu (Quiz mode). */
async function journalPagesMenu(page, item) {
  await page.getByRole("button", { name: /^pages$/i }).click();
  await page.getByRole("menuitem", { name: item }).click();
  await page.waitForTimeout(500);
}

/** "Create a journal" under a name the organization already has: the 409 and its suggestion. */
async function journalNameTaken(page) {
  await chooseGithubMode(page);
  await page.getByRole("button", { name: /^(create…|créer…)$/i }).click();
  await page.getByLabel(/^(repository name|nom du dépôt)/i).fill("prg1-journal");
  await page.getByRole("button", { name: /^(create the journal|créer le journal)$/i }).click();
  await page.waitForTimeout(500);
}

/** "Use a repository", its branch and folder disclosed, filled. */
async function journalUse(page) {
  await chooseGithubMode(page);
  await page.getByRole("button", { name: /^(choose…|choisir…)$/i }).click();
  await page.getByLabel(/^(repository name|nom du dépôt)/i).fill("prg1-2025-journal");
  await page.getByRole("button", { name: /^(branch and folder|branche et dossier)$/i }).click();
  await page.getByLabel(/^(folder|dossier)$/i).fill("docs");
}

/** The drill page's "Start": the first card of today's session on screen. */
async function drillStart(page) {
  await page.getByRole("button", { name: /^(start|commencer)$/i }).click();
  await page.waitForTimeout(800);
}

/** The first card answered (the mock's first question, its right choice), the verdict and the key on screen. */
async function drillAnswer(page) {
  await drillStart(page);
  await page.getByText(/^Une valeur indéterminée/).click();
  await page.getByRole("button", { name: /^(check|vérifier)$/i }).click();
  await page.waitForTimeout(800);
}

/** Every card of the session revealed in turn, to its summary. */
async function drillWalk(page) {
  await drillStart(page);
  for (;;) {
    await page.getByRole("button", { name: /^(show the answer|voir la réponse|check|vérifier)$/i }).click();
    await page.waitForTimeout(500);
    const finish = page.getByRole("button", { name: /^(finish|terminer)$/i });
    if (await finish.isVisible()) {
      await finish.click();
      break;
    }
    await page.getByRole("button", { name: /^(next|suivante)$/i }).click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(500);
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
    viewport: { width, height: heightOpt ?? (width < 700 ? 844 : 900) },
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
      // The coach's first-visit tour would sit over every screen: dismissed
      // here once, for every scene, as docs-screenshots.mjs does.
      await skipCoach(page);
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
