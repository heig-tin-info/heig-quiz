---
search:
  exclude: true
---

# heig-quiz simplification audit

> The report the simplification pull requests of October 2026 follow, translated from its French original.
> Its paths and line numbers refer to commit `b5e44c3`: relocate each claim before acting on it.
> Since resolved: C01 (`CLASSROOM_PAGES` is gone) and the `bumpVersion` exception (M4-11 is dropped, so the function was removed).

Base: commit `b5e44c3` (branch `claude/vigilant-cerf-qr16e0`, identical to `main`), 6 October 2026.
Analysis report only: no file in the repository was modified.

## 1. Summary

- The code is already little duplicated in the strict sense. jscpd finds only 0.2% exact clones in the web app and 68 duplicated lines in the whole API. The gains come from structural near-duplicates (same pattern, different names), types declared twice, props that repeat a default value, and copied enumeration lists.
- Removable production code: 2,200 to 2,700 net lines, i.e. 1.2 to 1.4% of the 188,000 lines of executable code. About 190 lines of tests and 150 lines of configuration come on top.
- The main deposit is documentation: 17,500 to 18,800 lines out of about 38,000 audited. ADRs go from 15,870 to 5,300-6,500 lines, and documentation outside the ADRs loses about 8,250 lines.
- No business module merge is justified by the measurements. On the other hand, the largest dependency cycle of the API went from 15 to 41 files since the audit of 3 October. Six targeted cuts make it disappear.
- 19 divergences between active ADRs and code, 22 stale documentation references, and 10 anomalies that are not about simplification but call for a decision (section 5).
- No retained finding is classified as high risk: the candidates that touched a trust boundary (confined sessions, student view, production refusals, runner hardening) were set aside.

## 2. Method

- Ten independent passes, one per axis: axis 1 split into API, web and packages, axis 6 into two batches of ADRs and one batch of documentation outside the ADRs. Each pass read the lines it cites. The high-gain findings were re-verified directly (`git grep` counts, reading the lines, scripts).
- Tools: knip 6 (unused files, exports and dependencies, tests counted as entry points), jscpd 4 (clones), madge and an import graph built with the TypeScript parser (cycles, fan-in, co-imports), a clone detector with normalized identifiers.
- The audit of 3 October (`docs/audits/2026-10-03-code-quality/`) is taken into account: its items are carried over only if they remain open, with their identifier ("audit 10-03 W2"). Closed since: PKG-08 and the reservation on `github/sync.ts` (M3-07 delivered, #517).
- Limits: shallow clone of 50 commits, no test run, gains estimated by static reading (lines removed minus lines added). Since the estimates of the passes tend to be optimistic, the totals are given as ranges.

Legend. Risk: low, medium, high. Effort: S (one narrow PR), M (one topic across several files), L (several PRs). Gain: net physical lines removed.

## 3. Mapping

### 3.1 Volumes

| Area | Files | TS/JS lines (tests included) | Role |
|---|---:|---:|---|
| apps/api | 672 | 135,153 | Fastify, 25 modules, Drizzle, pg-boss, ticker |
| apps/web | 691 | 156,816 | React SPA, including 14,877 lines of `mock/` mockup and 10,218 of dictionaries |
| apps/runner | 41 | 4,235 | hardened execution under Podman |
| packages/qt-* (9 types) | 367 | 46,034 | question types, including qt-circuit (16,672) and qt-code (13,005) |
| packages/domain | 147 | 18,080 | pure rules |
| packages/contracts | 52 | 10,740 | HTTP zod schemas |
| diagram, ui, core, docrender, registry | 114 | 12,045 | diagram engine, shared primitives, type contracts, journal rendering, wiring |
| docs/ (Markdown) | 353 | 34,398 | ADR 15,870, merge 7,106, guide 2,777, development 2,967, spec 2,126 |

### 3.2 Entry points

- API: `apps/api/src/server.ts` (migrations at startup, `buildApp`, `worker` mode without listening), `app.ts` (module registration), `seed.ts`, `scripts/import-classroom.ts`, `scripts/github-app.ts`.
- Web: `apps/web/src/main.tsx` (loads `mock/` if `VITE_MOCK=1`), `App.tsx`, `router.ts`.
- Runner: `apps/runner/src/server.ts`. Extension: `extensions/kiosk-attestation/service-worker.js`.
- Packages: `exports` field. Each question type exposes `./server`, `./client`, `./testing`, wired by `@quiz/registry`.
- CI: five workflows under `.github/workflows/`.

### 3.3 Dependency graph

Packages (acyclic graph):

```
core  <- domain <- contracts <- docrender
core  <- ui <- diagram
qt-*  -> core, ui, domain (qt-rich : core, ui ; qt-diagram : core, ui, diagram)
registry -> core + 9 qt-*
api   -> contracts, core, docrender, domain, qt-code, registry
web   -> tous les packages
runner -> core
```

API modules: 18 pairs in mutual dependency through value imports (auth and org, auth and live, evaluation and pool, evaluation and live, grading and results, org and project, notifications and github, etc.). Strongly connected components at file level: 41, 13, 6, 5 and 2 files, i.e. 67 files in a cycle against 41 on 3 October. The largest one absorbed the 21 files of `project/` with #510 (`org/service.ts:39` to `project/service`) and #512 (`project/notify.ts:51` to org). The dependency table of the spec (`docs/spec/05-architecture.md:53`, "org depends on auth") no longer reflects the code (`org/service.ts:37-39` imports evaluation, github and project).

### 3.4 Most imported modules and components (importers excluding tests)

| Module | Importers | | Package | Imports |
|---|---:|---|---|---:|
| `apps/web/src/i18n/index.tsx` | 288 | | `@quiz/contracts` | 431 |
| `apps/web/src/ui/index.tsx` | 259 | | `@quiz/domain` | 186 |
| `apps/web/src/api.ts` | 144 | | `@quiz/core/client` | 129 |
| `apps/api/src/db/schema.ts` | 143 | | `@quiz/core/server` | 77 |
| `apps/api/src/db/client.ts` | 123 | | `@quiz/ui` | 73 |
| `apps/web/src/queryKeys.ts` | 117 | | | |
| `apps/web/src/router.ts` | 86 | | | |
| `apps/api/src/config.ts` | 75 | | | |
| `apps/web/src/notify.tsx` | 73 | | | |
| `apps/api/src/audit.ts` | 57 | | | |
| `apps/api/src/modules/http.ts` | 50 | | | |
| `apps/api/src/modules/guards.ts` | 46 | | | |

Most imported UI primitives (single-line imports, hence a lower bound): `cx` 83, `Button` 62, `Card` 41, `Badge` 31, `Skeleton` 26, `Alert` 25, `IconButton` 21, `EmptyState` 18. API modules with the highest fan-in: guards (24 modules), realtime (18), http (18), pool (17), live (16).

## 4. Global ranking by gain/risk ratio

Weighting: low risk = 1, medium = 3. Documentation findings dominate in volume. The table is followed by a ranking specific to code.

### 4.1 All findings together (top 30)

| Rank | ID | Axis | Finding | Gain | Risk | Effort |
|---:|---|---|---|---:|---|---|
| 1 | X01 | 6 | Task cards delivered in `09-tasks.md` | 3,970 | low | M |
| 2 | A01 | 6 | `docs/adr/history/` snapshots and anchor lists | 2,460 | low | S |
| 3 | X02 | 6 | `PLAN-MVP.md` reduced to a pointer and its D1-D20 table | 2,070 | low | S |
| 4 | A07 | 6 | Condensing the remaining ADRs to the short template | 6,000 to 7,000 | medium | L |
| 5 | X03 | 6 | Removal of the 3 October audit, replaced by this plan | 1,030 | low | S |
| 6 | D01 | 1 | String interfaces declared twice (qt-circuit, qt-code) | 489 | low | M |
| 7 | A03-A05 | 6 | ADR-029 as a pointer, ADR-040 circuit into ADR-019, removal of the ADR audit, hardened template | 400 | low | S |
| 8 | X04 | 6 | Delivered merge strategies and `08-decisions.md` | 840 | medium | M |
| 9 | A02 | 6 | Four ADRs folded into their successor (045, 048, 049, 072) | 620 | medium | M |
| 10 | D02 | 1 | `error/onRetry/retrying` triplet repeated 74 times | 138 | low | S |
| 11 | C01 | 4 | Dead route flag `CLASSROOM_PAGES` | 43 (+70 tests) | low | S |
| 12 | X05, X07, X09 | 6 | PROGRESS, copied rules, history prose in DESIGN.md | 300 | low | S-M |
| 13 | D03 | 1 | Props that repeat the default value (88 sites) | 88 | low | S |
| 14 | S01 | 2 | Enumerations written two or three times | 80 | low | M |
| 15 | M04 | 5 | Production code alive only through its tests | 60 | low | S-M |
| 16 | D05 | 1 | Key, URL and type queries redeclared (26 to 38 sites) | 58 | low | M |
| 17 | D07 | 1 | Cards/list selector built four times | 50 | low | S |
| 18 | D12 | 1 | Contract props redeclared by each type | 48 | low | S |
| 19 | D06 | 1 | Evaluation row menu written twice | 45 | low | S |
| 20 | D11 | 1 | Zero-point results written eleven times | 45 | low | S |
| 21 | D04 | 1 | 40 single-use refusal classes in the API | 150 | medium | M |
| 22 | M07 | 5 | Test tooling consolidated at the root | 120 to 150 | medium | S-M |
| 23 | D09 | 1 | GitHub "404 = absent" try/catch repeated twelve times | 40 | low | S |
| 24 | D14 | 1 | SVG icons outside `StrokeIcon` | 40 | low | S |
| 25 | D15 | 1 | "Door" card of the pages outside the application | 40 | low | S-M |
| 26 | D10 | 1 | A* router duplicated between diagram and qt-circuit | 120 | medium | M |
| 27 | R02 | 3 | `navigate` passed as a prop in 60 files | 90 to 110 | medium | L |
| 28 | R01 | 3 | Two twin `Player` hosts, already diverging | 85 | medium | M |
| 29 | M01 | 5 | Declarations referenced nowhere | 22 | low | S |
| 30 | D08 | 1 | Eleven "load or 404" loaders in `guards.ts` | 50 | medium | S |

The other findings follow in section 6, sorted by axis then by gain/risk.

### 4.2 Code only (production)

D01 (489), D02 (138), D03 (88), S01 (80), M04 (60), D05 (58), D07 (50), D12 (48), D06 (45), D11 (45), C01 (43), D09 (40), D14 (40), D15 (40), then at medium risk D04 (150), M07 (120-150), D10 (120), R02 (90-110), R01 (85), D08 (50).

## 5. Anomalies outside simplification (decision or fix required)

These points surfaced during the audit. They must not be "fixed in passing" in a simplification batch.

1. ADR-003 §5 is not in force. The immutability of `audit_log` through SQL roles does not exist: no `GRANT` or `REVOKE` in `apps/api/drizzle/*.sql`, the application connects with the owner role (`compose.prod.yml:23, 50`). `users.anonymized_at` is read (`auth/adoption.ts:52`, `auth/tokens.ts:133`) but never written, whereas `db/live.ts:80-82` presents anonymization as the way an account leaves. Security requirement (NFR-05, NFR-07) to schedule or to withdraw explicitly.
2. Wrong data protection page: `docs/guide/data-protection.md:138-148` states that the journal and GitHub do not work yet ("None of it runs today"), whereas `modules/journal`, `modules/github` and `modules/project` are delivered. The public page misdescribes the processing.
3. Maximum duration of an evaluation: the interface caps at 480 minutes (`apps/web/src/evaluation/TimingStep.tsx:266-267`), the contract at 24 h (`packages/contracts/src/evaluation.ts:519`). No source in the spec for 8 h.
4. Recent polls selection: `poll/service.ts:978` filters `["mcq", "short"]` whereas `POLLABLE_TYPES` (`:101`) includes `brainstorm`. Intended exclusion or oversight (audit 10-03 A5c)?
5. Template revision probably incremented wrongly: a neutral patch such as `{settings: {kiosk: false}}` on a template that never set `kiosk` changes the `isDeepStrictEqual` comparison of `evaluation/templates.ts:294`, hence increments the revision. Deduced by reading and by a zod probe, not yet proven by a test (see C02).
6. ADR-058 §2 promises that a single model serves all uses, but the screen writes only `models.default` (`llm/service.ts:141`) and `PURPOSE_MODELS` fixes Haiku for polls (`packages/domain/src/llm.ts:75`): the administrator's choice does not reach the `poll` use.
7. `AGENTS.md:44-47` prescribes `pnpm test` (parallel) before pushing to `main`, which §2 forbids, and contradicts the memory guard of §7 (`--workspace-concurrency=1`). Same command in `.claude/skills/feature/SKILL.md:59`.
8. Accessibility: five hand-written table headers without `scope="col"` (see R08). The diagram toolbar uses `role="tablist"` without arrows or `tabpanel` (`packages/diagram/src/editor/Toolbar.tsx:71-84`).
9. Stale code comments: `apps/api/src/config.ts:203-209, 219-220` state that grading is not wired to the LLM, whereas `modules/llm/index.ts:33-40` returns the gateway's grader. `apps/web/src/activities/Timeline.tsx:22-23` points to ADR-029, abandoned.
10. Fixes from the 3 October audit still open: W1 (`apps/web/src/ui/menu.tsx:238`, `e.target as Node`), W3 (storage refused in `studentView.ts`), W4 (screenshot failures).

## 6. Detailed findings

### 6.1 Axis 1: redundancies (DRY)

D01. String interfaces doubled by their default values object
- Location: `packages/qt-circuit/src/strings.ts:51-158` and `160-274` (and three other pairs), `qt-circuit/src/canvas/canvasStrings.ts:16-76` and `78-134`, `packages/qt-code/src/strings.ts:15-94` and `96-180` (and three pairs), `qt-code/src/image/strings.ts:26-49` and `51-77` (and three pairs).
- Evidence: 451 `key: string;` lines in interfaces followed by an object that restates each key (`export interface CircuitEditorStrings { questionSection: string; …` then `export const EDITOR_STRINGS: CircuitEditorStrings = { questionSection: "Question", …`). The seven other types and diagram declare each key only once (`diagram/src/editor/strings.ts:124`, `type DiagramStrings = { readonly [K in keyof typeof diagramStrings]: string }`). Convention drift, not a design choice.
- Simplification: remove the annotation from the objects and write `export type CircuitEditorStrings = typeof EDITOR_STRINGS;` (13 aliases). Move the 22 documentation comments onto the members. Type the two canvas functions (`kind`, `port`).
- Gain: -489 lines. Risk: low (types only, the compiler checks the web dictionaries). Effort: M, mechanical.

D02. Retry triplet repeated on `QueryError` and `PageError`
- Location: 74 sites in 61 files, for example `apps/web/src/TeacherHome.tsx:166-168`, `ClassroomView.tsx:280-282`, `journal/JournalHistory.tsx:103-105`.
- Evidence: `error={courses.error}`, `onRetry={() => void courses.refetch()}`, `retrying={courses.isFetching}` at each site (78 occurrences of `onRetry={() => void` outside tests). Only the variable changes, with the risk of pairing the wrong query.
- Simplification: alternative prop `query={courses}` in `queryError.tsx` (type union, the explicit form remains for mutations).
- Gain: -138. Risk: low. Effort: S-M.

D03. Props that repeat the component's default value
- Location: `fallback={t("error.server")}` on 52 sites (for example `pool/CategoriesPage.tsx:227`), `cancelLabel: t("common.cancel")` on 36 sites (for example `activities/actions.tsx:53`).
- Evidence: `queryError.tsx:54` already applies `fallback ?? t("error.server")`, `confirm.tsx:80` already `cancelLabel ?? t("common.cancel")`.
- Simplification: delete these props. To be delivered with D02 (49 sites carry both).
- Gain: -88. Risk: low (identical values). Effort: S.

D04. Forty single-use refusal classes in the API
- Location: `modules/evaluation/shared.ts:75-235` (15 classes), `evaluation/templates.ts:62-66, 356-369`, `live/attempt.ts:124-261` (10), `poll/service.ts:106-126, 387-391, 692-703`, `results/service.ts:127-154`, `grading/service.ts:105-115, 959-963`, `drill/review.ts:94-98`.
- Evidence: each class is the same five-line scaffold around a code, a status and a message (`class EvaluationNotLive extends LiveError { constructor() { super("evaluation_not_live", 409, …`). No `instanceof` or test reference on these 40 classes (verified by script: only `AttemptClosedError`, `AnswerInvalid`, `RateLimited`, `RetakeRefused` and `RunnerDown` are inspected by type, and remain classes). Four modules already use a single class and a status table (`project/errors.ts:15-72`, journal, group, gradebook).
- Simplification: a `code -> [status, message]` table per module, constructor `(code, message?, details?)`, like `ProjectError`. A `notFoundError(what)` factory in `http.ts` for the four local `new DomainError("not_found", 404, …)`.
- Gain: -150. Risk: medium (60 throw sites, messages to carry over word for word since they go out in the response). Effort: M.

D05. Same read declared at each site (key, URL, type)
- Location: `classroomKey` on 7 sites (`ClassroomView.tsx:205`, `evaluation/EvaluationList.tsx:87, 201`, `EvaluationConfig.tsx:104`, `group/GroupSetPage.tsx:106`, `project/ProjectPage.tsx:104`, `project/NewProjectPage.tsx:88`), `evaluationKey` on 6, `poolKey` on 5, `poolsKey` on 5, `coursesKey` on 3 whereas `course/parts.tsx:27` already provides `useCourses`, plus four pairs.
- Evidence: `course/parts.tsx:23-25`: "The key and the URL in one place, for the pages that read the list", bypassed by `Shell.tsx:224, 492` and `poll/PollLauncher.tsx:198`. `JournalReader.tsx:138` re-reads the key of `journal/api.ts:44` with a different generic type.
- Simplification: `queryOptions` factories (TanStack v5) or a hook per resource in each domain's `api.ts`, with `enabled` and `retry` options. Student reads kept separate (invariants 4 and 6).
- Gain: -55 to -60. Risk: low (keys unchanged, `queryKeys.test.ts` freezes them). Effort: M.

D06. Navigation menu of an evaluation row written twice
- Location: `apps/web/src/evaluation/EvaluationList.tsx:337-381` and `activities/actions.tsx:115-167`.
- Evidence: same sequence, same icons, same i18n keys (projection for a poll, then grading and results if `isGraded`, dashboard, configuration). Five `mode === "poll"` tests interleaved in the first copy. `evaluation/common.ts:76` already shares the row click, not the menu.
- Simplification: `evaluationLinkItems(row, t, navigate)` in `evaluation/common.ts`. Activities adds "Terminer", the list adds duplicate, template and delete.
- Gain: -45. Risk: low (same order today). Effort: S.

D07. Cards/list selector built four times
- Location: `TeacherHome.tsx:97-110, 146-154`, `pool/PoolsPage.tsx:532-541, 562-570`, `pool/FilterBar.tsx:70-82, 114-123`, `activities/ActivitiesPage.tsx:136-144, 257-266`.
- Evidence: same local `viewOption` function (verified at the four locations), same `Segmented`.
- Simplification: `ViewSwitch` in `ui/controls.tsx`, literal i18n keys to keep the unused-keys test.
- Gain: -50. Risk: low (identical DOM). Effort: S.

D08. Eleven "load or 404" loaders in `guards.ts`
- Location: `apps/api/src/modules/guards.ts:466-473` (`accessibleClassroom`), `495-503`, `524-532`, `569-577`, `657-664`, `695-703`, `737-744`, `909-916`, `961-968`, `1037-1044`, `1184-1191`.
- Evidence: identical body `(await findX(app.db, callerOf(req), params.id)) ?? notFound(reply)`, preceded in four cases by `if (!ownPortalSession(req.auth)) return notFound(reply);`.
- Simplification: a nine-line `routeLoader(find, { portalOnly })` factory. The access predicate stays in `find*` (invariant 6 intact).
- Gain: -50. Risk: medium (security file, order of the session check to preserve). Effort: S.

D09. "A 404 means absent" try/catch repeated twelve times
- Location: `github/app.ts:324-333, 348-357, 388-400`, `github/commit.ts:36-48`, `github/collaborators.ts:19-28`, `github/revert.ts:44-57`, `project/sources.ts:60-69`, `project/access.ts:378-384`, `project/sync.ts:235-246, 342-353`, `journal/writes.ts:390-400`, `journal/repo.ts:247-253`.
- Evidence: same ending `catch (err) { if (githubStatus(err) === 404) return null; throw err; }` (14 occurrences of `githubStatus(err) === 404`). Two sites rewrite the test by hand.
- Simplification: `unless404(call)` in `github/app.ts`, next to `githubStatus`.
- Gain: -40. Risk: low. Effort: S.

D10. A* core duplicated between the diagram and the circuit (extends audit 10-03 PKG-02)
- Location: `packages/diagram/src/layout.ts:176-315` (heap, `astar`, `simplify`, `markUsed`) and `packages/qt-circuit/src/canvas/router.ts:31-322`.
- Evidence: same `const TURN = 4`, same arrival penalty (`TURN * 3`), same overlap cost 2.5, same indexing, identical `simplify` and `markUsed`. Only the search parameters differ (margins, bounded window).
- Simplification: a common `astar(…, { margins, clip? })` module. `blockedCells` stays per package (different semantics). Hosting to be decided (`@quiz/domain` or a subpath of `@quiz/core`).
- Gain: -120. Risk: medium (routes must stay bit-for-bit identical, covered by the golden tests). Effort: M.

D11. "Zero point" result written eleven times
- Location: `qt-code/src/grade.ts:106-112, 123-130, 140-147, 254-260`, `qt-code/src/image/grade.ts:132-147`, `qt-circuit/src/grade.ts:409-415, 423-430, 437-443, 461-468, 531-537, 588-594`.
- Evidence: `kind: "graded", points: 0, maxPoints: ctx.itemPoints, …`. The block 409-415 is repeated identically at 531-537.
- Simplification: `zeroGrade(ctx, details, state?, comment?)` in `core/src/contract.ts`.
- Gain: -45. Risk: low. Effort: S.

D12. Contract props redeclared by each question type
- Location: `core/src/client.ts:16, 181, 236`, `Omit<EditorProps, "uploadAsset"> & { uploadAsset? }` in six editors, `issues?` in nine, `renderMarkdown?` in 26 props types, `qt-mcq/src/Editor.tsx:90-98` redeclares `renderHelp?` and `aside?`.
- Evidence: the host already treats these props as optional and redoes the contract by casting (`apps/web/src/questionTypes.tsx:569-591, 661`).
- Simplification: make `uploadAsset` optional, add `issues?` and `renderMarkdown?` to the core props, delete the redeclarations.
- Gain: -48. Risk: low. Effort: S-M.

D13. `JSON.stringify` of the request body at 117 sites
- Location: 117 `body: JSON.stringify(` outside tests and mockup, local wrappers `kiosk/station.ts:23-24`, `attempt/run.ts:82-83`, `drill/api.ts:35-38`, `gradebook/api.ts:73`.
- Evidence: `api.ts:48-67` already encodes Blob, FormData and CSV. Only JSON is left to the caller.
- Simplification: `json` option in `api()`.
- Gain: -55 to -75, depends on formatting. Risk: low. Effort: M, prone to conflicts. To be placed after the structural gains.

D14. Icons drawn outside `StrokeIcon`
- Location: `qt-mcq/src/ui.tsx:212-252` (Trash and Plus in raw SVG), `qt-code/src/LockIcon.tsx:9-25`, `qt-categorize/src/ui.tsx:44-60`, `qt-code/src/icons.tsx:43-57`, `qt-brainstorm/src/Player.tsx:95-97`, target wrapper `packages/ui/src/icon.tsx:13-40`.
- Evidence: the path `M12 5v14M5 12h14` exists three times with three stroke widths. `ui/src/icon.tsx:55` has already brought `GripIcon` back because "two copies of it had already drifted by a stroke width".
- Simplification: `PlusIcon`, `TrashIcon`, `CloseIcon` in `packages/ui`. Deletion of `LockIcon.tsx`.
- Gain: -40, one file. Risk: low (stroke difference below a pixel). Effort: S.

D15. "Door" card of the pages outside the application
- Location: `notifications/TeamsTabPage.tsx:163-194` (local `Frame`, `Loading`), manual copies in `oauth/OAuthConsent.tsx:27-106`, `notifications/TeamsLinkPage.tsx:46-122`, `pair/PairPage.tsx:249-264`, `SignInGate.tsx:36-62`.
- Evidence: `<GateFrame><Card className="px-6 py-8 text-center">{icon}<h1 className="mt-3 text-lg …">` repeated, skeleton trio repeated three times.
- Simplification: `GateCard` and `GateSkeleton` in `ui/page.tsx`.
- Gain: -35 to -45. Risk: low (slight visual normalization, to check in screenshots). Effort: S-M.

D16. Copied real-time emitters, one of them dead
- Location: `evaluation/events.ts:19-31` (`stateChanged`, no caller), `live/events.ts:17-26` and `poll/events.ts:24-33` (identical bodies), `live/events.ts:28-45` and `86-100`, audience pattern repeated in `group/events.ts:15`, `gradebook/events.ts:14`, `project/events.ts:29`.
- Simplification: delete the dead emitter, `evaluationStateChanged` in `bus.ts`, `attemptStarted` delegates to `deadlineChanged`, `staffAndStudentsHint` encodes rule N-SEC-20 once.
- Gain: -30. Risk: low. Effort: S.

D17. Local error handlers that return what the common handler sends
- Location: `live/routes.ts:70-93`, `poll/routes.ts:76-82`, `pool/questionRoutes.ts:162-169`, `pool/reviewRoutes.ts:59-66, 105-108`, `pool/routeContext.ts:64-67`.
- Evidence: `{ error: error.code, reason: error.reason, message: error.message }` is exactly the output of `http.ts:108` if the reason goes into `details`.
- Simplification: pass `{ reason }` as details, reuse the live handlers in poll, centralize the LLM mapping in `poolFailure`.
- Gain: -30. Risk: low (only the order of JSON keys changes). Effort: S.

D18. Contracts that repeat groups of fields
- Location: staff item reference `grading.ts:94-99`, `results.ts:56-61`, `live.ts:594-602, 690-698`, person reference `pool.ts:131-135, 155-160`, `org.ts:158-163`, `realtime.ts:196-212` takes up seven fields of `core/src/runner.ts:48-61`, `grading.ts:309` equals `common.ts:10`.
- Simplification: `StaffItemRef`, `PersonRef` in `common.ts` with `.extend`, reuse of the runner schema, alias of `IdParam`.
- Gain: -29. Risk: low. Effort: S.

D19. Scaffolding of the type reviews (extends audit 10-03 PKG-09)
- Location: results table headers `qt-code/src/Player.tsx:393-411`, `qt-code/src/Review.tsx:133-154`, `qt-circuit/src/Review.tsx:262-280` (16 `<th scope="col" …>`), statement block on nine reviews, identical no-detail fallback in `qt-code/src/Review.tsx:106-113` and `image/Review.tsx:81-88`.
- Simplification: `TableHead` and `ReviewPrompt` in `@quiz/ui`, fallback in `ProgramReview.tsx`.
- Gain: -45. Risk: medium (DOM to keep identical, `p` or `div` depending on the type). Effort: M.

D20. Small web duplicates (batch)
- `ApiError` predicates rewritten: `isNotFound` copied three times word for word (`journal/JournalReader.tsx:105`, `student/StudentProjectPage.tsx:75`, `student/StudentClassroom.tsx:111`), `(error.body as { error?: string } | null)?.error` eight times whereas `api.ts:39-46` provides `refusalCodeOf`. Gain -12 to -18.
- Subscribable store copied four times (`theme.ts:33-43` and `studentView.ts:34-44` identical, `shortcuts.tsx`, `realtime/connection.ts`): `createSignal()` in `ui/state.ts`. Gain -15 to -20, to be done with audit 10-03 W3.
- Floating panel style copied three times (`ui/menu.tsx:383-396`, `ui/popover.tsx:258-270`, `notifications/NotificationPanel.tsx:384-392`): `panelStyle(pos, align)`, with audit 10-03 W2. Gain -15 to -22.
- `pressable()` always accompanied by the same `onClick` (12 sites): `pressable` also returns `onClick`. Gain -10.
- Case-insensitive comparator written four times (`AdminPanel.tsx:132-135`, `drill/DrillActivityTable.tsx:83-86`, `RosterTable.tsx:361-364`, `AdminUsers.tsx:90-93`): `caseInsensitiveCompare` in `ui/table.tsx`. Gain -8.
- m:ss countdown redone (`SuperPowers.tsx:39-43`, `kiosk/KioskPage.tsx:52-53`) instead of `formatRemaining`. Poll-end confirmation options copied "word for word" (`activities/actions.tsx:50-55`, `poll/PollProjection.tsx:249-254`). Gain -10.
- Batch total: -70 to -90. Risk: low. Effort: S.

D21. Small API duplicates (low-risk batch)
- `qualified` defined twice with an identical body (`modules/guards.ts:77-87`, `pool/shared.ts:109-125`) and LIKE escaping written twice (`pool/members.ts:141`, `pool/questionList.ts:146`): move to `db/client.ts`. Gain -13.
- Four boolean environment flags parsed by hand (`config.ts:24-27, 103-106, 128-131, 164-167`): `flag()` factory. Gain -10.
- 429 responses with `retry-after` on ten sites and CSV downloads on two: `rateLimited()` and `sendCsv()` in `http.ts`. Gain -15.
- Six loaders with a bare identifier force three adaptation idioms (constants, `.bind`, lambdas): single `params` signature. Gain -15.
- `lockClassroom` identical in `group/service.ts:229-233` and `gradebook/writes.ts:62-66`, project lock repeated three times, `escapeHtml` copied in `auth/dev.ts:94-96`. Gain -15.
- "Claimed student seat of this classroom" condition written on about twenty sites (`eq(enrollments.staff, false)`: 24 occurrences): `studentSeats()` in `db/org.ts`. Gain -12, above all a single rule.
- Twin `withCourseRole` and `withRole` (`guards.ts:232-247`, `pool/routeContext.ts:95-110`), GitHub rule set found or created twice (`github/lock.ts`, `github/provision.ts`). Gain -16.
- Total: -95 to -100. Risk: low. Effort: S.

D22. Medium-risk API duplicates (separate batch)
- Pool route parameters parsed in the handler (`pool/memberRoutes.ts:105-184`, `pool/questionRoutes.ts:227-263`): a malformed parameter from a caller without a role would answer 404 instead of 403. Gain -16.
- Public poll routes that rewrite the common envelope three times (`poll/routes.ts:503-578`): only unauthenticated write surface, CSRF then parameters order to keep. Gain -20.
- Session and CSRF cookie pair set in two places (`auth/plugin.ts:200-210, 237-249`, overlaps audit 10-03 A4a). Gain -8.
- Total: -44. Risk: medium. Effort: S.

D23. Test and tooling duplicates
- Test grading context and `noRunner` stub copied in six packages (`qt-short/src/test/fixtures.ts:5-23` and five others): `testGradeContext()` in `@quiz/core/testing`, already imported by the nine packages. Gain -90 test lines.
- Test RC schema built twice (`qt-circuit/src/testing.ts:102-134`, `test/fixtures.ts:63-101`). Gain -28 test lines.
- Batch loops of the import script (`scripts/import-classroom/steps-audit.ts:14-35`, `steps-webhooks.ts:21-59` and seven reads): existing `insertAll` and `inChunks`. Gain -17 tooling lines.
- Risk: low. Effort: S.

D24. Small package duplicates
- Canvas style tokens identical between `diagram/src/editor/styles.ts` and `qt-circuit/src/canvas/canvasStyles.ts` (nine strings): -14.
- `newId` identical in `diagram/src/scene.ts:195-203` and `qt-categorize/src/schema.ts:191-200`: -8.
- HTML entity decoding duplicated between `docrender/src/render.ts:131-157` and `apps/web/src/markdown/render.ts:153-163`, `escapeHtml` between `docrender/src/highlight.ts:60-71` and `notifications/templates.ts:350-358`: -17.
- Total: -39. Risk: low. Effort: S.

D25. Reminders from the 3 October audit still open: A5a (free name in `pool/questionWrite.ts:272-289` and `797-814`, -12 to -22), W2 (panel bounding, -20 to -35), W10 (palette shortcut, -8 to -15), PKG-03, PKG-04 conditional.

### 6.2 Axis 2: single source of truth

S01. Enumerations written two or three times on a premise that has become false
- Location: about 27 lists written about 70 times across `packages/contracts`, `packages/domain` and the Drizzle schema. Examples: evaluation state `contracts/evaluation.ts:22-31`, `domain/itemList.ts:35-55`, `db/evaluation.ts:78-89`, MCQ policy `contracts/evaluation.ts:64-70`, `domain/mcqScore.ts:82-88`, `db/auth.ts:59-61`, course role `contracts/org.ts:140`, `domain/courseRole.ts:11`, `db/org.ts:56`.
- Evidence: `contracts/evaluation.ts:52-55` justifies the copy ("spelled again because `packages/contracts` depends on no package"), whereas `contracts/package.json:19` depends on `@quiz/domain` and `evaluation.ts:12` already imports from it. The compile-time concordance proofs (`pool/routes.ts:48-70`, `evaluation/shared.ts:14-20`) exist only to compensate for the copy.
- Simplification: `domain` carries each list `as const`. Contracts writes `z.enum(X)`. Drizzle `{ enum: X }`. Removal of the concordance shims and of the false comments.
- Gain: about -80. Risk: low (type level, no CHECK constraint generated, hence no migration). Effort: M, one module per PR.

S02. State groups copied although the domain owns them
- Location: 17 copies, for example `apps/web/src/evaluation/LaunchStep.tsx:72-73`, `live/attempt.ts:922, 1140-1141`, `system/health.ts:229`, `evaluation/writes.ts:554`, SQL in `stats/service.ts:86`, `drill/lifecycle.ts:237`.
- Evidence: `domain/itemList.ts:57-58` ("one rule, so a button never leads to a refusal") whereas `LaunchStep.tsx:72` rewrites `state === "lobby" || state === "running" || …`.
- Simplification: `OVER_STATES`, `FINISHED_ATTEMPT_STATES` in the domain, `inArray` on the SQL side.
- Gain: -5, above all 17 fewer copies of a rule. Risk: low. Effort: S.

S03. Role rules reimplemented in the web app
- Location: "pool writer" written `role !== "reader"` on eight sites (`question/useQuestionDraft.ts:58`, `pool/PoolView.tsx:213, 364`…), last-owner rule `course/useCourseActions.tsx:150, 160` against `domain/courseRole.ts:47-54`.
- Simplification: `poolRoleAllows`, `staffChangeRefusal` from the domain. Gain: 0 lines, 10 fewer copies of a rule. Risk: low. Effort: S.

S04. Hand-written types in `poll/pollTally.ts:26-47`
- Evidence: the file already imports `@quiz/qt-mcq/client`, which exports `McqStudent` and `McqSolution`. Same for qt-short.
- Gain: -18. Risk: low. Effort: S.

S05. Contract enumerations written inline (about 32 sites) and API types copied from the contracts
- Location: `src/events.ts:31-45` lists by hand the 14 hint types of `contracts/realtime.ts:238-262` (the web already derives them, `realtime/hints.ts:17`), `system/health.ts:527-536` and `runner/index.ts:22` retype `HealthResponse`, `grading/service.ts:136, 833`, `grading/jobs.ts:540-544` write `"low" | "medium" | "high"`, `closedBy`, `preset`, sent invitation status, poll state rewritten.
- Simplification: derive (`HintEvent["kinds"][number]`, `Pick<HealthResponse…>`), add `EvaluationClosedBy`, `EvaluationPreset`, `SentInvitation`.
- Gain: -20. Risk: low. Effort: S-M.

S06. Locale `"en" | "fr"` written eleven times (`db/auth.ts:51`, `contracts/api.ts:59, 141`, `domain/groupSets.ts:385`, `notifications/templates.ts:23`, `i18n/index.tsx:43`, `ui/dates.tsx:64, 77`…): `LOCALES` in the domain. Gain 0, a single list to extend. Risk low. Effort S.

S07. Execution result union `RunnerOutcome | "unavailable" | "rate_limited"` written fourteen times (three named aliases and eleven inline): `RunOutcome` in `@quiz/core`. Gain 0. Risk low. Effort S.

S08. Form limits retyped from the contracts (about 25 literals)
- Location: `RetakesSetting.tsx:83-84`, `ApiTokensCard.tsx:137`, `RosterImport.tsx:226-227`, `GroupSetPage.tsx:475-476`, `TagInput.tsx:299`, difficulty 1 to 5 on eight sites, `mcp/tools.ts:91-92` (audit 10-03 A5b, open).
- Evidence: the pattern already exists (`maxLength={KIOSK_LABEL_MAX}`, `AdminKiosk.tsx:265`). Reveals the duration gap of anomaly 3.
- Gain: +10 lines, 25 literals tied to an owner. Risk low. Effort S-M.

S09. Duplicated constants: OAuth prefix `"quiz_oat_"` (`auth/oauth/service.ts:29`, `auth/tokens.ts:42`, verified), names of the CSRF cookie and header between `auth/session.ts:19-20` and `web/api.ts:16-17`, `HEADER_MAX = 30` (`results/csv.ts:13`, `gradebook/csv.ts:21`), list of token durations (`contracts/tokens.ts:14, 20`), `MAX_CASES` (audit 10-03 PKG-05, open). Gain -5, silent drift avoided (a diverging prefix would make the MCP's OAuth tokens be refused). Risk low. Effort S.

S10. Derivable web unions (`attempt/autosave.ts:42-43` with a stale comment, `ui/live.tsx:278, 851`), SPA paths and `"solution"` key suffix built outside `router.ts` and `queryKeys.ts` (`PollJoin.tsx:384`, `ItemPreviewSheet.tsx:68`, `previewQuery.ts:29`, `VariablesSection.tsx:511`). Gain 0. Risk low. Effort S. The kiosk and pairing paths may be intended reloads.

### 6.3 Axis 3: React components

R01. Two `Player` hosts, whose drift is already visible
- Location: `apps/web/src/questionTypes.tsx:693-777` (`QuestionPlayerHost`, called by `question/TryPanel.tsx:108` and `grading/AnswerPanel.tsx:201`) and `student/QuestionHost.tsx:36-162` (four callers), `emptyAnswerOf` duplicated (`questionTypes.tsx:847-851`, `QuestionHost.tsx:80-90`).
- Evidence: different inline text rendering (`questionTypes.tsx:604`: `<MarkdownView as="span" size="sm" …/>`, `QuestionHost.tsx:54`: `<MarkdownView source={source} inline />`), different fallbacks. `TryPanel.tsx:30` promises "what a student will get, not a second rendering".
- Simplification: `QuestionHost` as the single host, `testsPrimary` prop. Removal of `QuestionPlayerHost`, of `PlayerHostProps` and of the duplicate `emptyAnswerOf`. Absorbs the special case of the unknown type handled in two ways.
- Gain: -85 to -100, one component. Risk: medium (typography of the Try tab and of the grading panel. Plan a `size` prop if the small body was intended). Effort: M, to coordinate with audit 10-03 W5.

R02. `navigate` passed as a prop through about sixty files
- Location: `router.ts:710-756` (`useRoute` returns a stable `navigate`), 84 `navigate={navigate}` passes outside tests, about 102 prop declarations, chains of four to five levels (`StudentHome.tsx:136` down to `ProjectRow` via `cards.tsx`).
- Simplification: `NavigateProvider` in `App.tsx`, `useNavigate()` in `router.ts`, gradual removal of the prop (fallback to the context during the transition).
- Gain: -90 to -110 in production. Risk: medium (390 sites in 51 test files to migrate to an option of `renderWithProviders`). Effort: L, incremental.

R03. `NotePanel` reimplemented in two reviews
- Location: `apps/web/src/ui/page.tsx:83-113`, `packages/qt-rich/src/Review.tsx:25-50`, `packages/qt-diagram/src/Review.tsx:33-44` (documented as "the `rich` review's").
- Evidence: same tones, same overline. The diagram copy has already drifted (`mt-2` instead of the rhythm of `DESIGN.md:529-536`).
- Simplification: `NotePanel` in `packages/ui`, re-exported by `apps/web/src/ui`. Gain: -30, two components. Risk: low. Effort: S.

R04. `SettingNumber` (`qt-code/src/ProgramEditor.tsx:378-418`, four uses) reimplements `NumberField` (`packages/ui/src/fields.tsx:143-205`). Gain -35, one component. Risk low (right alignment, behavior of 0 to keep if intended). Effort S.

R05. Twin drop zone and focus after render between `group/GroupBoard.tsx:85-95, 322-375` and `packages/qt-categorize/src/Board.tsx:127-137, 290-355` (same pattern in `qt-mcq/src/Editor.tsx:220-225`): `DropZone` without dnd-kit dependency and `useFocusAfterRender` in `packages/ui`. Gain -35 to -40, one component. Risk medium (drag-and-drop and keyboard). Effort M.

R06. `t` passed as a prop to the three hosts and to `CommandPalette` whereas each caller gets it through `useT()` (`questionTypes.tsx:613-627, 712-725, 795-807`, `CommandPalette.tsx:47`, 14 `t={t}` sites): call `useT()` in the component. Gain -18. Risk low. Effort S.

R07. Useless leftovers in the UI layer: `SortHeader` exported with no external consumer (`ui/table.tsx:104`), re-export of `textareaClass` (`ui/controls.tsx:101`), `useId()` without a reader in `SettingRow` (`controls.tsx:493, 505`), Escape handler masked by `useLayer` in `markdown/BlankPopover.tsx:206-212`. Gain -10. Risk low (Escape test to add). Effort S. (`useEscape` is handled in M01.)

R08. `TableHead` cannot render a non-sortable table: six hand-written headers (`ApiTokensCard.tsx:196-205, 317-327`, `group/GroupSetList.tsx:81-90`, `AdminTasks.tsx:130-140`, `project/RunHistory.tsx:82-96`, `AdminKiosk.tsx:94-104`), five of them without `scope="col"`, and two workarounds `sort={null} onToggle={() => {}}`. `ui/table.tsx:176`: "Every table used to hand-roll its head". Make `sort` and `onToggle` optional. Gain -15 to -22, accessibility fix. Risk low. Effort S.

R09. `Badge`, `Card` and `T` rewrite the class lists of `@quiz/ui` (`ui/feedback.tsx:144-178` against `styles.ts:139-155`, `ui/page.tsx:63-80` against `styles.ts:19`, `ui/table.tsx:59-64` against `styles.ts:157-164`). Gain -10, source of drift removed. Risk low. Effort S.

R10. Four definitions of the empty cell `Dash` (`packages/ui/src/grading.tsx:187-190`, `gradebook/cells.tsx:38-42`, `student/StudentGrades.tsx:278`, `project/ProjectGroup.tsx:49`) and 14 inline copies: `Dash` of `@quiz/ui` with `className`. Gain -8. Risk low. Effort S.

R11. `StackedRow` (`project/ProjectAdvanced.tsx:22-33`) and an inline copy (`project/ProjectSettings.tsx:125-129`) duplicate the title and description block of `SettingRow`: `stacked` variant. Gain -10, one component. Risk low. Effort S.

R12. Media queries written in three ways (`packages/ui/src/expand.tsx:31-49`, `apps/web/src/ui/layers.tsx:98-130`, four inline `prefers-reduced-motion` tests): `useMediaQuery` in `packages/ui`, `prefersReducedMotion()`. Gain -12 to -20. Risk low (test fallback differs depending on the caller). Effort S.

R13. Primitive redone by hand: rename modal of `poll/PollModeration.tsx:333-365` instead of `FormDialog`. Draw/code toggle of `diagram/src/editor/Toolbar.tsx:71-84` instead of `Segmented` (see anomaly 8). Gain -11. Risk low. Effort S.

R14. Five identical switch rows in `evaluation/AdvancedDisclosure.tsx:142-181`: local table with literal i18n keys. Gain -28. Risk low. Effort S. Close to a stylistic rework: optional.

R15. Mutually exclusive booleans that each open a layer (`ClassroomView.tsx:189-191`, `group/GroupSetPage.tsx:95-96`): a `layer` enumeration. Gain -3, impossible states removed. Risk low. Effort S.

### 6.4 Axis 4: special cases

C01. Dead route flag `CLASSROOM_PAGES` and nullable `home`
- Location: `apps/web/src/router.ts:50-53, 241-269, 652`, `activities/NewActivity.tsx:6, 15-17, 44`, `activities/model.ts:88-93`, `activities/views.tsx:53-63, 158-162, 211, 319`, tests `router.classroomPages.test.ts` (95 lines) and `NewActivity.test.tsx`.
- Evidence: no `ROUTES` entry carries `preview: true` (verified, the only occurrence, `mock/preview.ts:62`, concerns an attempt), but `parsePath` still tests `ROUTES[view].preview && !CLASSROOM_PAGES`. `model.ts:90`: "(`routeEnabled`, none today)".
- Simplification: delete `preview?`, `CLASSROOM_PAGES`, `routeEnabled`, the jump in `parsePath`. `home` always returns a `Route`, which removes three `!== null` tests.
- Gain: -43 in production, -70 in tests. Risk: low. Effort: S.

C02. Optional settings read through five "never raw" accessors
- Location: `packages/contracts/src/evaluation.ts:94-97, 116-122, 140-153` (`categorizePolicyOf`, `negativeMarkingOf`, `safeExamBrowserOf`, `kioskOf`, `retakesOf`) and about twenty call sites.
- Evidence: the older fields use `.default(…)` and `settingsOf` parses each row. ADR-026 and ADR-069 justify the absence only by "no migration", which a zod default also gives. Linked to anomaly 5.
- Simplification: `.default(false)`, `.default("per_item")`, `.default("none")` and a default for `retakes`. Removal of the accessors. `allowDrill` and `poll.moderation` stay optional (their absence depends on the mode).
- Gain: -28 (+10 in fixtures). Risk: medium (amend ADR-026 and 069, stricter output types). Effort: M.

C03. Setting refusal per mode: three classes and three hand-written tests (`evaluation/writes.ts:245-258`, `shared.ts:81-104`): a `{ code, on, allowedFor, why }` table and one class. Gain -18. Risk low. Effort S. To be joined to D04.

C04. Dashboard tooltip: `switch` on the type in the application (`apps/web/src/live/answerText.ts:151-171`, `AnswerTip.tsx:236-258`) whereas the registry offers `summarize` (`packages/core/src/client.ts:313-318`), used by only two types. The file admits it: "No type exposes a full textual rendering through the registry". Client hook returning `AnswerText` in six packages. Gain -20, polymorphism through data. Risk medium (core contract, client without zod, N-PERF-05). Effort M.

C05. Evaluation creation: `mode: "poll"` accepted in order to be refused, `preset` always equal to `mode` (`contracts/evaluation.ts:439-446, 580-586`, `writes.ts:93-94`, `templates.ts:136`, `routes.ts:147, 394`). All callers send `preset: mode` (`templates.tsx:256`, `EvaluationList.tsx:99`, `mcp/tools.ts:159`, seed). `EvaluationMode.exclude(["poll"])` and `presetSettings(input.mode)`. Gain -14. Risk medium: spec F-EVAL-24 names "a mode and a preset" and a 422 refusal, which would become 400. Product decision required.

C06. Host props passed for a single type (`renderText` of cloze in `student/QuestionHost.tsx:151`, `questionTypes.tsx:766, 840`, and `onTryInBrowser` of code in `questionTypes.tsx:682-684`), whereas the contract provides that a player ignores the fields it does not have. Pass unconditionally. Gain -3, four fewer type tests. Risk low. Effort S.

C07. Mode rules rewritten in the web app (`AdvancedDisclosure.tsx:61, 293, 305, 319`, `TimingStep.tsx:289, 415`, `LiveDashboard.tsx:189` and `stateMachine.ts:73` for pause): call `negativeMarkingOn`, `retakesAllowedFor`, `trustedClientsOf`, export `drillModeOf`, add `pausableMode`. Gain 0 to +3, one owner per rule. Risk low. Effort S.

C08. Fallback to the historical login address in role synchronization (`apps/api/src/roles.ts:254-263`): all current paths write `user_emails`. Backfill migration then removal of the branch. Gain -4. Risk medium (check the production data). Effort S.

### 6.5 Axis 5: modules, layers, dead code, dependencies

M01. Declarations referenced nowhere
- Location: `apps/api/src/modules/kiosk/limiter.ts:1-2` (audit 10-03 A5d, open), `apps/web/src/ui/layers.tsx:291-295` (`useEscape`), seven `*GradingStringKey` aliases (for example `packages/qt-mcq/src/strings.ts:126`), `qt-categorize/src/schema.ts:69`, five package entry exports (`contracts/src/kiosk.ts:8`, `contracts/src/notifications.ts:35, 51`, `domain/src/llm.ts:40`, `domain/src/lockedTemplate.ts:39`), doubled documentation sentence in `registry/src/client.ts:4-7`.
- Evidence: a single `git grep -nw` occurrence (the declaration) for each name. `kiosk/limiter` is cited only in `docs/audits/`.
- Gain: -22, one file. Risk: low. Effort: S. Exception: `bumpVersion` (`journal/ingest.ts:242`), reported dead by knip, is reserved for M4-11 (`PROGRESS.md:138`) and must stay.

M02. npm dependencies
- `@dnd-kit/modifiers` declared but unused in `qt-categorize/package.json:28`. `@testing-library/user-event` unused in `qt-diagram/package.json:47`.
- `@dnd-kit/modifiers` is used only for `restrictToVerticalAxis` (`apps/web/src/evaluation/ItemsStep.tsx:10`, `packages/qt-mcq/src/Editor.tsx:30`), which equals `({ transform }) => ({ ...transform, x: 0 })`: a local line removes the dependency.
- `better-sqlite3` is installed as an optional peer of drizzle-orm (`pnpm why`: `drizzle-orm@0.45.2 → @quiz/api`), never imported, with no compiled binary. It pulls in 35 packages of the lockfile. Removal through a pnpm override, exact setting to validate on pnpm 10.34.
- Gain: -1 dependency, -2 declarations, up to -35 packages. Risk: low, medium for the override. Effort: S.

M03. Facade re-exports without consumer: about 30 names in eleven `service.ts` (`system/service.ts:35`, `github/service.ts:891-892`, `grading/service.ts:1093`, `results/service.ts:115`, `notifications/service.ts:490`, `gradebook/service.ts:20-23`, `pool/service.ts:28-88`, `evaluation/service.ts:37-121`, `project/service.ts:54-73`, `runner/index.ts:18`, `llm/service.ts:27`). The 14 files that use `ProjectError` import `./errors.js`. Gain -14, 30 public names. Risk low. Effort S.

M04. Production code alive only through its tests: `github/metrics.ts:212-220`, `domain/src/finalScore.ts:94-97` (`finalPoints`, verified), `domain/src/lockedTemplate.ts:102-104, 180-184`, `domain/src/dayBucket.ts:47-50`, `core/src/contract.ts:92-93`, `core/src/migrate.ts:61-65`, `qt-circuit/src/canvas/symbols.ts:209-214`, `qt-circuit/src/canvas/geometry.ts:46-55`, `apps/web/src/markdown/render.ts:89-91`, `apps/web/src/project/projectPage.ts:360-363`. Delete or move into the test. Gain -60 and the associated test cases. Risk low (the domain requires 100% coverage: tests to adjust in the same PR). Effort S-M. Deliberately excluded: `drillRecallCounts` and `drillReferenceMs` (oracles of the SQL tests), `shiftSemester` (frozen by `domain/src/index.test.ts:45`).

M05. Dependency cycles (audit 10-03 A1a to A1e, all open, worsened)
- Finding: 67 files in a cycle against 41, including a component of 41 files.
- Six cuts: `guards.ts:52` calls `trustedClientsOf` of the domain instead of the evaluation facade (A1d). `holdsCourseSeat` and `classroomStaffIds` (`org/service.ts:235-258`) join `guards.ts`, owner of the `course_staff` predicate (A1c). `linkedLogin` (`auth/githubLink.ts:276-306`) joins the github module. `isStaffAttempt` stops being imported by `pool/pools.ts:12`. `evaluation/templates.ts:31-59` stops importing 27 names from its own facade.
- Simulated effect: 67 then 26 files in a cycle, then 18 by adding A1a (LLM) and A1b (ticker). What remains is the grading/live/results component (A1e, 13 files) and the legitimate component of the Drizzle schema (5 files). Two workarounds disappear (`pool/pools.ts:41-44`, `evaluation/reads.ts:212-214`). Update `docs/spec/05-architecture.md` §5.2.
- Gain: neutral to -10 lines. Risk: medium (`guards.ts` carries invariant 6, notification recipients). Effort: M.

M06. `modules/llm/index.ts` (49 lines) folded into `llm/service.ts`, in line with the "service.ts is the module entry" convention. Removes a type cycle. Gain -8, one file. Risk low. Effort S, together with A1a.

M07. Test tooling consolidated at the root
- Eleven `src/test/setup.ts` bit-for-bit identical, `tsconfig.test.json` identical in 17 packages (md5 verified), test dependencies declared 12 to 19 times (`vitest`, `jsdom`, `@testing-library/*`).
- Simplification: test dependencies and one configuration file at the root. `tsconfig.test.json` reduced to `extends: ["./tsconfig.json", "../../tsconfig.test.base.json"]`.
- Gain: -120 to -150 lines, -10 files. Risk: medium (resolution of pnpm peers from the root. One pass flags a risk of a double instance of `@testing-library/react`, to check). Effort: S-M.

M08. Duplicated alias and predicate: `isLive` and `isGraded` (`apps/web/src/evaluation/common.ts:45-57`) only wrap domain predicates. `browserCanRun` (`apps/web/src/runner/index.ts:28-31`) duplicates `browserCapable` (`qt-code/src/ProgramEditor.tsx:108-110`). Gain -10. Risk low. Effort S.

M09. Public surface: about 243 `export` keywords on names used only in their own file (129 in the API, 77 in the web app). Gain 0 lines, reduced surface. Risk low. Effort S-M. The `export *` entries of the packages (629 names for `@quiz/domain`) are left as is: spelling them out would add lines.

M10. Cross-cutting imports that bypass `service.ts`: about 23 edges (`pool/config.ts` imported by nine modules, `grading/jobs.ts` by three files of live and results, `pool/assets.ts` by github and journal). Gain 0. Make the convention honest through re-export or a named exception, move `sniffImage` and `INERT_IMAGE_HEADERS` into a neutral leaf.

M11. Module merges: none justified. The small modules (legacy 157 lines, admin 302, preview 708, mcp 1,179) each have their own responsibility and a single importer (`app.ts`). Only the evaluation and grading pairs (11 out of 11) and evaluation and results (6 out of 8) are co-imported more than 75% of the time, in the direction provided by the spec. `packages/registry`, `qt-rich` and `qt-brainstorm` are required by the "one package per type" rule. `docrender` and `apps/web/src/markdown` are two distinct engines.

M12. Mockup `apps/web/src/mock` (15,796 lines): no dead file, all reachable from `main.tsx`. Eleven internal exports. A cycle `mock/journal.ts:56` and `mock/org.ts:38`. No code overlap with the seed: they are two datasets at different layers. The contract tests `mock/contract.test.ts` make it useful in CI.

### 6.6 Axis 6: ADRs

A01. Delete `docs/adr/history/` (7 files, 2,336 lines) and the anchor lists that point to it (`ADR-014:178-199`, `ADR-018:154-209`, `ADR-030:371-420`). No incoming link from outside the ADR folder (verified). Replace the links with a permalink on a pinned commit, keep the correspondence tables of the sections cited by the code (about 380 comments cite former addenda). Update the rule of `docs/development/documentation.md:49-53`. Gain -2,460. Risk low. Effort S.

A02. Fold four ADRs into their successor, leaving a ten-line pointer at the same path (referenced by 20 files or more):
- 045 into 063: its two living rules are already in 063. Its §1 is false (`createLlm` returns the gateway's grader).
- 048 into 070: its status announces M3-15b-2 and M3-16 as pending, delivered (`PROGRESS.md:122-125`). Only twelve lines of batch 2 remain valid.
- 049 into 057: partially obsolete imported body (write to GitHub, made read-only by 057 §2) and internal contradiction (`ADR-049:26` "points 2 and 7", `:228` "points 2, 3 and 7").
- 072 into 071, correcting the status of 071 ("Proposed", whereas `qt-brainstorm` and the migration `0065_poll_idea_marks.sql` are delivered).
- Gain -620. Risk medium (numerous references). Effort M.

A03. ADR-040 in duplicate: fold the circuit record (frequency stimuli, which "Extends ADR-019") into ADR-019 as a section. ADR-040 then covers favorites only. Links to update listed (README, ADR-019, spec 04 and 06, eight comments of `packages/qt-circuit/src`). Gain -100. Risk low. Effort S.

A04. ADR-029, never applied and entirely replaced by 035: reduce to an eight-line pointer, fix `apps/web/src/activities/Timeline.tsx:22-23`. Gain -157. Risk low. Effort S.

A05. Remove `AUDIT-2026-10-02.md` (its own 3 October section declares the findings resolved) after carrying three rules over into the relevant records. Harden `TEMPLATE.md` (80 lines at most, status of five lines at most, decision modified in place with a one-line dated note, no addendum, no delivery log, no rollback procedure, no file list). Align the index titles with those of the records (014, 018, 030). Gain -140. Risk low. Effort S.

A06. Delete the "Rollback" sections (sixteen records, about 107 lines): perishable operating procedures, which the runbook owns. Keep the "destructive migration" consequence of ADR-053. Counted in A07.

A07. Condense the other records to the Context, Decision, Consequences format: statuses turned into amendment logs, stacked addenda, delivery sections that copy the task cards, narrative contexts, developed alternatives. The per-record targets are in section 7. For each section cited by the code ("addendum c", "PR B"), a correspondence table of a few lines. Rewrite example in the appendix (ADR-031, 433 lines brought down to 22). Gain -6,000 to -7,000. Risk medium (fidelity of decisions, cited anchors). Effort L, by thematic cluster.

A08. Fix the 19 divergences between active ADRs and code (section 7), with no line gain.

A09. ADR-003: three clauses never applied and without a task. §2 "uuid v7" (identifiers come from `randomUUID()`, version 4). §4 "repository layer isolating Drizzle" (103 module files import `drizzle-orm`). §5 audit immutability through SQL roles (anomaly 1). The code prevails for §2 and §4, §5 is a security property: product decision required before any rewrite.

A10. ADR-009 bases data protection on hosting in Switzerland and SWITCH backups (`ADR-009:22-24, 35-37`), whereas the spec says "a server in Europe, a Hetzner VM" (`docs/spec/03-exigences-non-fonctionnelles.md:58`) and the runbook describes Hetzner backups. Rewrite the ADR to the actual state after confirmation by the product owner.

### 6.7 Documentation outside the ADRs

X01. `docs/merge/09-tasks.md` (4,572 lines): 75 tasks delivered out of 98, about 4,000 lines of completed cards, including 54 "As delivered" notes already summarized by a line of `PROGRESS.md` and kept by git. Keep the open cards (about 565 lines) after moving the notes that concern them into them ("For M8-01" block, mentions of M4-10 and M6). Repoint `apps/api/src/modules/activity/kind.ts:11` and `scripts/import-classroom/steps-projects.ts:2`. Gain -3,970. Risk low. Effort M.

X02. `docs/PLAN-MVP.md` (2,129 lines): its banner (`:3-16`) declares phase 1 finished and "Everything else is history". Only the D1-D20 table of §9 remains normative. Keep a pointer of about 60 lines (banner, §9, permalink to the full version) so that the 128 "PLAN-MVP §x.y" citations in the code remain resolvable. Add `search: exclude`. Gain -2,070. Risk low. Effort S.

X03. `docs/audits/2026-10-03-code-quality/` (10 files, 1,032 lines): no incoming link outside navigation, partially stale (M2-06 and M3-07 declared pending, delivered). Its open items are carried over into this report. Gain -1,030. Risk low. Effort S.

X04. Merge strategies whose work is delivered: `03-github-projects.md` (372 lines, §3.3 stale: `groups.ts`, `ingest.ts`, `dispatch.ts` do not exist) reduced to anchors toward spec 05 §5.11. `04-journal.md`, `05-web.md`, `01-strategy.md`, `07-incompatibilities.md` lightened. `08-decisions.md` (501 lines, D01 to D29 all settled) reduced to decision, date and place of transfer. Keep `02-data-and-migration.md`, `06-codespace-seb-infra.md` and the measurements until the M8 switchover. Archive `docs/merge/` after M9-01 (-1,300 more). Gain -840. Risk medium (the M8 agents read these files). Effort M.

X05. `docs/merge/PROGRESS.md`: delete the session log (`:201-301`, stopped on 5 October and wrong on M3-09c), reduce each delivered handover to one sentence, fix the "Now" section (`:16-17`). Gain -110 lines and about 49 KB. Risk low. Effort S.

X06. `docs/development/deployment.md`: delete three one-off procedures already executed (`:464-500`, `:547-553`, `:794-824`) and fix the `LLM_PROVIDER` line of §10. Gain -77. Risk low. Effort S.

X07. Copied rules and maps: repository map in CLAUDE.md, README and `repository.md` (the declared owner is the least complete). Production refusals partially restated in six places. `invariant-reviewer.md:39-72` rephrases invariants 4 and 6. `quiz-ui/SKILL.md:55-58` copies invariant 1. CI described twice. Images section duplicated between `documentation.md` and `screenshots.md`. Gain -90. Risk low. Effort S.

X08. Delete the root pointer `deploy.md` (19 lines) after repointing eleven comments to `docs/development/deployment.md` (identical numbering). Move `docs/kiosk.md` into `docs/development/`. Gain -19, one file. Risk low. Effort S.

X09. `apps/web/DESIGN.md` (2,016 lines): remove the provenance prose ("It exists because…", "used to", about forty task and date references), without touching the rules. Gain -100 to -120. Risk low. Effort M.

X10. Spec 02: fold the amendment logs (29 "Amended … (product owner, M3-14x)" mentions) into the text of the requirements, in line with `spec/README.md:91-93`. Gain about 10 KB. Risk medium (wording of requirements). Effort M.

X11. Documentation contradicted by the code (22 references, no line gained): data protection page (anomaly 2). `question-types.md:318-328` (LLM grading "planned"). `docs/index.md:17` ("six types", there are ten). `repository.md` (registry list, 7 schema files out of 22, missing web folders, nonexistent `admin.ts`). `architecture.md:107` ("eight" qt-*). Spec 05 §5.2 (seven missing modules, nonexistent `canonical`). `data-model.md` (gradebook "planned", `course_staff.role` absent). `teams.md:196` (2.1.0 instead of 2.2.0). `.env.example` and `config.ts` on the LLM. Seed counts in `development/index.md:81, 138`. `spec-challenger.md:23`. Status of invariant 15 in CLAUDE.md. `AGENTS.md:44` (anomaly 7). Risk low. Effort S.

X12. Two decision registers share the D numbering: "D14" designates the runner stub in PLAN-MVP (43 occurrences) and the storage of journal attachments in `08-decisions.md`. Prefix ("MVP-D14") or at least document the convention in `spec/README.md`. Gain 0. Risk low.

## 7. ADRs: verdict per record

| ADR | Lines | Verdict | Divergence from the code | Target |
|---|---:|---|---|---:|
| 001 | 42 | keep, may absorb 002 and 008 | no | 30 |
| 002 | 41 | condense or fold into 001 | no | 20 |
| 003 | 63 | condense after decision on §2, §4, §5 | yes: UUID v4, no repository layer, no GRANT, `anonymized_at` never written | 30 |
| 004 | 41 | keep | no | 28 |
| 005 | 53 | condense | yes: fallback refresh at 60 s, not 30 s (`useEventStream.ts:17-27`) | 25 |
| 006 | 79 | rewrite | yes: 1 s tick by atomic claims, without lock (`config.ts:109`), points 1 and 2 replaced by 064 | 30 |
| 007 | 84 | pointer to the infrastructure outside the repository | not applicable | 20 |
| 008 | 43 | keep or fold into 001 | no | 25 |
| 009 | 61 | rewrite | yes: Switzerland and SWITCH against Hetzner Europe | 25 |
| 010 | 87 | condense the status | no | 35 |
| 011 | 138 | condense, integrate two addenda | no | 60 |
| 012 | 80 | condense | minor: `student_repo_id`, `frozen_final` nonexistent | 40 |
| 013 | 147 | condense, link to 068 | no | 70 |
| 014 | 199 | condense, remove the anchors | yes: brainstorm polls delivered | 120 |
| 015 | 139 | condense | no | 60 |
| 016 | 104 | rewrite, provision to the runbook | no | 40 |
| 017 | 149 | condense, record 068 | yes: §8 also refuses an assistant (`pool/moveRoutes.ts:132, 155-158`) | 60 |
| 018 | 209 | condense, remove 56 lines of anchors | no | 110 |
| 019 | 141 | condense, absorb 040 circuit | minor: image path, `llm` mode refused at publication | 85 |
| 020 | 202 | condense | no (requested spec amendment still pending) | 70 |
| 021 | 135 | condense | no | 55 |
| 022 | 241 | condense | no | 100 |
| 023 | 140 | condense | no | 70 |
| 024 | 151 | condense | no | 55 |
| 025 | 234 | condense | no | 90 |
| 026 | 158 | condense | no | 65 |
| 027 | 166 | condense | minor: `sits` became `sitRefusal` (`guards.ts:1168`) | 80 |
| 028 | 167 | rewrite to the current state | no | 60 |
| 029 | 165 | pointer (replaced by 035) | stale comment `Timeline.tsx:22-23` | 8 |
| 030 | 420 | condense, remove the anchors | no | 250 |
| 031 | 433 | condense | no | 130 |
| 032 | 95 | condense | no (context contradicted by 068) | 40 |
| 033 | 117 | condense | no | 55 |
| 034 | 193 | condense | no | 90 |
| 035 | 232 | condense, §6 as links | no | 110 |
| 036 | 214 | condense | no | 95 |
| 037 | 54 | keep | no | 50 |
| 038 | 211 | condense | no | 90 |
| 039 | 196 | condense | no | 90 |
| 040 favorites | 112 | sole ADR-040, condense | no | 50 |
| 040 circuit | 138 | fold into 019 | no | 0 |
| 041 | 416 | condense | yes: the training switch is in Settings (`ClassroomSettings.tsx:1-5`), not in the tab | 120 |
| 042 | 170 | condense, optional merge with 043 | no | 60 |
| 043 | 187 | condense | no | 65 |
| 044 | 239 | condense | no | 85 |
| 045 | 130 | fold into 063 | yes: §1 false (`llm/index.ts:33-40`) | 10 |
| 046 | 302 | condense | no | 95 |
| 047 | 134 | condense, keep as planned (M6) | no | 55 |
| 048 | 189 | mark replaced, batch 2 to 070 | yes: stale status | 10 |
| 049 | 229 | fold into 057 | internal inconsistency | 10 |
| 050 | 195 | condense | no | 75 |
| 051 | 414 | condense, security intact | yes: `endConfinedSessions` is called `endKioskSessions` (`auth/session.ts:414`) | 150 |
| 052 | 129 | condense | no | 50 |
| 053 | 158 | condense | no (fully applied) | 45 |
| 054 | 163 | condense | no | 70 |
| 055 | 329 | condense | no | 110 |
| 056 | 447 | condense | no | 150 |
| 057 | 178 | keep, absorb 049 | no | 110 |
| 058 | 227 | condense, fix §2 | yes: only `models.default` is written | 95 |
| 059 | 172 | condense | no | 70 |
| 060 | 133 | condense | no | 60 |
| 061 | 139 | condense | no | 65 |
| 062 | 204 | condense the addendum | no | 70 |
| 063 | 211 | keep, absorb 045 | no | 100 |
| 064 | 189 | condense the addendum | no | 75 |
| 065 | 42 | keep | no | 35 |
| 066 | 100 | condense | no | 45 |
| 067 | 166 | condense | no | 70 |
| 068 | 131 | condense lightly | no | 70 |
| 069 | 116 | condense | minor: `calculatorOn` is in `domain/src/evaluationConfig.ts:278` | 50 |
| 070 | 480 | condense, absorb 048 | no | 90 |
| 071 | 100 | fix the status, absorb 072 | yes: "Proposed", yet delivered | 85 |
| 072 | 109 | fold into 071 | no | 10 |
| 073 | 129 | condense | no | 60 |
| 074 | 142 | condense | probable: M5-04 consequence stale (low confidence) | 70 |
| 075 | 188 | condense, keep "Proposed" | no | 75 |
| 076 | 90 | condense | no | 50 |
| 077 | 95 | condense | no | 45 |

Records: 13,246 lines today, about 5,200 targeted. With `history/`, the audit, the template and the index: 15,870 lines, target 5,300 to 6,500.

## 8. False positives set aside and uncertainties

Verified knip false positives: `.claude/hooks/guard.mjs` (launched by `.claude/settings.json`), `@fontsource-variable/*` fonts and `tailwindcss` (imported from `style.css`), `bumpVersion` (reserved for M4-11), `github/sync.ts` (used since M3-07), default exports of qt-circuit and qt-code (lazy loading), `runno/worker.ts` (loaded through `new URL`), codespace contracts (consumed by M6-03 and M6-06, to do), test seams (`TestClock`, `registerForTests`, GitHub fakes).

Legitimate duplicates set aside: student and staff views (invariants 4 and 6), refusals of `config.ts`, confinement of seb, kiosk and impersonation, `solutionView` and `studentSolutionView`, per-type allowlists of `toStudent`, diagram codec grammars, per-type domain tables (`DRILL_TYPES`, `PARAMETERIZED_TYPES`…), distinct preview, attempt and poll protocols, `budget.ts` and `limiter.ts` (a merge that would change the limiting edges), `escapeXml` of `auth/seb.ts` (would change the SEB configuration key), translation dictionaries, denormalized columns justified by freezing or performance, input drafts resynchronized by effect (intended).

Uncertainties:
- The gains are static estimates, often optimistic. The totals are given as a low range.
- D13 depends on formatting, R14 borders on a stylistic rework, R02 has a high test migration cost, D10 awaits a hosting choice.
- Anomaly 5 (C02) is deduced, not tested.
- M07: the resolution of test dependencies from the root must be proven in CI. One pass judges sharing the configuration file risky (double instance of `@testing-library/react`).
- The ADR condensation targets come from two independent readings and may go up at writing time. Fidelity takes precedence over the target.
- Shallow clone: impossible to verify here that the full history is available on the remote repository before deleting `history/` in favor of permalinks.

## 9. Figures summary

| Measure | Value |
|---|---|
| Removable production code | 2,200 to 2,700 net lines (axis 1: about 1,900, axis 2: 120, axis 3: 420, axis 4: 130, axis 5: 120) |
| Tests and tooling | about 190 lines of tests, 150 to 180 of configuration |
| Documentation | 17,500 to 18,800 lines: ADRs 9,400 to 10,500 (minus 60 to 66%), outside the ADRs about 8,250 (minus 37%), plus 1,300 after M9-01 |
| Deleted files | code: about 14 (including 10 test configuration files, `kiosk/limiter.ts`, `llm/index.ts`, `LockIcon.tsx`, one test file), documentation: about 20 (7 snapshots, 10 audit files, the ADR audit, `deploy.md`, ADR-040 circuit) |
| Fewer components and hooks | 14 (`QuestionPlayerHost`, two `Panel`, `SettingNumber`, `StackedRow`, one drop zone, four local icons, three `Dash`, `useEscape`) and three `viewOption` helpers replaced by one component |
| Fewer classes | about 40 refusal classes |
| Modules | no business module merge, one entry file folded (`llm/index.ts`) |
| Public surface | about 270 exports removed (243 `export` keywords, 30 facade names) |
| npm dependencies | one dependency removed (`@dnd-kit/modifiers`), two useless declarations, up to 35 lockfile packages (`better-sqlite3`) |
| Cycles | from 67 to 26 files in a cycle, then 18 with A1a and A1b |
| ADRs | 6 reduced to a pointer (029, 040 circuit, 045, 048, 049, 072), about 65 condensed, 4 kept as is (004, 037, 057 extended, 065), no number deleted, 19 divergences to fix |

## 10. Execution plan in independent batches

Each batch is a PR (or a small series) verifiable by the existing checks: `pnpm build && pnpm typecheck`, tests of the touched packages while iterating, then `VITEST_MAX_WORKERS=4 pnpm -r --workspace-concurrency=1 test` before merging. The batches are independent unless noted.

| Batch | Content | Gain | Verification |
|---|---|---:|---|
| 1. Risk-free documentation | X03, X05, X01, X08, A05, X11 | about 5,300 | `pnpm docs:build`, link check, `git grep` of the deleted paths |
| 2. Archives by permalink | A01, X02 (permalinks pinned on `b5e44c3`) | about 4,500 | same, "PLAN-MVP §x.y" and "ADR-0xx addendum" citations still resolvable |
| 3. Dead code and dependencies | M01, M03, M06, M08, R07, C01, M02 (excluding `better-sqlite3`) | about 160 and 70 of tests | build, typecheck, knip rerun, web router and API tests |
| 4. Package types | D01, D12, D18 | about 565 | typecheck, tests qt-circuit, qt-code, qt-*, web |
| 5. Web primitives and props | D02, D03, D07, D14, R03, R08 to R11 | about 400 | web tests, `dev:mock` screenshots |
| 6. Web queries, menus, small duplicates | D05, D06, D15, D20, R12, R13, R15 | about 250 | web tests, `queryKeys.test.ts` |
| 7. Enumerations and constants | S01 to S07, S09, S10, C07 | about 130 | build, typecheck, tests contracts, domain (100%), api |
| 8. API errors and responses | D04, C03, D16, D17, D09, D21 | about 380 | suites evaluation, live, poll, results, grading, github, project |
| 9. Access and cycles | D08, M05, D22 | about 100 | guards, Super Powers, readableClassroom, auth, notifications, project, journal, recomputation of the components, invariant-reviewer review |
| 10. Question hosts | R01, C06, R06, C04 | about 130 | `questionTypes.test.tsx`, TryPanel, AnswerPanel, QuestionHost, screenshots |
| 11. Package algorithms and tests | D10, D11, D19, D23, D24 | about 250 and 120 of tests | golden tests of the router and the circuit, `layout.test.ts` of the diagram |
| 12. Test tooling | M07 | 120 to 150 | full sequential suite, CI per package |
| 13. Navigation through context | R02, in several PRs | 90 to 110 | web tests |
| 14. ADRs | A02, A03, A04, then A07 by cluster, A08 | 7,000 to 8,000 | docs build, `git grep` of each cited anchor, spec-challenger review |
| 15. Remaining documentation | X04, X06, X07, X09, X10, X12 | about 1,100 | docs build |

Recommended order: batches 1, 2 and 3 first (maximum gain, minimum risk), then 4 to 8, then 9 to 13. The documentation batches 14 and 15 can proceed in parallel. Batch 9 comes after batch 8 (same routes), batch 10 is coordinated with audit 10-03 W5, batch 6 with W2 and W3.

Conditional batches, after decision: C02, C05, C08, S08 (duration), anomaly 4 (brainstorm), A09, A10, `better-sqlite3` override, D13, R14.

## 11. Decisions expected

1. ADR-003 §5: are the immutability of the audit through SQL roles and the anonymization of accounts to be scheduled, or to be removed from the ADR?
2. ADR-009: record the Hetzner hosting in Europe and drop the Swiss hosting argument?
3. Maximum duration of an evaluation: 8 h (interface) or 24 h (contract)?
4. Should brainstorm polls appear among the recent polls to reuse?
5. Evaluation creation: remove `preset` and answer 400 instead of 422 for a `poll` mode (amends F-EVAL-24)?
6. Accept the deletion of the documentation history (ADR snapshots, MVP plan, delivered cards, 3 October audit) in favor of git permalinks?
7. Accept the hardened ADR template (80 lines at most, no addendum, no rollback or delivery log) before the condensation?

## Appendix: condensation example (ADR-031, 433 lines brought down to 22)

Proposed text, in English like the rest of the documentation. The identifiers cited exist in the code (verified: `evaluations_home_ck`, `evaluations_template_ck`, `itemListLock`, `template_pool_unlinked`, `template_moved`, `pool_in_use`, `origin_template_id`, `coursePoolIds`, `loadTemplate`, `TemplatePatch`). A four-line table would link "PR B", "addendum c" and "addendum of 2026-09-30 §3", cited by the code, to points 2, 5 and 6.

```markdown
# ADR-031 — Evaluation templates at course level

## Status
Accepted 2026-09-27 (#151); addenda of 2026-09-28 (course page, editing, pull) and 2026-09-30 (*Save as template* links its source) folded in. Amended by ADR-052 (bonus is content) and ADR-053 (no access code). Promote screen deferred (06 no. 25). Requirements: F-EVAL-18, F-EVAL-24 to F-EVAL-26, F-ORG-12.

## Context
An evaluation lives in one classroom: next year's duplicate carried its dates, IP list and one-off changes, and deleting the classroom deleted it. A course needs a kept version from which each classroom's evaluation is made.

## Decision
1. A template is an `evaluations` row with `course_id` set. `evaluations_home_ck` allows exactly one home (classroom, course, or owner of an anonymous poll); `evaluations_template_ck` forbids run fields (dates, IPs) and forces `draft`, mode `exam|exercise`, `revision` set.
2. Access: `loadTemplate` through `staffAccess` on the course (404 otherwise). `loadEvaluation` keeps its classroom join, so no evaluation route or MCP tool reaches a template; edits use `/app/api/templates/:id/...` with a `.strict()` `TemplatePatch`.
3. Content: items (frozen versions, points, order, milestones, bonus), settings, grade scale, feedback and MCQ policies, duration, drawn only from the course's linked pools (`coursePoolIds`).
4. `revision` moves once per request that changes content (never the title), by one SQL helper inside the write.
5. Instantiate (same course only) records `origin_template_id`/`origin_revision`; *Save as template* makes its source an instance at rev 1. An unlinked pool blocks (`422 template_pool_unlinked`); a deprecated version warns.
6. Pull replaces only the instance's items, only where `itemListLock` allows, for the revision the teacher confirmed (`409 template_moved`); locks the template `FOR SHARE`, then the instance `FOR UPDATE`.
7. Deleting a template nulls its instances' origin; deleting a course cascades; a pool pinned by an evaluation or template cannot be deleted (`409 pool_in_use`).

## Consequences
One row shape, so every configuration rule applies unchanged. Audited `template.create|instantiate|update|pull|delete`. Duplicate remains an unlinked copy.

## Alternatives rejected
Separate template tables (a second copy of every rule); a `kind` column (second source of truth); a null-classroom flag (collides with anonymous polls); a publish step (guards nothing); poll templates.
```
