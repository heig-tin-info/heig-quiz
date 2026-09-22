# Frontend core audit — `apps/web/src` cross-cutting layer

`scratchpad/report-frontend-core.md`
("subagents should return findings as text, not write report files"). The complete report is

---

## Summary (~300 words)

The frontend core is 19 452 non-test LOC over 59 files, plus 7 674 LOC of tests. It is
well-kept: `ui.tsx` is a real design system with a documented reason per value, the floating-layer
focus contract (`useLayer`) is centralised and battle-tested, the question-type hookup
(`questionTypes.tsx`) is clean, and `api.ts` is 72 lines. The debt is not sprawl. It is three
things.

First, leftovers from the `heig-classroom` ancestor that nothing deleted: a 139-line
`RangeCalendar` with untranslated month names that no screen imports, `OrgAvatar`, `GithubIcon`,
50 unreferenced i18n keys, 43 dead exports and one unused dependency — about 480 LOC of pure
deletion, provable by `pnpm typecheck`.

Second, three cross-cutting mechanisms implemented twice. Two competing registries for "the
commands of the mounted screen" (`screenCommands.ts` vs `registerContextualCommands`, with
contradictory docblocks and different merge points). Two `typeLabel` functions with opposite
argument orders, one of which forgets `circuit` — so a circuit question renders the raw
identifier `circuit` at five call sites. And four hand-rolled `localStorage` readers, three of
which throw in a private window while the fourth already has the try/catch.

Third, three files have outgrown one file and block the planned `packages/ui`: `ui.tsx` (2 974,
cycles with `help.tsx` and imports `api.ts`), `i18n.tsx` (3 922, both dictionaries in the first
chunk) and `mock/index.ts` (5 839, a second implementation of 122 API routes that no test
validates against `@quiz/contracts`).

The CC hotspots are two: `RichText` (942 lines, CC 40) and `App` (CC 36, caused by the route
table being written in seven places). Both decompose by pure extraction against strong existing
tests. Total estimated reduction ≈ 1 015 LOC (5.2 %), CC > 10 functions 27 → ~18.

---

## Top 10 findings

| # | Title | Principle | LOC | Risk |
| --- | --- | --- | --- | --- |
| FC-02 | `RangeCalendar` + 4 helpers dead (`ui.tsx:2314-2452`), CC 17, untranslated | YAGNI | −154 | very low |
| FC-18 | 43 dead exports + `@tiptap/extension-link` unused | YAGNI | −120 | very low |
| FC-01 | 50 i18n keys nothing reads (110 dictionary lines) | YAGNI | −110 | very low |
| FC-07 | 7 form dialogs repeat the same footer + error block | DRY | −85 | low |
| FC-13 | `Breadcrumb.tsx` dead; 6 pages hand-roll the eyebrow link in 2 class lists | YAGNI+DRY | −70 | low |
| FC-22 | `mcq` `Stats` registered, translated, never mounted | YAGNI | −65 / +3 | low |
| FC-11 | `apiErrorMessage` plumbing at 42 sites in 2 shapes | DRY | −60 | very low |
| FC-14 | 5 copies of the listbox key handler, 2 of the roving one | DRY | −60 | low |
| FC-19 | `Modal` and `Sheet` share a 45-line shell verbatim | DRY | −45 | low |
| FC-10 | ~70 inline query keys, one typed key module, `PATCH /me` ×4 | SSOT | −40 | low |

Three more that matter more than their LOC: **FC-03** (two command registries, −35, spec §8.4
asks for one), **FC-05** (route table written 7×, `App` CC 36 → ~8, `parsePath` 26 → ~6),
**FC-06** (`RichText` CC 40 → ~12 by pure extraction).

---

# Full report

Scope: `ui.tsx`, `App.tsx`, `Shell.tsx`, `Header.tsx`, `Breadcrumb.tsx`, `router.ts`,
`commands.ts`, `screenCommands.ts`, `CommandPalette.tsx`, `shortcuts.tsx`, `api.ts`, `i18n.tsx`,
`live.ts`, `realtime/`, `notify.tsx`, `confirm.tsx`, `theme.ts`, `fuzzy.ts`, `help.tsx` +
`help/`, `markdown.tsx` + `markdown/`, `questionTypes.tsx`, `studentView.ts`, `mock/`, `test/`,
`AdminPanel.tsx`, `SettingsPage.tsx`, `AvatarEditor.tsx`, `TeacherHome.tsx`, `ClassroomView.tsx`,
`RosterImport.tsx`, `RosterTable.tsx`, `DevGallery.tsx`, `style.css`, `apps/web/scripts/`.
Feature folders were read only to measure duplication whose **fix belongs in the core**; no
finding is filed whose primary location is there.

## 1. Overview, in numbers

| Measure | Value |
| --- | --- |
| Source files in scope (non-test) | 59 (+ 4 `scripts/*.mjs`, + 15 `help/*.md`) |
| Source LOC in scope (non-test, incl. `mock/index.ts`) | **19 452** |
| of which `mock/index.ts` | 5 839 (30 %) |
| of which `i18n.tsx` | 3 922 (20 %) |
| of which `ui.tsx` | 2 974 (15 %) |
| of which `markdown/` | 3 088 |
| Test LOC in scope | 7 674 |
| Functions in scope (non-test, excl. `mock/`) | 1 373 |
| Functions with CC > 10 (excl. `mock/`) | **27** (mock adds 16 more) |
| Functions over 150 lines (excl. `mock/`) | **14** |
| React components declared in scope | 104 (45 exported from `ui.tsx`) |
| i18n keys (`en`) | **1 736** (`fr` 1 736, no drift) |
| i18n keys never referenced | **50** (≈ 110 dictionary lines across both locales) |
| Distinct `en` values carried by ≥ 2 keys | 169 values / 260 surplus keys (mostly legitimate — see FC-04 for the one that is not) |
| Exported symbols never imported by another module | **161** flagged; 43 truly dead |
| Unused direct dependency | 1 (`@tiptap/extension-link`) |
| Hand-rolled `localStorage` state readers | 4 (3 throw in a private window) |
| Query keys written as inline literals | ~70 sites, 1 typed key module (`evaluation/common.ts`) |

Top CC hotspots in scope:

| CC | lines | function | location |
| --- | --- | --- | --- |
| 40 | 942 | `RichText` | `apps/web/src/markdown/RichText.tsx:187` |
| 36 | 151 | `App` | `apps/web/src/App.tsx:135` |
| 31 | 115 | `handleKeyDown` | `apps/web/src/markdown/RichText.tsx:324` |
| 27 | 204 | `buildCommands` | `apps/web/src/commands.ts:106` |
| 26 | 43 | `parsePath` | `apps/web/src/router.ts:91` |
| 19 | 246 | `Row` | `apps/web/src/RosterTable.tsx:51` |
| 19 | 43 | `routeToPath` | `apps/web/src/router.ts:47` |
| 17 | 237 | `ClassroomView` | `apps/web/src/ClassroomView.tsx:201` |
| 17 | 34 | day cell of `RangeCalendar` | `apps/web/src/ui.tsx:2409` (dead — FC-02) |
| 14 | 259 | `Shell` | `apps/web/src/Shell.tsx:325` |
| 10 | 297 | `Menu` | `apps/web/src/ui.tsx:998` |

---

## 2. Findings, ranked by (LOC × confidence) / risk

### FC-01 — 50 i18n keys nothing reads (110 dictionary lines)
**YAGNI · LOC −110 · risk very low · confidence high**

A scan of every `.ts/.tsx/.mjs` under `apps/web` and `packages` for literal keys, for the dynamic
prefixes actually used (`` t(`mcq.policy.${…}`) ``, `` t(`eval.state.${…}`) ``, …) and for the
`qt.*` keys that `translated(t, defaults, prefix)` builds (`questionTypes.tsx:126`) leaves 50 keys
with no reader. Spot-checked by grep:

```
apps/web/src/i18n.tsx:169   "student.title": "My classrooms",
apps/web/src/i18n.tsx:170   "student.subtitle": "The classrooms you have joined.",
apps/web/src/i18n.tsx:174   "student.teachers": "Taught by {names}",
apps/web/src/i18n.tsx:175   "student.bonus": "Extra time: +{n}%",
apps/web/src/i18n.tsx:226   "palette.openCourse": "Open course {name}",
apps/web/src/i18n.tsx:61    "common.search": "Search…",
```

The `student.*` block is the WP6 student home that `shome.*` replaced; `palette.openCourse` is the
per-course palette entry dropped when `buildCommands` started listing classrooms
(`commands.ts:168`); `live.inspect.*` (6 keys), `grading.filter.*`, `results.notFound`,
`eval.launch.*` are the same story. Full list: `classrooms.claimed`, `common.search`,
`eval.closesAtShort`, `eval.count.attempts`, `eval.count.items`, `eval.launch.closeLobby`,
`eval.launch.summary`, `eval.open`, `eval.opensAtShort`, `eval.preset`,
`eval.scale.threshold.label`, `eval.viewAsStudent.taken`, `grading.batch.all`,
`grading.filter.any`, `grading.filter.state`, `grading.history.close`, `grading.notFound`,
`grading.progress.running`, `join.title`, `live.extendOne`, `live.extended`, `live.grid.average`,
`live.grid.completion`, `live.inspect.awaiting`, `live.inspect.empty.body`,
`live.inspect.empty.title`, `live.inspect.label`, `live.inspect.nextQuestion`,
`live.inspect.prevQuestion`, `live.startConfirm`, `lobby.starting`, `palette.openCourse`,
`pool.categories`, `pool.col.type`, `pool.filter.any`, `pool.filter.category`,
`pool.uncategorized`, `question.previewToggle`, `question.saveFailed`, `question.uploadFailed`,
`question.versions.title`, `results.histogram.range`, `results.notFound`, `shome.state.inProgress`,
`student.bonus`, `student.empty.body`, `student.empty.title`, `student.subtitle`,
`student.teachers`, `student.title`.

**Refactoring.** Delete the 50 keys from both dictionaries, then add the scan as a test —
`i18n.test.ts`: read `en`, glob the sources, assert the unreferenced set is empty modulo an
explicit allowlist for the dynamic prefixes. That is what keeps this from growing back; the
`Record<keyof Dict, string>` type only guarantees `fr` has what `en` has, never that `en` has only
what the app reads.

**Tests.** New `apps/web/src/i18n.test.ts`; existing `*.test.tsx` fail loudly on a key removed by
mistake (a missing key renders as the raw key string).
**Constraint.** Invariant 1 / N-I18N-01: both dictionaries move together; `fr` stays
`Record<keyof Dict, string>`.

---

### FC-02 — `RangeCalendar` and its four helpers are dead (154 LOC)
**YAGNI · LOC −154 · risk very low · confidence high**

`apps/web/src/ui.tsx:2314-2452` — `WEEKDAYS`, `MONTH_NAMES`, `localDateKey`, `monthDays`,
`RangeCalendar` (139 lines; its day-cell callback is the third-highest CC in `ui.tsx` at 17).
`grep -rn "\bRangeCalendar\b" apps packages` returns **one** hit, its own definition.
`localDateKey` is reachable only from `RangeCalendar` and from `apps/web/src/ui.test.ts:43`
(a 15-line `describe`). The product picks dates with the native control instead:

```
apps/web/src/evaluation/TimingStep.tsx:176   type="datetime-local"
apps/web/src/evaluation/TimingStep.tsx:186   type="datetime-local"
```

It is also the one component in `ui.tsx` whose user-facing strings never go through `t()`
(`"Previous month"`, `"Next month"` at `ui.tsx:2396,2401`, twelve English month names and seven
English weekday abbreviations at `ui.tsx:2316-2321`), so it could not ship as written without
breaking invariant 1.

Same neighbourhood, same ancestry, zero importers: `OrgAvatar` (`ui.tsx:654`, fetches
`github.com/<login>.png`), `GithubIcon` (`ui.tsx:1364`, a 16-line inline SVG path),
`localDateTimeInputValue` (`ui.tsx:763`).

**Refactoring.** Delete `RangeCalendar`, `monthDays`, `WEEKDAYS`, `MONTH_NAMES`, `localDateKey`,
`OrgAvatar`, `GithubIcon`, the now-unused `Building2`/`ChevronLeft`/`ChevronRight` imports, and the
`localDateKey` test block. One exception: `localDateTimeInputValue` is *not* dead knowledge —
`apps/web/src/evaluation/TimingStep.tsx:34` reimplements it byte for byte:

```ts
// ui.tsx:763                                          // TimingStep.tsx:34
const d = new Date(date);                              const d = new Date(iso);
d.setMinutes(d.getMinutes() - d.getTimezoneOffset());  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
return d.toISOString().slice(0, 16);                   return d.toISOString().slice(0, 16);
```

Keep the `ui.tsx` one, give it the null guard, have `TimingStep` import it.

**Tests.** `apps/web/src/ui.test.ts`, `apps/web/src/ui.test.tsx` (neither renders
`RangeCalendar`), `apps/web/src/evaluation/EvaluationConfig.test.tsx` for the `TimingStep` half.
**Constraint.** DESIGN.md lists no calendar component; deleting it removes nothing the design
contract promises.

---

### FC-03 — Two registries for "the commands of the mounted screen"
**SSOT / KISS · LOC −35, one mechanism instead of two · risk low-medium · confidence high**

The same job, implemented twice, with two contradictory documented decisions.

`apps/web/src/screenCommands.ts:19` — a single module slot, overwritten every render:

```ts
let current: Command[] = [];
export function useScreenCommands(commands: Command[]): void {
  useEffect(() => { current = commands; return () => { current = []; }; });
}
```
> "One screen at a time on purpose: two of them would mean two 'Publish' entries."

`apps/web/src/commands.ts:322` — a `Set` of sources, explicitly allowing several:

```ts
const contextualSources = new Set<ContextualSource>();
export function registerContextualCommands(source: ContextualSource): () => void { … }
export function contextualCommands(ctx: CommandContext): Command[] {
  return [...contextualSources].flatMap((source) => source(ctx));
}
```
> "the registry is read at the moment the palette opens, so a stale closure is not a thing"

Four screens use the first (`grading/GradingPanel.tsx:298`, `question/QuestionEditor.tsx:403`,
`results/ResultsView.tsx:121`, `pool/PoolView.tsx:229`); exactly one uses the second
(`live/useLiveCommands.ts:36`). They are even merged at different points: `screenCommands()` is
**prepended** in `CommandPalette.tsx:70`, `contextualCommands(ctx)` is **spliced mid-list** at
`commands.ts:295`. `docs/spec/08-experience-deux-niveaux.md` §8.4 asks for exactly one:
*"The actions are provided by the mounted screens, through a command registry in `packages/ui`."*

**Refactoring.** Keep one registry, in `commands.ts`, with the `Set` lifetime (the correct one:
two mounted screens can each contribute, and the duplicate-"Publish" worry is answered by
`Command.id` being unique) and `useScreenCommands`'s ergonomics (callers pass an array, not a
builder). Move `useScreenCommands` into `commands.ts` over a `Set<Command[]>` keyed by a
`useId()`; rewrite `useLiveCommands` to call it with the array it already computes; delete
`screenCommands.ts`, `registerContextualCommands`, `ContextualSource`, `contextualCommands`; fold
the single `screenCommands()` spread in `CommandPalette.tsx:70` into `buildCommands`.

**Risk.** Ordering inside the `action` group changes for the live dashboard (contextual entries
move from mid-list to after the screen's own). With an empty query `filterCommands` preserves
input order, so it is visible — assert the expected order in the test rather than leaving it
implicit.
**Tests.** `screenCommands.test.tsx` (move its three cases onto the surviving hook),
`commands.test.ts`, `CommandPalette.test.tsx`, `live/LiveDashboard.test.tsx`.
**Constraint.** `docs/spec/08` §8.4. Keep the hook's no-dependency-array behaviour: the commands
close over screen state.

---

### FC-04 — `typeLabel` exists twice, with opposite arguments, and one forgets `circuit`
**SSOT · LOC −25 and a visible bug · risk low · confidence high**

```ts
// apps/web/src/questionTypes.tsx:110  — from the registry's own labelKey
export function typeLabel(t: TFunction, id: string): string {
  const client = questionType(id);
  return client ? t(client.labelKey as keyof Dict) : id;   // "Multiple choice" … "Circuit"
}
```
```ts
// apps/web/src/evaluation/common.ts:82  — a hand-written list of four
export function typeLabel(type: string, t: TFunction): string {
  return type === "mcq" || type === "short" || type === "cloze" || type === "code"
    ? t(`eval.type.${type}` as keyof Dict)
    : type;
}
```

`eval.type.*` holds only four entries (`i18n.tsx:1408-1411`, `3319-3322`); there is no
`eval.type.circuit`. So a `circuit` question inside an evaluation renders the raw English
identifier `circuit` at five sites — `evaluation/ItemsStep.tsx:244`,
`evaluation/AddQuestionsSheet.tsx:139` and `:209`, `evaluation/PreviewSheet.tsx:79`,
`live/InspectModal.tsx:199` — while the pool, the editor and the grading panel (the other
function, seven call sites) say "Circuit". The two dictionaries also disagree on case:
`"eval.type.mcq": "multiple choice"` vs `"qt.mcq.label": "Multiple choice"`.

**Refactoring.** Delete `typeLabel` from `evaluation/common.ts`, have the five call sites import
`questionTypes.tsx`'s (swapping the argument order), delete the 8 `eval.type.*` keys.
`questionTypes.tsx` already covers the sentence-case rule of DESIGN.md › Voice and grows by itself
with a sixth type.
**Tests.** `questionTypes.test.tsx` (extend: every id in `QUESTION_TYPE_IDS` has a non-identity
label in both locales), `evaluation/PreviewSheet.test.tsx`, `live/LiveDashboard.test.tsx`.
**Constraint.** Invariant 1; `packages/registry` is the one place a type is declared.

---

### FC-05 — The route table is written seven times; `App` is CC 36 because of it
**SSOT / CC · LOC −30, CC 36 → ~8 and 26 → ~6 · risk medium · confidence high**

Sixteen views, enumerated independently in seven places:

1. the `Route` union — `apps/web/src/router.ts:8-45`;
2. `routeToPath` — a 16-case switch, `router.ts:47-89` (CC 19);
3. `parsePath` — ten `if`s plus a nested switch, `router.ts:91-133` (CC 26);
4. `App`'s page chooser — a 14-branch nested ternary, `App.tsx:217-253`, plus four guard `if`s
   above it (`attempt`, `questionPreview`, `poll`, `join`): CC 36 in 151 lines;
5. `STUDENT_ROUTES` — `studentView.ts:92`, and `studentRouteFor` beside it;
6. `Shell`'s `Nav` — `active={route.view === "pools" || route.view === "pool" || route.view === "question"}`
   (`Shell.tsx:214`), `route.view === "polls" || route.view === "poll"` (`Shell.tsx:238`);
7. `buildCommands`' navigation entries and its `evaluationInView` derivation
   (`commands.ts:106-135`, `:190-199`).

Adding a route today means touching all seven; only (1)–(3) fail to compile if you forget. The
comment at `router.ts:114` already notices the pressure — *"ONE place decides what follows an
evaluation id, so a new tail is added here and nowhere else"* — and then four other files add
their own list anyway.

**Refactoring** (behaviour-preserving, three commits):
1. In `router.ts`, add a `ROUTES` record keyed by `Route["view"]` holding
   `{ path(r), match(parts), studentSafe }`. Rewrite `routeToPath` as one lookup and `parsePath`
   as a loop over the record (the `evaluations/:id/<tail>` and `questions/:id/preview` cases stay
   small per-entry matchers; `home` stays the fallback). `router.test.ts` already round-trips every
   route, so this is verified by construction.
2. Derive `STUDENT_ROUTES` from `ROUTES` (`studentSafe: true`) instead of restating five names.
3. In `App.tsx`, replace the ternary chain with a `PAGES: Record<Route["view"], (route, ctx) => ReactNode>`
   beside the `lazy()` declarations it already has, and keep the four full-screen guards as one
   `FULL_SCREEN` set. `App` drops to a `me` gate, a role computation and one lookup.

**Risk.** Medium — it is the routing. Mitigated by the existing round-trip test and three
separately mergeable steps.
**Tests.** `router.test.ts` (round trip over every `Route`), `router.test.tsx`
(`useRoute`/`useSearchParam`), `App.test.tsx`, `studentView.test.tsx`, `Shell.test.tsx`.
**Constraint.** Invariant 3 — the `devUi` view must stay behind `import.meta.env.DEV`
(`App.tsx:227`); it moves into the table entry, not out of existence. The `replaceState` rule at
`App.tsx:164-170` depends on `STUDENT_ROUTES`, so steps 2 and 3 land together or the address bar
changes.

---

### FC-06 — `RichText` is a 942-line function at CC 40
**CC · LOC ±0, moves ~430 out of one function · risk medium · confidence high**

`apps/web/src/markdown/RichText.tsx:187` — 942 lines, CC 40, the worst function in the web app.
In one body: 12 `useState`, 9 refs, the whole `useEditor({...})` configuration (~294 lines,
including `editorProps.handleKeyDown` at `:324`, itself CC 31 over 115 lines, plus `handlePaste`,
`handleDrop`, `handleClickOn` and the `onUpdate` bookkeeping for empty formulas and empty holes),
then the toolbar action table, the shortcut strip, the table menu, the source-pane toggle and
~330 lines of JSX.

**Refactoring** (pure extraction, no behaviour and no rendered-output change):
- `markdown/richTextKeys.ts` — `handleRichTextKeyDown(view, event, deps)` as a free function over
  `{ inline, onTab, onEnter, openFormula, holes }`. Removes CC 31 from the component and becomes
  unit-testable against a ProseMirror state, which today needs a full render.
- `markdown/useRichTextEditor.ts` — the `useEditor({...})` call and its `editorProps`, taking the
  refs it already reads through refs. ~294 lines out.
- `markdown/useClozeHole.ts` — `hole`, `hoverPreview`, `selectionPreview`, `emptyHoles`, plus the
  `holeAnchor`/`emptyClozeHoles` helpers already at file scope (`:151-186`).
- `markdown/useFormulaTarget.ts` — `formula`, `Dialog`, `openFormula`, `emptyCount`, `emptyMath`.
- `markdown/RichTextToolbar.tsx` — the `ACTIONS` table, the shortcut strip, the `toolbarRow` JSX.

Target: `RichText` ~250 lines of composition at CC ≤ 12, five units each under CC 15.
**Tests.** `markdown/RichText.test.tsx` (908 lines) and `markdown/roundtrip.test.ts` (772 lines)
are a strong net — the reason this is worth doing and only medium risk.
**Constraint.** DESIGN.md › Components › RichText describes the behaviour in detail (fence
handling, the image bar, `Ctrl+Enter` in an inline field, the hole chip). Nothing there may move;
only where the code lives.

---

### FC-07 — Seven "form dialog" components repeat the same 18 lines of footer and error
**DRY · LOC −85 · risk low · confidence high**

Three in the core file alone, identical apart from the endpoint and two labels:
`TeacherHome.tsx:73` `NewCourseModal`, `:132` `NewClassroomModal`, `:193` `AddStaffModal`.

```tsx
// TeacherHome.tsx:89-102                          // TeacherHome.tsx:151-164
footer={<>                                         footer={<>
  <Button variant="secondary" onClick={onClose}>     <Button variant="secondary" onClick={onClose}>
    {t("common.cancel")}                               {t("common.cancel")}
  </Button>                                          </Button>
  <Button onClick={() => create.mutate()}            <Button onClick={() => create.mutate()}
    loading={create.isPending}                         loading={create.isPending}
    disabled={form.name.trim() === "" …}>              disabled={form.name.trim() === ""}>
    {t("courses.newAction")}                           {t("common.create")}
  </Button></>}                                      </Button></>}
…
{create.isError ? (<p className="text-[13px] text-danger">
   {apiErrorMessage(create.error, t("courses.createFailed"))}</p>) : null}   // identical at :122 and :183
```

Four more outside the core, same shape: `ClassroomView.tsx:157` `PeriodModal`,
`pool/PoolsPage.tsx:230` `PoolFormModal`, `pool/PoolView.tsx:133` `NewQuestionModal`,
`evaluation/EvaluationList.tsx:47` `NewEvaluationModal`. The error paragraph alone is copy-pasted
with the exact class string `text-[13px] text-danger` at 18 sites.

**Refactoring.** Add to `ui.tsx`: `<FormError error fallback />` (the paragraph, once) and
`<FormDialog title submitLabel onSubmit pending disabled error errorFallback onClose>` wrapping
`Modal`, owning the Cancel/Submit footer and the `FormError`. Cancel always reads
`t("common.cancel")`; submit is the only variable label. Each call site loses 16-20 lines; the
primitive costs ~40. Behaviour identical — the footer JSX is identical.
**Tests.** `TeacherHome.test.tsx`, `ClassroomView.test.tsx`, `pool/PoolsPage.test.tsx`,
`evaluation/EvaluationList.test.tsx`; add a `FormDialog` case to `ui.test.tsx`.
**Constraint.** DESIGN.md › Sheet/Dialog: *"Dialog: centered, ≤ 480 px, for confirmations and
one-field forms"* — `FormDialog` must not become the way a five-field form gets a dialog. Give it
the `size` prop `Modal` already has and leave the rule where it is.

---

### FC-08 — Four hand-rolled `localStorage` readers, three of which throw in a private window
**DRY · LOC −35 and a robustness fix · risk very low · confidence high**

`TeacherHome.tsx:60-71` and `pool/PoolsPage.tsx:76-87` are the same twelve lines with two
identifiers renamed:

```ts
// TeacherHome.tsx:60                          // PoolsPage.tsx:76
function useCoursesView(): [CoursesView, …] {  function usePoolsView(): [PoolsView, …] {
  const [view, setView] = useState(() =>         const [view, setView] = useState(() =>
    localStorage.getItem(VIEW_KEY) === "list"      localStorage.getItem(VIEW_KEY) === "list"
      ? "list" : "cards");                           ? "list" : "cards");
  return [view, (v) => {                         return [view, (v) => {
    localStorage.setItem(VIEW_KEY, v);             localStorage.setItem(VIEW_KEY, v);
    setView(v); }]; }                              setView(v); }]; }
```

`poll/PollLauncher.tsx` (`ROOM_KEY`) and `pool/PoolNav.tsx` (`NAV_KEY`) are two more variants.
Only the fifth, `pool/PoolView.tsx:87-96`, wraps the access:

```ts
/** Reading storage may throw (private window, blocked site data): never fatal. */
function readPref(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
```

The same author already found the failure mode and fixed it in one place out of five. In a Safari
private window or with site data blocked, `TeacherHome`, `PoolsPage`, `PollLauncher` and `PoolNav`
throw during render.

**Refactoring.** One `useStoredState<T extends string>(key, fallback, isValid?)` in the core
(`theme.ts` is the natural neighbour, or a new `storage.ts`), with `PoolView`'s try/catch as the
universal behaviour. Replace the five sites; fold `notify.tsx:32-48` (`notifyPrefs`) and
`i18n.tsx:3879` onto the same two primitives (`readStored`/`writeStored`) even where the hook
itself does not fit.
**Tests.** `TeacherHome.test.tsx` already asserts `localStorage.getItem("quiz-courses-view")`;
`Shell.test.tsx` does the same for `quiz-pools-nav`. Add a case that stubs
`localStorage.getItem` to throw and asserts the page still renders.
**Constraint.** None; the storage keys must not change or a teacher loses their remembered view.

---

### FC-09 — `NAMED_EVENTS` restates the `ServerEvent` union by hand
**SSOT · LOC −14 and compile-time safety · risk very low · confidence high**

The server names every non-hint frame after its own discriminant:

```ts
// apps/api/src/modules/realtime/routes.ts:74
write(stream, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, now);
```

The browser subscribes to a hard-coded list of twelve:

```ts
// apps/web/src/realtime/useEventStream.ts:33-46
export const NAMED_EVENTS = ["snapshot", "clock", "evaluation.state", "attempt.deadline",
  "attempt.closed", "dashboard.cell", "dashboard.presence", "dashboard.attempt",
  "poll.tally", "lobby.count", "runner.result", "grading.progress"] as const;
…
for (const name of NAMED_EVENTS) es.addEventListener(name, …);   // :128
```

`ServerEvent` (`packages/contracts/src/realtime.ts:233`) has thirteen members. A fourteenth added
to contracts compiles everywhere and is silently never delivered to the browser — nothing breaks.
(`packages/contracts/src/realtime.ts:251` already derives `STAFF_ONLY_EVENTS` as a literal array
for a different job, so the precedent is one file away.)

**Refactoring.** In `packages/contracts/src/realtime.ts`:

```ts
export const SERVER_EVENT_NAMES = ServerEvent.options
  .map((o) => o.shape.type.value)
  .filter((n) => n !== "hint");
```

and have `useEventStream` import it. Delete the local array.
**Tests.** `realtime/useEventStream.test.tsx`; add a contracts test asserting
`SERVER_EVENT_NAMES` covers every option but `hint`.
**Constraint.** Invariant 7 (one schema, both sides).

---

### FC-10 — ~70 inline query keys, one typed key module, one endpoint written four times
**SSOT · LOC −40 · risk low · confidence high**

Query keys are string literals at every site. Counted across `apps/web/src`: `["pools"]` 9 ×,
`["courses"]` 9 ×, `["pool", id]` 8 × (and `["pool"]` 2 × — a *different* key that only
invalidates by prefix by accident), `["results", id]` 6 ×, `["grading", id]` 5 ×, `["me"]` 5 ×,
`["classroom", id]` 4 ×. The correct pattern already exists, for one module only:

```ts
// apps/web/src/evaluation/common.ts:52-55
export const evaluationsKey = (classroomId: string) => ["evaluations", classroomId] as const;
export const evaluationKey = (id: string) => ["evaluation", id] as const;
export const dashboardKey = (id: string, includeAnswers: boolean) => ["dashboard", id, includeAnswers] as const;
```

Separately, `PATCH /app/api/me` is written four times with four different invalidations:

```
apps/web/src/SettingsPage.tsx:48   api("/app/api/me", { method: "PATCH", body: JSON.stringify({ mcqPolicy }) })
apps/web/src/SettingsPage.tsx:85   api("/app/api/me", { method: "PATCH", body: JSON.stringify({ dateFormat }) })
apps/web/src/i18n.tsx:3889         void api("/app/api/me", { method: "PATCH", body: JSON.stringify({ locale: l }) }).catch(() => {})
apps/web/src/AvatarEditor.tsx:269  api("/app/api/me/avatar", { method: "PUT", body: blob })
```

And two screens fall back to a blanket `qc.invalidateQueries()` with no key at all —
`ClassroomView.tsx:82` and `:229` — which drops every cache entry on the page.

**Refactoring.** `apps/web/src/queryKeys.ts` with the ~14 families the app uses, promoting
`evaluation/common.ts`'s three into it. Then a `useMePatch()` beside `useMe()` in `api.ts` used by
the three `PATCH /me` sites. Replace the two blanket `invalidateQueries()` with the two keys they
mean (`keys.classroom(id)`, `keys.courses`).
**Tests.** `SettingsPage.test.tsx` (asserts the PATCH body), `ClassroomView.test.tsx`,
`live.test.tsx` (counts refetches of `/app/api/me` — the blanket-invalidate change is visible
there).
**Constraint.** `.claude/skills/quiz-ui/SKILL.md` rule 9 (a UI change never alters a query key) —
so this is a dedicated commit, and the key *values* stay byte-identical.

---

### FC-11 — `apiErrorMessage` plumbing repeated at 42 sites in two shapes
**DRY · LOC −60 · risk very low · confidence high**

Shape A, the error toast, 24 sites, character-identical apart from the key:

```ts
onError: (error) => toast(apiErrorMessage(error, t("error.save")), "error"),               // pool/PoolsPage.tsx:152
onError: (error) => toast(apiErrorMessage(error, t("classrooms.renameFailed")), "error"),  // ClassroomView.tsx:83
onError: (error) => toast(apiErrorMessage(error, t("grading.run.failed")), "error"),       // grading/GradingPanel.tsx:235
```

Shape B, the inline paragraph, 18 sites (FC-07). Two files have already invented a local helper
each, with the same name and different bodies:

```ts
apps/web/src/question/VersionHistory.tsx:91   const fail = (error: unknown) => toast(apiErrorMessage(error, t("error.save")), "error");
apps/web/src/pool/CategoryTree.tsx:210        const fail = (error: unknown) => toast(apiErrorMessage(error, t("pool.categoryFailed")), "error");
```

**Refactoring.** In `notify.tsx`, `useErrorToast(): (fallbackKey: keyof Dict) => (error: unknown) => void`,
so a mutation reads `onError: fail("error.save")`. Shape B is `<FormError>` from FC-07. Delete the
two local helpers.
**Tests.** Every screen test asserting an error toast: `pool/PoolsPage.test.tsx`,
`grading/GradingPanel.test.tsx`, `ClassroomView.test.tsx`.
**Constraint.** DESIGN.md › Toast: tones are `success`/`error`/`warning`/`progress`; the helper
hard-codes `"error"`.

---

### FC-12 — "A picture, or initials" is written three times, two without a fallback
**DRY · LOC −35 and one behaviour fix · risk low · confidence high**

```tsx
// ui.tsx:613  Avatar — no onError: a dead IdP picture shows the browser's broken-image glyph
if (me.avatarUrl) return <img src={me.avatarUrl} alt="" className={…} referrerPolicy="no-referrer" />;
```
```tsx
// RosterTable.tsx:35  StudentAvatar — has the fallback
const [failed, setFailed] = useState(false);
if (entry.avatarUrl && !failed) return <img … onError={() => setFailed(true)} />;
return <Initials name={[entry.prenom, entry.nom]} />;
```
```tsx
// TeacherHome.tsx:451  StaffAvatars — inline, no onError, native `title` instead of a Tip
s.avatarUrl ? <img key={…} src={s.avatarUrl} alt={…} title={…} className="size-6 rounded-full object-cover" />
            : <span key={…} title={…}><Initials name={[s.givenName, s.familyName]} … /></span>
```

(A fourth, `OrgAvatar` at `ui.tsx:654`, is dead — FC-02.) The three also disagree on the tooltip:
`Tip` nowhere, native `title` twice.

**Refactoring.** One `<PersonAvatar name={[given, family]} src={url} className={…} />` in `ui.tsx`,
owning the `onError` fallback to `Initials` and a `Tip` with the full name. `Avatar({ me })`
becomes a one-line wrapper. Delete `StudentAvatar` and the inline branch of `StaffAvatars`.
**Tests.** `RosterTable.test.tsx`, `TeacherHome.test.tsx`, `Header.test.tsx`; add an `onError`
case to `ui.test.tsx`.
**Constraint.** DESIGN.md › Keyboard and focus — a hover label carries a `Tip`, never a native
`title` (the *"laggy native title"* the `Tip` docblock at `ui.tsx:372` says it replaces). Fixing
this is part of the change.

---

### FC-13 — `Breadcrumb.tsx` is dead; six pages hand-roll the eyebrow back-link it should be
**YAGNI + DRY · LOC −70 · risk low · confidence high**

`grep -rn "Breadcrumb" apps/web/src` returns two hits: the component itself
(`apps/web/src/Breadcrumb.tsx:6`, 28 lines) and its i18n key (`i18n.tsx:69 "nav.breadcrumb"`).
Nothing imports it. Meanwhile every page needing a parent link writes the same button into
`PageHeader eyebrow`, in **two different class lists**:

```
apps/web/src/ClassroomView.tsx:299            className="hover:text-fg hover:underline"
apps/web/src/results/ResultsView.tsx:167      className="hover:text-fg hover:underline"
apps/web/src/live/LiveDashboard.tsx:300       className="hover:text-fg hover:underline"
apps/web/src/evaluation/EvaluationConfig.tsx:236  className="hover:text-fg hover:underline"
apps/web/src/pool/PoolView.tsx:373            className="text-fg-muted transition-colors hover:text-fg"
apps/web/src/question/QuestionEditor.tsx:480  className="text-fg-muted transition-colors hover:text-fg"
```

Four underline on hover, two do not; four have no transition, two do. That is the drift DESIGN.md's
opening line is written against, on six of the app's main screens.

**Refactoring.** Delete `Breadcrumb.tsx` and the `nav.breadcrumb` key (× 2). Add
`<ParentLink label onClick />` to `ui.tsx` — 10 lines, one class list — and use it at the six sites
(three in this scope). Pick the class list DESIGN.md implies: the eyebrow is
`text-[13px] text-fg-muted` set by `PageHeader` (`ui.tsx:1600`), so the link adds only
`transition-colors hover:text-fg`; the underline goes, since nothing else in the chrome underlines
on hover.
**Risk.** Two of the six sites lose a hover underline — a DESIGN.md consistency decision, so it
belongs in a commit that says so, with the screenshots the skill requires.
**Tests.** `ClassroomView.test.tsx`, `pool/PoolView.test.tsx`, `results/ResultsView.test.tsx` (all
assert the eyebrow's accessible name).
**Constraint.** `.claude/skills/quiz-ui/SKILL.md` rule 2 — a new variant is an extension of a
primitive, not a one-off class list — and the visual-check step.

---

### FC-14 — Five copies of the listbox keyboard handler, two of the roving-tabindex one
**DRY · LOC −60 · risk low · confidence high**

"ArrowDown/ArrowUp with wrap, Home/End to the ends, Enter runs" is written five times:

```ts
// CommandPalette.tsx:102                     // question/TagInput.tsx:129
if (e.key === "ArrowDown") {                  if (e.key === "ArrowDown") {
  e.preventDefault();                           e.preventDefault(); setOpen(true);
  if (n) setActive((i) => (i + 1) % n);         if (rows) setActive((i) => (i + 1) % rows);
} else if (e.key === "ArrowUp") {             } else if (e.key === "ArrowUp") {
  e.preventDefault();                           e.preventDefault(); setOpen(true);
  if (n) setActive((i) => (i - 1 + n) % n);     if (rows) setActive((i) => (i - 1 + rows) % rows);
```

plus `ui.tsx:1142` (`Menu`), `pool/TeacherPicker.tsx:78` and `pool/FilterBar.tsx:265` — the last
two byte-identical to `TagInput`'s. And the roving variant ("ArrowRight/ArrowLeft/Home/End with
wrap") twice inside `ui.tsx` alone: `ui.tsx:1767-1780` (`Tabs`) and `ui.tsx:2765-2780`
(`ProgressSegments`). Beyond the keys, `TagInput`, `TeacherPicker` and `FilterBar`'s type filter
are the same *component*: an input, a portalled list, an `active` index,
`aria-activedescendant`, close on Escape, pick on Enter.

**Refactoring.** Two pure helpers in `ui.tsx`, trivially testable:

```ts
export function listboxIndex(key: string, active: number, count: number): number | null
export function rovingIndex(key: string, current: number, count: number): number | null
```

returning `null` for a key they do not own, so each call site keeps its own `preventDefault` and
side effects. Collapses `Tabs` and `ProgressSegments` inside `ui.tsx` (−25) and the four listbox
sites (−35). A full `<Combobox>` primitive is the larger prize, but its three consumers are in the
feature folders — propose the helpers now, the primitive as a follow-up.
**Tests.** `ui.test.tsx` (Tabs arrow/Home/End, ProgressSegments roving), `CommandPalette.test.tsx`,
`question/TagInput.test.tsx`; add direct unit tests for the two helpers in `ui.test.ts`.
**Constraint.** DESIGN.md › Keyboard and focus fixes the exact semantics per component (Tabs roving
with wrap, the palette's virtual focus never leaving the input, `Menu`'s WAI-ARIA menu-button
pattern). The helpers unify the index arithmetic, never the semantics.

---

### FC-15 — `ui.tsx` cannot become `packages/ui`: it imports the app and cycles with `help.tsx`
**ARCH · LOC ±0 · risk medium · confidence high**

`CLAUDE.md` lists `packages/ui` as the next package to create (`docs/spec/05-architecture.md` 5.2,
`docs/PLAN-MVP.md` §8), and `docs/spec/08` §8.4 puts the command registry there too. Today's
`ui.tsx` cannot move:

```ts
apps/web/src/ui.tsx:42   import { apiErrorMessage } from "./api";   // used only by QueryError
apps/web/src/ui.tsx:43   import { HelpIcon } from "./help";         // PageHeader, SectionHeading, FieldLabel, SettingRow
apps/web/src/ui.tsx:44   import { useI18n, useT } from "./i18n";    // ~10 components
```

and `help.tsx` imports straight back:

```ts
apps/web/src/help.tsx:6  import { humanize, Tip, useLayer, Z } from "./ui";
```

— a genuine module cycle (`ui → help → ui`), which works only because both sides use the other
lazily at render time. `i18n.tsx` in turn imports `./api` (`i18n.tsx:3`), so `ui.tsx` transitively
depends on the HTTP client and the session.

At 2 974 lines the file also mixes four concerns with no reason to share a module: layer plumbing
(`useLayer`, `useScrollLock`, `focusableIn`, `Z`, `Modal`, `Sheet`, `Menu`, `Tip` — ~900 lines),
form controls (~500), page structure (~400) and the live primitives (`Countdown`, `Ring`,
`ProgressSegments`, `VerdictCell`, `SyncBadge` — ~520, and the file itself marks them
`// --- Live primitives (PLAN-MVP §6.4) ---` at `ui.tsx:2452`).

**Refactoring** (three cuts, each independently mergeable, none changing rendered output):
1. **Break the cycle.** `HelpIcon` is placed *by the primitive*, which is the right decision
   (DESIGN.md › Help "?"), so do not move that responsibility — move the 20 lines of `HelpIcon`
   into `ui.tsx` and leave `help.tsx` with the drawer and the topic index. (Alternative: a
   `HelpSlotContext` filled by `HelpProvider`; smaller is better here.)
2. **Untangle `api`.** `QueryError` takes `error: unknown` and calls `apiErrorMessage`. Either make
   it take `message: string` with the ~29 call sites passing `apiErrorMessage(error, …)`, or keep
   the convenience wrapper in the app and move the presentational `Alert` half into the package.
3. **Split the file** along the four comment banners it already carries: `ui/layers.tsx`,
   `ui/controls.tsx`, `ui/page.tsx`, `ui/live.tsx`, with `ui.tsx` re-exporting everything so not
   one import in the app changes. The barrel keeps the commit mechanical and reviewable.

For i18n, the package boundary is a `t` prop or an injected translator context — exactly the
pattern `questionTypes.tsx` already proves for the `qt-*` packages
(`translated(t, defaults, prefix)`, `questionTypes.tsx:126`).
**Tests.** `ui.test.tsx` (1 292 lines) and `ui.test.ts` (206) cover step 3 for free since the
barrel keeps every import path; `help.test.ts` covers step 1; the 29 `QueryError` sites are covered
by their screens' tests for step 2.
**Constraint.** DESIGN.md is the contract for every value in these files and must not change;
invariant 1 means the package cannot hold English literals (FC-20).

---

### FC-16 — `i18n.tsx` is 3 922 lines and ships both dictionaries to every reader
**ARCH / KISS · LOC ±0, ~90 KB of source off the first chunk · risk low · confidence medium-high**

`apps/web/src/i18n.tsx` is 193 763 bytes: `en` at lines 26-1944, `fr` at 1948-3853, 70 lines of
provider. Both objects are static imports in the module the whole app loads first, so a French
teacher downloads the English dictionary and vice versa. It is also the largest file in the
repository and the one every feature touches — the top merge-conflict source for the
concurrent-agent workflow `AGENTS.md` describes.

**Refactoring.** `src/i18n/en.ts` (exports `en` and `export type Dict = typeof en`),
`src/i18n/fr.ts` (`const fr: Record<keyof Dict, string>` — the compile-time guarantee of invariant 1
is preserved exactly, one `import type` away), `src/i18n/index.tsx` (the provider, `t`, `LOCALES`,
`formatDuration`). Same public API, no call site changes. Then, separately, make `fr` an
`import("./fr")` resolved by the provider on first use, with `en` synchronous as the fallback — the
provider already has an async path (`i18n.tsx:3888`).
**Tests.** `test/render.tsx` seeds the locale through `quiz-locale`; every `*.test.tsx` rendering
French text catches a broken split. Keep the FC-01 unused-key test pointed at `i18n/en.ts`.
**Constraint.** Invariant 1: `fr` stays `Record<keyof Dict, string>`; a missing French key stays a
compile error. If the lazy step is taken, the *type* must still be static — only the value is
deferred.

---

### FC-17 — `mock/index.ts` is a 5 839-line second implementation of the API, checked by nothing
**ARCH · LOC ±0, +40 for a test · risk low · confidence high**

One file, 122 route handlers (`grep -c '^on(' mock/index.ts`) against the API's ~224 routes,
reimplementing the session, courses, roster, pools, questions, evaluations, live dashboard, poll and
student player, plus its own grading and its own ngspice fixture. Sixteen of the app's 43 CC > 10
functions live in it. It is 30 % of the source in scope.

It is **not** waste: `.claude/skills/quiz-ui/SKILL.md` makes `pnpm dev:mock` the mandatory
visual-check path, `apps/web/scripts/screenshots.mjs` drives it, and it is correctly kept out of
production (`main.tsx:21`, static flag, dead branch dropped by Vite). The problem is that its
responses are validated against nothing. The SSE frames are — the header comment says real UUIDs
are used *"because those are validated in the browser against `ServerEvent` and `DashboardView`
(invariant 7)"* — but the 122 JSON responses are hand-written objects that can drift from
`packages/contracts` silently, and a drifted mock means a screenshot of a screen that cannot exist.

**Refactoring.** No LOC to save; two changes that pay for themselves:
1. Split into `mock/{session,pool,evaluation,live,poll,student}.ts` + `mock/index.ts` (the router
   and the flags), mirroring `apps/api/src/modules/`. The file already labels these four sections in
   its header comment; this makes them files, and removes the worst merge-conflict surface after
   `i18n.tsx`.
2. Add `mock/contract.test.ts`: walk the route table, call each `GET` handler, `safeParse` the
   result against the matching schema from `@quiz/contracts`. ~40 lines, and it turns 5 839 lines of
   unverified duplicate into verified duplicate.

**Tests.** The new one; `apps/web/src/*.test.tsx` do not use the mock (they use `test/render.tsx`'s
`mockFetch`), so the split is invisible to them.
**Constraint.** Invariant 7 — extends it to the mock, the only place it is not enforced today.
Invariant 3 — the mock stays behind `VITE_MOCK` and never reaches production.

---

### FC-18 — 43 dead exports and one unused dependency
**YAGNI · LOC −120 · risk very low · confidence high**

Cross-checked two ways (a per-symbol grep across `apps/web` and `packages`, and the `knip` run in
the shared scratchpad). In scope, with no importer anywhere including tests, mocks and the gallery:

| Symbol | Location | Size |
| --- | --- | --- |
| `RangeCalendar` + 4 helpers | `ui.tsx:2314-2452` | 139 (FC-02) |
| `OrgAvatar` | `ui.tsx:654` | 14 |
| `GithubIcon` | `ui.tsx:1364` | 9 |
| `localDateTimeInputValue` | `ui.tsx:763` | 6 (→ reuse, FC-02) |
| `statsStrings` | `questionTypes.tsx:295` | 4 (see FC-22) |
| `EditorSkeleton` | `questionTypes.tsx` | 11 |
| `isKnownType` | `questionTypes.tsx:100` | 3 |
| `ASSET_BASE` | `markdown/render.ts` | 2 |
| `languageFamily` | `markdown/highlight.ts` | 3 |
| `HOLE_PIPE`, `clozeHoleChip`, `ClozeHole`, `ClozeHoleChip` | `markdown/clozeHole.ts` | ~20 |
| `draftFromBody`, `bodyFromDraft`, `BlankMode`, `BlankPopoverProps` | `markdown/BlankPopover.tsx` | ~18 |
| `@tiptap/extension-link` | `apps/web/package.json:36` | dependency |

`@tiptap/extension-link` is declared but never imported anywhere in the repo; the link mark comes
from StarterKit, configured at `apps/web/src/markdown/tiptap.ts:539` (`link: { openOnClick: false }`).

A second tier — exported but used only inside its own file — should simply lose the `export`
keyword: `ButtonVariant`, `ButtonSize`, `InputSize`, `CountdownPhase`, `COUNTDOWN_DANGER_S`
(`ui.tsx`), `SEARCH_PARAM_EVENT` (`router.ts:159`), `initialTheme`, `resolveTheme` (`theme.ts`),
`POOL_COMMAND_PREFIX`, `CommandGroupId` (`commands.ts`), `ToastTone` (`notify.tsx`),
`CommandPaletteProps` (`CommandPalette.tsx`). Shrinking the public surface is what makes the next
`knip` run informative.
**Tests.** `pnpm typecheck` is the whole test. `ui.test.ts:43` must lose its `localDateKey` block
with FC-02.
**Constraint.** None; `DevGallery.tsx` renders none of these (it covers 9 of the 45 exported
components).

---

### FC-19 — `Modal` and `Sheet` repeat the same 45-line shell
**DRY · LOC −45 · risk low · confidence medium-high**

`ui.tsx:791-863` (`Modal`) and `ui.tsx:869-931` (`Sheet`) share, line for line: `useScrollLock()`,
`useRef<HTMLDivElement>`, `useId()`, `useLayer(panel, onClose)`, the `createPortal` with
`onClick={(e) => e.stopPropagation()}` on the backdrop (with the same four-line comment, reworded),
`role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}`, the
title/subtitle/`LayerClose` header block, and the conditional footer row. jscpd flags
`ui.tsx:836` ↔ `ui.tsx:909` directly. They differ only in the backdrop's flex alignment, the
panel's width class, the radius, and `Modal`'s `scroll` variant.

**Refactoring.** A private `LayerShell({ title, subtitle, onClose, footer, backdropClass,
panelClass, bodyClass, children })` used by both. `Modal` and `Sheet` keep their exact public props
and their exact class strings — they become the two callers that supply them.
`notifications/NotificationBell.tsx:246` is a third consumer of the same two pieces
(`menuPosition` + `useLayer`, as DESIGN.md › Notification bell says) and jscpd pairs it with
`ui.tsx:1196`; it can take the shell too if the panel classes stay its own.
**Tests.** `ui.test.tsx` has the layer contract suite (focus in, Tab cycle, Escape topmost-only,
focus restore, backdrop behaviour per layer type) — precisely the net this needs.
**Constraint.** DESIGN.md › Keyboard and focus: a **form layer** (`Modal`, `Sheet`, confirm) never
closes on a backdrop click; a **navigation layer** (drawer, help, palette) does. The shell must not
take a `closeOnBackdrop` default that blurs that distinction — pass it explicitly at both sites.

---

### FC-20 — Seven English literals reach the screen from the core primitives
**SSOT (invariant 1 / N-I18N-01) · LOC ±0 · risk very low · confidence high**

```
apps/web/src/ui.tsx:773      <IconButton label="Close" onClick={onClose} …>   // every Modal and Sheet close button
apps/web/src/ui.tsx:1000     label = "More actions",                          // every default Menu trigger
apps/web/src/ui.tsx:1304     aria-label={label ?? "Loading"}                  // Spinner with no label
apps/web/src/ui.tsx:2396     nav(-1, "Previous month")                        // dead with FC-02
apps/web/src/ui.tsx:2401     nav(1, "Next month")                             // dead with FC-02
apps/web/src/confirm.tsx:56  {pending.options.cancelLabel ?? "Cancel"}
apps/web/src/confirm.tsx:63  {pending.options.confirmLabel ?? "Confirm"}
```

The first three are the accessible name of controls on **every** screen; a French screen reader
announces "Close" and "More actions". The keys already exist and are already used elsewhere:
`common.close` (`i18n.tsx:54`), `common.actions` (`:60`), `common.loading` (`:62`),
`common.cancel` (`:53`). `confirm.tsx`'s own docblock admits the gap — *"Labels are the caller's
(student-facing callers pass translated ones)"* — which makes the default a trap rather than a
decision.

**Refactoring.** `LayerClose`, `Menu` and `Spinner` already live in a file that imports `useT`;
call it. For `confirm.tsx`, drop the `??` defaults and translate inside the provider (it renders
under `I18nProvider` in both `main.tsx:40` and `test/render.tsx:56`). Two literals disappear with
FC-02.
**Tests.** `ui.test.tsx` (queries `getByLabelText`), `confirm.test.tsx`; add a `fr`-locale render
asserting the close button's name — English names in a French render are exactly what no current
test looks for.
**Constraint.** Invariant 1, and `.claude/skills/quiz-ui/SKILL.md` rule 7.

---

### FC-21 — Smaller items, grouped
**LOC −40 total (excluding the scripts item) · risk very low**

- **The provider stack is written twice.** `main.tsx:39-49` and `test/render.tsx:54-64` nest the
  same five providers in the same order; the second file's docblock says so (*"the provider stack of
  main.tsx without main.tsx itself"*). Extract `<AppProviders client={…}>` and have both use it: the
  test harness then cannot drift from the app. (DRY, −10)
- **`Nav` takes an `onStartPoll` prop it never reads.** `Shell.tsx:146-169` declares and documents
  it (*"The palette's 'Start a poll': goes to the launcher page"*), both call sites pass it
  (`Shell.tsx:458`, `:500`), and the body never mentions it. Delete the prop and the two arguments.
  (YAGNI, −6)
- **`NOTICE_KINDS` wraps each string in an object for nothing.** `notify.tsx:26` —
  `(Object.keys(NOTICE_DEFAULTS) as NoticeKind[]).map((kind) => ({ kind }))`, consumed as
  `NOTICE_KINDS.map(({ kind }) => …)` at `SettingsPage.tsx:159`, its only reader. Make it the plain
  array. (KISS, −2)
- **`useEscape` allocates a ref it never fills.** `ui.tsx:246` creates `useRef<HTMLElement>(null)`
  only to pass it to `useLayer` with `trap: false`, which never reads it. Give `useLayer` an
  optional panel instead. (KISS, −3)
- **`markdown.tsx` renders only a Markdown subset.** DESIGN.md defends the hand-rolled renderer
  (*"trusted help text turned into React elements, never into HTML"*) and the security argument is
  sound — **keep it** — but it supports only `#`/`##`, `-`, `**`, `` ` `` and links, while the 15
  `help/*.md` files are authored as full Markdown. A test asserting every help source uses only the
  supported subset costs 15 lines and prevents silent mis-rendering.
- **The two screenshot scripts share ~70 lines of Playwright plumbing** (flag parsing,
  `chromium.launch`, `newContext({ colorScheme })`, `addInitScript` for the theme, the write path):
  `scripts/screenshots.mjs:23-30,399-439` and `scripts/docs-screenshots.mjs:88,1130-1184`. The scene
  tables are legitimately different (mock vs seeded real API); only the plumbing is duplicated. A
  `scripts/capture.mjs` saves ~60. Low priority — dev-only, no CI, no bundle.

---

### FC-22 — `mcq`'s answer distribution is wired but never mounted
**YAGNI · LOC −65 or +3 · risk low · confidence high**

`packages/qt-mcq/src/client.tsx:42` registers a lazy `Stats` component,
`packages/qt-mcq/src/Stats.tsx` implements it (57 lines), `apps/web/src/questionTypes.tsx:295`
exports `statsStrings` to translate it, and `i18n.tsx` carries `qt.mcq.s.title`,
`qt.mcq.s.noAnswers`, `qt.mcq.s.respondents` in both locales. Nothing in `apps/web` renders it:
there is no `QuestionStatsHost`, and `results/ByQuestionView.tsx` — the one screen that would show
it — renders `QuestionReviewHost` instead.

**Refactoring.** Decide, do not leave it half-wired. Either mount it in
`results/ByQuestionView.tsx` (a `Stats` host beside the existing `Review` host, ~3 lines plus a host
component modelled on `QuestionReviewHost`), which is what `docs/spec/08` §8.6 *"Statistics in the
pool"* asks for; or delete `Stats.tsx`, the registry slot, `statsStrings` and the 6 dictionary
lines. The spec says the feature is wanted, so mounting is the honest answer — shipping a registry
slot that resolves to nothing is the worst of the three.
**Tests.** `questionTypes.test.tsx` (extend: every registry slot a type declares has a host that
mounts it), `results/ResultsView.test.tsx`.
**Constraint.** Invariant 4 — a `Stats` surface shows an aggregate; it must be fed from the results
payload the server already computes, never from a question's configuration.

---

## 3. Sequenced plan

Each phase is independently mergeable and leaves `pnpm build && pnpm typecheck && pnpm test` green.
Phases 1-2 touch almost no rendered output; phases 3+ need the screenshot pass.

**Phase 1 — Delete (≈ −400 LOC, no behaviour change).** FC-02, FC-18, FC-01, the dead `Breadcrumb`
half of FC-13, FC-21's `onStartPoll` and `NOTICE_KINDS`. Add the i18n unused-key test from FC-01 in
the same commit, or the keys come back. One commit per bullet so a bisect is readable.

**Phase 2 — Single-source the knowledge (≈ −100 LOC).** FC-09 (`SERVER_EVENT_NAMES`), FC-04
(`typeLabel`), FC-03 (one command registry), FC-10 (`queryKeys.ts` + `useMePatch` + the two blanket
invalidations), FC-20 (translate the seven literals), FC-21's `AppProviders`. FC-04 and FC-20 change
visible text, so they carry the screenshots.

**Phase 3 — Extract the repeated primitives (≈ −280 LOC).** FC-11 (`useErrorToast`, `FormError`),
FC-07 (`FormDialog`, three core sites first, then the four feature sites in a second commit the
other audit can own), FC-08 (`useStoredState`), FC-12 (`PersonAvatar`), FC-13's `ParentLink`, FC-14
(the two index helpers). Every one adds to `ui.tsx`/`notify.tsx` before removing from call sites, so
land the primitive and its test first.

**Phase 4 — Decompose the two hotspots (LOC ≈ 0, CC 40 → 12 and 36 → 8).** FC-06 (`RichText`, five
extractions, one commit each — the 1 680 lines of RichText tests are the gate), then FC-05 (the
`ROUTES` table, three commits: `router.ts`, then `studentView.ts`, then `App.tsx` + `Shell` +
`commands`). FC-05 last because everything above touches `commands.ts` and `App.tsx`.

**Phase 5 — Structure for `packages/ui` (LOC ≈ 0).** FC-19 (`LayerShell`), FC-15 step 1 (break the
`ui ↔ help` cycle), step 2 (`QueryError` loses `api`), step 3 (split `ui.tsx` behind a re-export
barrel), FC-16 (split `i18n.tsx`), FC-17 (split `mock/index.ts` + the contract test). Only after
this is `packages/ui` a move rather than a rewrite.

**Phase 6 — Decide, do not defer.** FC-22 (`mcq` stats: mount or delete), FC-21's help-source subset
test, FC-21's `scripts/capture.mjs`.

---

## 4. Keep as is

- **`api.ts` (72 lines).** CSRF, blob/FormData/CSV content types, 204 → `undefined`, a typed
  `ApiError`, `useMe` swallowing only the 401. Nothing to remove, nothing missing.
- **`useLayer` / the layer stack (`ui.tsx:140-262`).** The focus restore deferred by one frame and
  cancelled on remount (the StrictMode replay), the topmost-only Escape, the `opener` captured
  during render rather than in the effect — every line is a bug someone already paid for, and the
  comments say which. Do not "simplify" it.
- **The hand-rolled router (200 lines).** A dependency (TanStack Router, wouter) would cost more
  than it saves for 16 static routes with no nesting and no loaders. FC-05 improves its internals,
  not its existence. The `SEARCH_PARAM_EVENT` custom event at `router.ts:159` looks like a hack and
  is the correct one: `replaceState` emits no `popstate`, and two hooks on the same parameter must
  agree.
- **`fuzzy.ts` (36 lines).** Subsequence match with a streak bonus and diacritic folding, used by
  the palette and the icon catalogue. Fuse.js is 12 kB for a worse fit.
- **`theme.ts` and `studentView.ts`.** jscpd pairs them (`studentView.ts:34` ↔ `theme.ts:31`) —
  14 lines of `useSyncExternalStore` boilerplate. They are deliberately *different* stores
  (localStorage vs sessionStorage, the reason documented at `studentView.ts:38-46`), and a shared
  `makeStore` would save 10 lines while hiding that distinction. Leave them.
- **`markdown.tsx`.** See FC-21: the "two renderers" smell is a real security boundary.
- **`DevGallery.tsx` (311 lines) and the mock layer's existence.** Both mandated by
  `.claude/skills/quiz-ui/SKILL.md`. FC-17 asks the mock to be split and checked, not deleted.
  (Minor: the gallery has three untranslated headings — `"Circuit: schematic editor"`,
  `"Circuit: schematic view and waveforms"`, `"Sine, 1 kHz"` — acceptable in a dev-only page, one
  line each to fix while you are in FC-20.)
- **`questionTypes.tsx`'s `translated(t, defaults, prefix)` bridge.** It looks like magic
  string-building, but it is what lets a `qt-*` package own its key names while the app owns the
  translations (a `qt-*` package never imports the app), and `questionTypes.test.tsx` turns a
  renamed key into a failure. The 260 "surplus" duplicate values in §1 are mostly this, by design.
- **`style.css` (426 lines).** Every token in DESIGN.md's table, every class used (`tip-bubble`,
  `layer-backdrop`, `dialog-panel`, `sheet-panel`, `menu-panel`, `toast-enter/leave`,
  `progress-bar`, `.md-body`, `.md-sm`, `.md-img-*`, `.tok-*` all have live readers). No dead CSS.
- **`shortcuts.tsx`'s two registries (`globals` vs `registry`).** Unlike FC-03, these are genuinely
  two things: the frame's keys must lead the strip whatever order the effects ran in, and a child's
  effect fires before its parent's. The docblock at `shortcuts.tsx:79` explains it and is right.

---

## 5. Estimated reduction by principle

| Principle | Findings | Est. LOC removed | Notes |
| --- | --- | --- | --- |
| **YAGNI** | FC-01, FC-02, FC-18, FC-13 (half), FC-22, FC-21 (partial) | **≈ 480** | Pure deletion; `pnpm typecheck` is the proof |
| **DRY** | FC-07, FC-11, FC-14, FC-19, FC-08, FC-12, FC-13 (half), FC-21 | **≈ 385** | Net of ~120 LOC of new primitives in `ui.tsx` / `notify.tsx` |
| **SSOT** | FC-03, FC-04, FC-09, FC-10, FC-20 | **≈ 110** | Value is the compile-time guarantee, not the lines |
| **CC** | FC-05, FC-06 | **≈ 30** | `RichText` 40 → ~12, `App` 36 → ~8, `parsePath` 26 → ~6, `routeToPath` 19 → ~4, `buildCommands` 27 → ~12 |
| **KISS** | FC-21 (`useEscape`, `NOTICE_KINDS`), FC-16 | **≈ 10** | Plus ~90 KB of dictionary off the first chunk |
| **ARCH** | FC-15, FC-16, FC-17 | **0** | 3 files of 2 974 / 3 922 / 5 839 lines become ~14; unblocks `packages/ui` |
| **Total** | | **≈ 1 015 LOC** | ≈ **5.2 %** of the 19 452 non-test LOC in scope |

Functions over CC 10 in scope drop from **27 to ~18** (43 → ~30 counting `mock/`); functions over
150 lines from **14 to ~8**.

---

Helper scripts used for the quantitative claims are in the scratchpad and re-runnable:
`keys3.mjs` (unused i18n keys) and `exports.mjs` (unused exports), both cross-checked against the
shared `knip.md` and `clones.md`.