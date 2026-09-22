# Runner audit — apps/runner and its integration points (agent report, relayed)

## Summary
apps/runner: 1 359 source LOC / 11 files, 102 functions, 2 above CC 10, max 15 (probeEngine). Hardening real and asserted flag for flag (engine.ts:210-261, engine.test.ts:34-54); closed env list pinned. Two security test gaps: invariant 13 (--remote) asserted by a tautology (engine.test.ts:84-88 asserts FAKE_CAPABILITIES.remote); seccomp never proven in force. packages/qt-circuit/src/spice.int.test.ts:44 runs `podman --remote run` with no hardening flags and no --url. Dominant non-security finding: four divergent copies of the "did this case pass?" rule (qt-code grade.ts:232-244 authority; live/service.ts:1263-1290 omits run.oom and compare options; qt-code Editor.tsx:173-182; Player.tsx:87-110 verdictOf; Review.tsx:36-50) — ignoreCase:true shows "Output differs" in the player and full marks in the grade, breaking ADR-015 §2. Net −196 LOC (−182 source, −14 test) while adding 75 lines of invariant coverage.

## Findings
| id | title | principle | LOC | risk |
|---|---|---|---|---|
| R-01 | Invariant 13 (--remote) asserted by a tautology; fake podman recording argv needed (engine.ts:155-158 not in containerArgs) | SEC | +25/−5 | none |
| R-02 | qt-circuit spice.int.test.ts:41-51 runs podman run outside containerArgs (no --network none, cap-drop, seccomp, read-only, memory, pids, userns, --url); route through executeRequest | SEC/ARCH | −20 | low |
| R-03 | Seccomp never proven in force (only flag + local existsSync, config.ts:126-128; server resolves the path); add perf_event_open test | SEC | +21 | none |
| R-04 | outputKb clamped by RUNNER_MAX_OUTPUT_KB but memoryMb/timeMs only by wire schema (execute.ts:133-140, core/runner.ts:30); add RUNNER_MAX_MEMORY_MB/TIME_MS | SEC/SSOT | +16 | none |
| R-05 | Containers run without --rm; removal only in finally (execute.ts:223-225); crash leaks Exited containers; add pruneOrphans() by label quiz.runner=1 at boot | SEC/ops | +20 | low |
| R-06 | Four divergent case-verdict rules (real bug on compare options / oom); add `compare` to CodeStudent, one `caseVerdict()` exported from both qt-code entries | DRY/ARCH | −45, −30 CC | medium |
| R-07 | runVisibleCases (live/service.ts:1188-1311) and simulateAnswer (:1330-1403) duplicate ~55 lines (gate, itemOf, typeOf, studentView, rate limit, parse, build, journal, run); routes too (live/routes.ts:339-363 vs 376-396); `attemptRunContext()`; optionally codeServer.interactiveRequest via unused buildInteractiveRequest | ARCH/DRY | −45 (−75) | low/med |
| R-08 | Integration-suite bootstrap copy-pasted 3× (podman.int.test.ts:25-70, spice.int.test.ts:27-73, load.int.test.ts:23-42); one src/test/integration.ts | DRY | −75 test | none |
| R-09 | `--remote --url` argv built in 6 places (engine.ts:155, probe.ts:45, 4 tests); one remoteArgs(socket) | SSOT | −18 | none |
| R-10 | Language table in 6 places, file-name table in 4 (images.ts:7 hand-written LANGUAGES → RunnerLanguage.options; runno ENTRY_FILE → domain mainFileName; RUNNO_LANGUAGES vs RUNTIME_ASSETS agreement test) | SSOT | −15/+4 | low |
| R-11 | Dead code: listAvailableLanguages (images.ts:44-49), buildInteractiveRequest (qt-code grade.ts:98-103, test-only), inline unavailableRunner + runnerOf in pool/routes.ts:1243-1251/115-117 duplicating UnavailableRunner, BackendRun's never-read request parameter (web/runner/types.ts:32) | YAGNI | −32 | none |
| R-12 | routes.test.ts:183-224 and load.int.test.ts:105-132 re-prove RunQueue's priority/429 already proven in queue.test.ts | YAGNI | −70 test | none |
| R-13 | 503 used for permanent conditions (language_unavailable, no_source_file) that HttpRunner retries (http.ts:42); no_source_file → 400 | ARCH | +8 | low |
| R-14 | Five Containerfiles repeat the user stanza; non-root uid tested for `c` only; extend the test loop, do NOT add a base image | KISS/DRY | +6 test | low |
| R-15 | /health payload comment promises GET /admin/runner which does not exist; RunnerHealth.languages should be z.array(RunnerLanguage) | YAGNI | 0 | none |
| R-16 | probe.ts is a second partial engine (own spawner, own image lister, duplicate `podman info` call at :77); CC 15 → ~10; no unit test | DRY/KISS | −20/+40 test | low |

## Plan
Phase 1 (security test gaps, +58): R-01, R-03, R-04, R-14, R-16 part. Phase 2 (deletion, −95): R-11, R-12, R-15. Phase 3 (SSOT, −71): R-09, R-10, R-08, R-16. Phase 4 (correctness, −45): R-06 alone, checks toStudent test. Phase 5 (API run paths, −85): R-07, R-13, R-02, R-05, optional R-07 step 2.

## Keep as is
containerArgs flag list and order; CONTAINER_ENV frozen (HOME, LANG); no mounts; sanitizeFileName; sources via `cp /dev/stdin`; argv-only commands; two clocks; finally destroy; seccomp profile untouched; loadConfig refusals; constant-time bearer check; pinned podman-remote. apps/runner stays an app (ADR-016). Browser and server runners do not overlap (ADR-015). RunQueue (123 LOC) minimal. UnavailableRunner default (D14). HttpRunner error mapping. spice as a language (4 lines). Unit/integration split.

## Summary table
| Principle | Source | Test | Net |
|---|---|---|---|
| SEC | 0 | +75 | +75 |
| DRY | −105 | −35 | −140 |
| SSOT | −25 | +4 | −21 |
| YAGNI | −25 | −70 | −95 |
| KISS | −5 | +6 | +1 |
| ARCH | −22 | +6 | −16 |
| Total | −182 | −14 | ≈ −196 |

## Invariant verification
10: enforced + tested (none). 11: enforced + tested; one podman run outside the path (R-02). 12: seccomp never proven in force (R-03); uid tested for c only (R-14). 13: NO real test (R-01). 14: enforced + tested; BackendRun unused parameter is a trap (R-11.4).
