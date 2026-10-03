[Audit overview](README.md) · [Ordered work catalogue](plan.md)

# Packages, runner, extensions and scripts audit

Scope reviewed read-only at `/tmp/heig-quiz-code-quality-audit`. No repository file edited, no tests run. All 15 workspace packages and runner/extensions/scripts inventoried. Metrics use the [shared measurement convention](methodology.md), including nullish operators.

## Scope challenge

**GO.** N-QUAL-01–04 support a quality audit and an actionable behavior-preserving plan. No product answer is necessary to investigate quality. Preserve student content filtering, server clock, runner isolation and dependency boundaries. Q22 (per-case visible-run timing), Q29 (diagram versus schematic engine), Q40–42 (parameter policies) must not be silently settled as deduplication. An algorithm with many explicit cases is not intrinsically poor code. Distinguish deleting duplication, splitting responsibilities, and delivering pending features.

## Validated opportunities / bounded implementation plan

### PKG-01 — Diagram editor gesture responsibilities (high-value, modest/no size reduction)

Evidence: `packages/diagram/src/editor/DiagramEditor.tsx:93` starts a 459-line component; `:221` onPointerDown, `:313` onPointerMove, `:360` onPointerUp, `:410` onKeyDown couple hit testing, tool dispatch, drag refs, history, view and JSX in one closure. Measured CC: DiagramEditor 43, pointer-down 38. The circuit editor already has an effective local precedent: `packages/qt-circuit/src/canvas/SchematicEditor.tsx:22` documents separate `useViewport`, `useSelection`, `usePartDragging`, `useWireDrawing`, `usePointerTools` responsibilities.

Action: extract **diagram-local** gesture commands/transitions with explicit scene/tool/drag inputs and a small editor adapter; split rendering/tool dispatch at existing boundaries. Do not introduce an engine shared with circuit: its bounded geometry/physical ports differ, and Q29 is open. Preserve one undo/save per gesture and live temporary scene semantics.

Done when: gesture cases can be tested without mounting the entire editor; no single pointer dispatcher retains all pan/place/resize/via/link/move/ink behavior; equivalent scenes/history and readonly behavior. Focus tests: existing `packages/diagram/src/editor/components.test.tsx`, `ops.test.ts`, `layout.test.ts`; add behavioral cases for pointer capture/cancel, read-only pan, double click versus drag, undo one gesture, keyboard scope. Net physical source deletion estimate **0–40 lines**; allow **+30–100** if explicit types/adapters cost more. This is a complexity gain, not a promised LOC win.

### PKG-02 — Identical priority queue, distinct routers (confirmed duplication)

Evidence: numeric binary `Heap` at `packages/diagram/src/layout.ts:176` and `packages/qt-circuit/src/canvas/router.ts:35`, same arrays, push and pop, exact clone. Shared dependency `@quiz/core` already exists in both packages. Neighboring A* implementations differ: diagram `layout.ts:227` searches growing margins [6,20,60], circuit router declares fixed GW/GH and bound clipping at `router.ts:22`. Do not deduplicate the entire A* search.

Action: one small deterministic numeric min-heap in an existing dependency's neutral utility module, with explicit export; replace both private copies. No new workspace/package/framework. Keep deterministic equal-priority behavior and empty-pop behavior.

Tests: existing diagram layout cases and circuit `router.test.ts` / `router.golden.test.ts`; focused queue property cases (sorted extraction, interleaved push/pop, ties). Estimate **35–45 net production lines removed**, after imports/export and retaining one implementation. Test code may grow. Reject if the proposed helper forces diagram↔qt-circuit or domain/UI dependencies.

### PKG-03 — Circuit numeric editor boilerplate (verified repetition; prototype-gated)

Evidence: `packages/qt-circuit/src/Editor.tsx:649` AnalysisFields repeats six NumberField configurations; `:955` SourceFields repeats eleven. Same id/label/value/disabled/step/update plumbing, with meaningful differing min/max/width/step and discriminated source variants. Entire file is 1,084 lines but already contains named local components: splitting files alone removes nothing.

Action: a **local typed field helper** (not a schema-driven form engine) capturing id prefix, disabled and patch while each variant explicitly names fields and limits. Keep switch narrowing, exact labels/id suffixes, invalid-draft editing and separate AC/transient defaults. Prototype SourceFields first and retain only if code is shorter and types need no casts.

Tests: `packages/qt-circuit/src/Editor.test.tsx`, schema tests and existing source/analysis fixtures; parameterized edits for dc/sine/pulse/step and AC/transient, disabled state and field bounds. Estimate **45–80 net lines removed** across the two functions; tentative until typed prototype. Do not claim the whole editor shrinks by hundreds of lines.

### PKG-04 — Program canonical mapping ownership (confirmed small duplication)

Evidence: `packages/qt-code/src/canonical.ts:46–54` and `src/image/canonical.ts:25–32` separately omit the same runtime/cooldown/files/compiler/reference defaults. Limits differ (`DEFAULT_IMAGE_LIMITS.outputKb` versus ordinary DEFAULT_LIMITS), action/allOrNothing/tests are code-only. Program UI and shape are already shared through ProgramEditor/ProgramPlayer/programFields; this is the remaining serialization edge.

Action: a narrow program-to-canonical helper in the same package, parameterized by default limits, used by both mappings. Retain independent fromCanonical schemas and image/code content. Preserve field omission versus explicit values and cloned file arrays.

Tests: `packages/qt-code/src/canonical.test.ts` and `packages/qt-code/src/image/schema.test.ts:108` canonical round-trip assertions, with non-default output limits and all shared optional fields. Estimate **5–15 net lines removed**; low priority unless serialization changes anyway. Do not introduce a generic object serializer to save seven lines.

### PKG-05 — Test case limit owns one name (confirmed SSOT drift risk, no size win)

Evidence: `packages/qt-code/src/generate.ts:17` independently declares `MAX_CASES = 30`, enforced at `:68`; `src/schema.ts:187` separately hardcodes `.max(30)`. Compare existing correct practice: qt-mcq `MCQ_MAX_CHOICES` and qt-categorize exported max constants used by generators.

Action: export a named code-case cap from the owning schema and import it in the generator. Do not unify other unrelated 30-valued budgets (runsPerMinute, component caps).

Tests: existing code generation boundary/merge tests and schema acceptance at cap/cap+1. **0 net reduction** (possibly +1–3 lines). Value is one policy source.

### PKG-06 — Pure locked-layout versus Monaco adapter (validated responsibility boundary)

Evidence: `packages/qt-code/src/LockedEditor.tsx:95–257` exports layoutProgram, regionsFromLayout, checkLayout, realignLayout, minimalEdit, markerLineNumbers, insideEditable. The same TSX file then defines stateful Monaco `LockedSession` (`:273`) and React fallback/rendering (`:505`, `:548`). Pure layout consumers/tests currently import the UI file, and layout invariants are obscured by adapter lifecycle.

Action: move pure layout functions/types into a local non-React module; keep existing named reexports if needed for callers; separate Monaco session only if its lifecycle can be given one owner without broad API churn. Never replace server reconstruction with client locking: locked UI is convenience, not the security boundary.

Tests: `LockedEditor.test.tsx` plus existing region/reference and grade source reconstruction tests; preserve IME/paste/delete-through-lock, undo/redo realignment, failed Monaco load fallback and compiler-line mapping. **0 source lines removed**, likely **+5–20** imports/reexports. Complexity isolation rather than cleanup volume.

### PKG-07 — PlantUML parser action boundaries (candidate, not defect)

Evidence: `packages/diagram/src/codecs/plantuml.ts:143–216` one per-line callback handles class body state, system stack, declaration kinds, link regex/direction/multiplicity and syntax diagnostics. Measured CC 48, 74-line span. Complexity is partly grammar: extracting branches will not reduce grammar decision count.

Action only when this grammar is next extended: separate declaration recognition from link interpretation into named results, leave line-order/state handling in parser. Avoid a generic parser framework or normalization which widens accepted syntax.

Tests: `packages/diagram/src/codecs/codecs.test.ts` golden/import cases, unsupported syntax errors with same line/code, forward references, nested systems, arrow reversal, multiplicities, unclosed bodies. Estimate **0 deletion**, potentially **+10–30** typed result plumbing. Lower priority than gesture extraction.

## Every package disposition

| Area | Evidence checked / disposition |
|---|---|
| contracts | project/evaluation/pool are large schema catalogs, not giant imperative functions. Keep shared Zod ownership. Grouping into files alone is not deletion. QuestionTypeId duplicated from core at pool.ts:21 is already intentionally compile-checked at API registration; no immediate defect demonstrated. No extra refactor beyond API-owned contract changes. |
| core | server/client separation and registry type erasure in registry.ts:16–23 are deliberate; generic `any` aliases are justified by contravariance. Keep. Potential home for PKG-02 only if dependency-neutral. |
| diagram | PKG-01/02/07. Other high-branch functions (`layout.ts:227` A*, shapes.tsx:73 node kinds) express geometry/kind cases; no blanket function-length split or router replacement justified. |
| docrender | render.ts:9–35 explicitly gives separate escaping and staff/student link visibility guarantees; highlight.ts:111 tokenize is branchy because languages/token kinds vary. No demonstrated harmful duplicate. Keep distinct from question Markdown sanitization. |
| domain | cloze.ts already has parseBlankBody/parseNumberBlank/parseRegexBlank/format helpers. parameters/evaluator.ts:236 restricted AST walk high CC is intentional deny-by-default validation; parameterNames is already shared with lightweight clients/contracts. No evidence for replacing with dynamic eval/table dispatch. Preserve pure no-DB role. |
| qt-categorize | Board.tsx:290 Zone interaction + Editor 453 lines, but distinct ordering/tray/drag business. Prompt wrapper clone is only a candidate (see below). Uses exported card/column caps correctly. No further validated deletion. |
| qt-circuit | PKG-02/03. SchematicEditor is already decomposed into hooks; grade.ts combines transient/AC technical rules with distinct necessary comparisons. Do not equate waveform/Bode algorithms or remove validation as duplication. |
| qt-cloze | 167-line server delegates parsing/scoring domain; text.tsx composes type display. No additional justified consolidation. Keep independent toStudent tests. |
| qt-code | PKG-04/05/06. CodePlayer.tsx:159 carries visible/manual/compile result states; ProgramPlayer already shares code/image layout and execution primitives. A generic mega-player would erase useful separation. No further verified net reduction. |
| qt-diagram | Thin adapter over diagram engine, including independent toStudent and teacher-only rubric filtering. Keep adapter-specific security tests. Prompt wrapper candidate only. |
| qt-mcq | 715-line Editor already separates ChoiceRow at :542; policy and selection constraints are real. No dedup beyond future local field simplification proven. MCQ_MAX_CHOICES is already SSOT. |
| qt-rich | Small adapter/editor/server; grading overlaps diagram conceptually but emptiness/reference/text behavior differs. Do not merge manual/LLM grade hooks merely because return shapes match. Prompt wrapper candidate only. |
| qt-short | Editor separates MatcherFields/:183 and ConstraintFields/:402. explainMatcher/:48 and canonicalMatcher/:27 exhaust real matcher variants, with different presentation/serialization contracts. Preserve readable exhaustive switches; numeric/date/time rule consistency should be tested, not replaced by a generalized matcher interpreter. |
| registry | Intentional two static registries (server pure/client lazy); no runtime plugin discovery. registerForTests production no-op is explicit. No value dependency cycle established. |
| ui | Shared pure presentation and history/try primitives already remove much earlier duplication; do not create a second design-system abstraction. See wrappers candidate below, but no proven large saving. |
| runner | execute.ts:141 orchestrates resource lifecycle with try/finally and container rebuild after timeout/OOM; engine.ts:205 owns process lifecycle and container hardening. Existing seams are sound, no need to flatten safety branches. Refactor only alongside specific lifecycle defect with engine/execute/unit and real Podman integration checks. No confirmed net reduction. |
| extensions | kiosk service-worker.js 58 lines/base64.js 34 lines. Origin allowlist duplicates manifest as intentional defense in depth; keep machine-key scope and challenge bounds. No refactor needed. |
| scripts | Four small tools (~415 physical lines) with distinct roles. Export and refresh intentionally run under different OS accounts. Do not fuse them. Staging hardening is already pending M2-06, not a newly discovered completed-feature regression or LOC reduction. |

## Candidate duplication not yet worth an abstraction

- Prompt field + issue wrapper repeated in rich/Editor.tsx:48, diagram/Editor.tsx:107, categorize/Editor.tsx:188. `@quiz/ui/PromptSection` currently imposes card/title styling for code/circuit, while these are uncarded forms. A single plain wrapper could remove 10–25 net lines **only if** added props/indirection stay smaller; do not replace with card variant and change UI. Candidate, not included in committed savings total.
- Canonical serialization is intentionally explicit. Repeat field names across config/student/solution types often enforce stripping secrets. Do not derive student projection by omit/delete against a complete config: positive allowlists and per-type tests are security boundaries.
- Test fixture contexts repeated in qt-* tests are outside production savings; centralizing them can couple unrelated packages. Keep local fixtures unless one real shared behavior causes synchronized changes.
- Two renderings of journal HTML are not redundant work removable by caching staff output for students.

## Delivery order / accounting

1. Low-risk PKG-05 then PKG-02 (cap and exact heap) as separate small changes.
2. PKG-01 gesture responsibilities and PKG-06 pure layout independently, with behavior tests first and no LOC target.
3. PKG-03 typed local form prototype only if it demonstrates net reduction without opaque casts/configuration.
4. PKG-04 only with related serialization work; PKG-07 only when modifying grammar.

**Identified production deletion from PKG-02/03/04/08: approximately 89–148 physical lines**, with 45–80 conditional on the PKG-03 prototype and 5–15 opportunistic PKG-04 lines. This is not repository-wide or guaranteed; tests and type scaffolding may increase total diff size. Strongly verified exact-heap reduction alone is ~35–45. Do not add component/algorithm split spans to the deletion estimate. No evidence supports a blanket percentage reduction target for packages.

Known pending safety work, tracked separately: scripts/staging-refresh.sh:46–51 clears five credential tables but not GitHub installation IDs; staging-export.sh:35 exports the full database. `docs/merge/PROGRESS.md:65` marks M2-06 todo; `09-tasks.md:476–484` explicitly requires nulling installation_id / project staging isolation before using Apps on staging. Carry this as a dependency/checkpoint, not a refactor ticket newly closing policy. Estimate positive LOC and controlled restore verification, not code savings.

### PKG-08 — Poll tally schema reused by its SSE envelope (confirmed SSOT improvement)

Evidence: `packages/contracts/src/poll.ts:207–220` owns `PollTally`; `packages/contracts/src/realtime.ts:270–279` reconstructs its four fields and nested choices/answers schemas verbatim. Both expose the same joined/answered integers and arrays. `poll.ts` imports common/pool, without realtime; measured value-import graph confirms adding realtime → poll introduces no cycle.

Action: import `PollTally` from `./poll.js` in realtime and replace the inline tally object with `tally: PollTally`. Keep the envelope's type/evaluationId/serverNow and staff-only event classification untouched. Do not opportunistically add nonnegative/max constraints, tighten unknown-key handling, or change tally disclosure to phones. No generic event factory needed.

Verification gate: build/typecheck contracts and consumers; existing `packages/contracts/src/realtime.test.ts:44` retains poll.tally as staff-only. Add paired acceptance/rejection checks that PollTally and PollTallyEvent.shape.tally accept precisely the same payloads, including negative integers currently accepted, malformed nested values and unknown-key stripping. Relevant behavioral regression suite: `apps/api/src/modules/poll/poll.db.test.ts:467–543` covers teacher/phone tally visibility; existing server event audience tests must remain green. Net production deletion **4–8 lines**; central ownership matters more than size. This is a low-risk change before major extractions.

See the [work catalogue](plan.md) for the consolidated ready/conditional accounting. These are estimated net changes, not measured refactor diffs.
