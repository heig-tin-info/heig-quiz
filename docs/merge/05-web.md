# 5. Web

## 5.1 Where each classroom screen lands

Quiz today — teacher: Courses, Activities, Pools, Polls, Admin, and a
classroom page with two tabs (roster, evaluations); student: home, take,
feedback, `/p/:code`, settings. **There is no student classroom page.**

| Classroom screen (`C:apps/web/src`) | Kind | Lands in Quiz |
| --- | --- | --- |
| `TeacherHome` classroom cards | merge | Courses home and sidebar |
| `NewClassroomDialog` (binds an org) | merge | the course's "New classroom" (no org; connect later) |
| `Timeline` | merge | `activities/Timeline.tsx` (already a port of it); projects become rows |
| Assignments tab (`AssignmentsCard`) | merge + new | the classroom's **Activities** tab (today "Evaluations", `EvaluationList`) over the `ActivitySummary` union |
| Journal tab, `JournalPage`/`Nav`/`Body`/`Editor` | new | `/classrooms/:id/journal/*`, both roles |
| Students tab (`RosterTable`, `RosterImport`) | merge | Roster tab (Quiz's files descend from these); a GitHub login column only when the classroom is connected |
| Staff tab | merge | course staff (`PeopleStack`) |
| Settings tab (rename, archive, delete) | merge | Quiz classroom header (rename in place, overflow menu) |
| `InstallWizard`, org badge | new | "Connect to GitHub" sheet, header badge |
| xlsx grade sheet | merge | teacher **Grades** tab / export (M5) |
| `AssignmentDetail` (57 kB) | new | `/projects/:id`, **redesigned in sections**, not copied |
| `AssignmentForm` (41 kB) | new | a sheet or a stepped page, **redesigned** (one primary action, novice/expert split, spec 08) |
| `GroupsPage` | new | `/projects/:id/groups` |
| `GradeHistoryModal`, `GradeOverrideModal` | new | inside the project page |
| Settings GitHub card | merge | Quiz `SettingsPage`, shown only when relevant |
| `GithubLinkToast` | merge | Quiz notify; return to the originating page, not `/` |
| `AdminPanel` (codespace, scheduled tasks) | merge | Quiz `AdminPanel` sections |
| `CommandPalette` / `commands`, `help/` | merge | Quiz registries |
| `StudentHome` | merge | Quiz `StudentHome`; classroom's global "link GitHub" banner is **dropped** |

## 5.2 The student classroom page

The home keeps "what do I do now"; the classroom page holds "everything
about this course".

- **Door** (D07): the classroom cards of the student home become pressable
  and open the classroom page. Suggested: always (Activities and Grades are
  useful without GitHub).
- **Route**: `/classrooms/:id` dispatches on the role — teachers get
  today's `ClassroomView`, students (and a teacher in student view,
  ADR-018) a new `StudentClassroom`. Tabs are routes, all `studentSafe`:
  `/classrooms/:id` (Activities, default), `/classrooms/:id/journal/<path>`
  (only when `hasJournal`), `/classrooms/:id/grades`.
- **Header**: eyebrow `ParentLink` to Home; title = classroom name;
  description = course code, name, period; teachers in `fg-faint`; the
  time-bonus badge as on the home card.
- **Activities**: Open now / Upcoming / Past, reusing `EvaluationRow`,
  `PollRow` and a new `ProjectRow`. **The one accent** is the button of the
  single most urgent open activity; the others are secondary. Empty state:
  nothing to do in this classroom right now. `ProjectRow`: title, deadline
  countdown, group name, status badge (not started / repo ready /
  invitation pending / submitted / graded), CI score as plain tabular text
  marked "indicative" until released.
- **Journal**: the ported reader under a compact header; at `lg`+ a 15-rem
  navigation column (current page = the accent, an `accent-soft` chip)
  beside the article (`.md-doc`); TOC under the navigation, or at the right
  from `xl`; on a phone the navigation is a disclosure above the page. **No
  primary action for a student.** Staff: Edit (primary), Refresh
  (secondary), draft and visible-from badges, warnings.
- **Grades**: a table — Activity (bold), Kind, Date, Points x/y (right,
  tabular), Swiss grade, status badge (released / pending / indicative); a
  row opens the feedback page or the project row. Data from
  `GET /app/api/student/results` (exists, unused by the web app today),
  filtered by classroom, plus project grades. No average until D06.

## 5.3 GitHub onboarding

**Student — lazy, per project, never a global banner.** The `ProjectRow`
button walks four states:

1. not linked ⇒ "Link my GitHub account" →
   `/app/auth/github/link?return=<current path>` → back with a toast
   (`?github=linked|conflict|error`);
2. linked, no repository ⇒ "Create my repository" (`provision_in_progress`
   handled; `github_account_stale` ⇒ "Relink GitHub");
3. invitation pending ⇒ a link to accept it on GitHub, one-line hint;
4. ready ⇒ "Open repository".

The Settings GitHub card appears only once the user has, or has had, a
project.

**Teacher — lazy, per classroom.** Triggered by "New project" or "Create a
journal" on an unconnected classroom:

1. the "Connect this classroom to GitHub" sheet: pick an org where the App
   is installed (`GET /app/api/github/orgs`) or install it
   (`installations/new?state=<classroomId>`; needs org-owner rights and "All
   repositories"); the status turns green by SSE; suggested default: the
   org of the course's other classrooms;
2. optionally link their own GitHub account (the expert clone-and-push
   path needs it; browser editing — the novice path — does not);
3. back to the task they started.

Teacher classroom tabs after the merge: **Roster** (primary: Add
students), **Activities** (primary: New ▾ — Evaluation, Poll, Project),
**Journal** ("Create a journal" when none; inside a page, Edit), **Grades**
(primary: Export).

## 5.4 UI library

- ADR-029 is superseded: no `@heig-platform/ui`. The sentence of
  `CLAUDE.md` sending new generic primitives there is changed (M0-05).
- Missing in Quiz, needed by the port: `GithubIcon` (lucide has no brand
  icons), `OrgAvatar`, `Progress`; possibly `RangeCalendar`,
  `localDateKey`, `localDateTimeInputValue`, `focusableIn`. Already in Quiz
  under the same name: `Segmented`, `buttonClass`, `inputSize`,
  `ButtonVariant`, `QueryError`, `cx`, `inputClass`; `Breadcrumb` ⇒
  `ParentLink`. **Port the screens onto Quiz's primitives** (`useLayer`,
  `Actions`, `pressable`), never the other way round.
- Tokens have drifted: classroom's `fg-faint` fails AA; radii 12/16/20/14
  vs Quiz's 10/12/16/12; no `info`. Ported markup uses tokens only, never
  hard-coded radii or colours.
- Classroom's `hgc-ui` skill and `DESIGN.md` are retired; its "Long-form
  reading" section moves into `apps/web/DESIGN.md`, restated in Quiz's
  radii.

## 5.5 i18n

- Same machinery on both sides (flat keys, `fr` typed
  `Record<keyof Dict, string>`). 256 classroom keys vs 2 544 Quiz keys; 75
  shared names, 12 with different English values (`app.title`,
  `landing.tagline`, `header.sources`, `view.cards`, `view.list`,
  `classrooms.title`, `settings.languageHint`, `settings.appearanceHint`,
  `settings.notificationsBrowser`, `settings.dateFormatHint`,
  `palette.placeholder`, `notify.student_joined`): Quiz's wins.
- Imported namespaces are prefixed: `project.*` (was `assignment.*`),
  `journal.*`, `github.*`.
- **The main cost**: classroom's teacher surfaces are literal English by
  its own decision (header of `C:apps/web/src/i18n.tsx`, 2026-07-13) —
  `JournalTab` has 5 `t()` calls in 671 lines; `AssignmentForm`,
  `AssignmentDetail` and the server 409 messages are literal or server-built.
  Porting a screen includes writing its en and fr keys.

## 5.6 Rules for every web task of the merge

- Mock handlers in `apps/web/src/mock/<module>.ts` and entries in
  `mock/contract.test.ts`; new flags (`?projects=1`, `?unlinked=1`,
  `?journal=1`) leave the defaults untouched.
- Screenshot scenes in `apps/web/scripts/screenshots.mjs` — 1440 and 390
  wide, light and dark, every layer opened, `?empty=1`, `?fail=1`,
  `?slow=1`, `?many=1`.
- Every string through `t()`, en and fr; one primary action per screen
  (`.claude/skills/quiz-ui/SKILL.md`, `apps/web/DESIGN.md`).
- **Non-regression**: the default student persona's `student-home` scenes
  stay identical (except the pressable card once D07 ships).
- `pnpm build && pnpm typecheck`, then `pnpm --filter @quiz/web test` (per
  package: the full suite exhausts the RAM).
