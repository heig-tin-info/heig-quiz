# knip (default config)

## Unused files (0)


## Per file

### apps/api/package.json
- unused deps: @quiz/qt-cloze, @quiz/qt-mcq, @quiz/qt-short

### apps/web/package.json
- unused deps: @tiptap/extension-link

### package.json
- unused devDeps: tsx

### packages/qt-circuit/package.json
- unused devDeps: @testing-library/jest-dom, @testing-library/react, @testing-library/user-event, jsdom

### packages/qt-code/package.json
- unused devDeps: @testing-library/user-event

### apps/web/scripts/docs-screenshots-index.mjs
- unused exports: renderSceneTable

### apps/api/src/roles.ts
- unused exports: roleForUser

### apps/api/src/modules/evaluation/service.ts
- unused exports: Locked, AttemptsExist, NoPublishedVersion, QuestionNotInCourse, PollNotImplemented, TRANSITIONS, timingIsValid, preferredMcqPolicy, totalPointsOf, presetSettings, isStructural

### apps/api/src/modules/live/service.ts
- unused exports: NotOpen, AccessCodeInvalid, IpNotAllowed, Irreversible, ItemLocked, NotRunnable, NothingToRun, deadlineFor, pastGrace, seatOf, ipAllowed, orderItems, lockedItemIds, contentVisible, assertWritable, genericSummary, answerSummarizer, summarizeAnswer, DEFAULT_RUNS_PER_MINUTE, autoCloseAt
- unused types: AnswerRecord, DeadlineParts, OrderedItem

### apps/api/src/modules/pool/service.ts
- unused exports: normalizeTag, assetReferences, isQuestionInUse

### apps/api/src/test/codeFixture.ts
- unused exports: codeConfig

### apps/api/src/modules/grading/jobs.ts
- unused exports: PROGRESS_EVERY, RUNNER_PRIORITY, enqueueRunnerGrading, runRunnerGrading
- unused types: RunnerGradingJob

### apps/api/src/modules/grading/service.ts
- unused exports: NotPending

### apps/api/src/modules/results/csv.ts
- unused exports: SEPARATOR, HEADER_MAX

### apps/api/src/modules/results/service.ts
- unused exports: computeResults, distributionOf, casePassRateOf, feedbackAvailable, FORBIDDEN_DETAIL_KEYS, stripDetailKeys, gradeOfAttempt
- unused types: ComputedResults

### apps/api/src/modules/notifications/service.ts
- unused exports: DEFAULT_LIMIT

### apps/api/src/modules/poll/service.ts
- unused exports: PollUnpublished, CODE_ALPHABET, CODE_LENGTH, ENDED_GRACE_MS, freeCode, guestHash, assertPollable, tallyOf, emitTally, joinUrl

### apps/api/src/modules/realtime/bus.ts
- unused exports: CELL_WINDOW_MS, PRESENCE_WINDOW_MS, POLL_WINDOW_MS, attemptTopic, teacherTopic, emit

### apps/api/src/modules/realtime/routes.ts
- unused exports: PING_MS, IDLE_CLOSE_MS, openStreamCount

### apps/web/src/realtime/useEventStream.ts
- unused exports: SAFETY_REFETCH_MS

### apps/web/src/test/fixtures.ts
- unused exports: NOW, DAY, at, makeStudentClassroom

### apps/web/src/commands.ts
- unused exports: POOL_COMMAND_PREFIX, contextualCommands

### apps/web/src/ui.tsx
- unused exports: focusableIn, OrgAvatar, localDateTimeInputValue, Progress, GithubIcon, RangeCalendar, COUNTDOWN_DANGER_S, segmentLabelStep

### apps/web/src/router.ts
- unused exports: SEARCH_PARAM_EVENT

### apps/web/src/theme.ts
- unused exports: initialTheme, resolveTheme

### apps/web/src/questionTypes.tsx
- unused exports: isKnownType, statsStrings, EditorSkeleton
- unused types: QuestionTypeId

### apps/web/src/attempt/autosave.ts
- unused exports: DEBOUNCE_MS, OFFLINE_AFTER_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS
- unused types: AutosaveTransport, AutosaveHooks

### apps/web/src/test/live-fixtures.ts
- unused exports: LIVE_NOW, makeCell, makeRow

### apps/web/src/markdown/render.ts
- unused exports: ASSET_BASE

### apps/web/src/markdown/highlight.ts
- unused exports: languageFamily

### apps/web/src/markdown/clozeHole.ts
- unused exports: HOLE_PIPE, clozeHoleChip, ClozeHole
- unused types: ClozeHoleChip

### apps/web/src/notifications/NotificationBell.tsx
- unused exports: notificationSentence, notificationRoute

### apps/web/src/pool/filters.ts
- unused exports: DEFAULT_SORT, DEFAULT_DIR, PAGE_SIZE

### apps/web/src/pool/move.tsx
- unused exports: readQuestionDrag

### apps/web/src/pool/searchSyntax.ts
- unused exports: EMPTY_PARSE

### apps/web/src/runner/index.ts
- unused exports: browserRunner
- unused types: BackendRun, RunHooks, RunStage

### packages/qt-circuit/src/Editor.tsx
- unused exports: CircuitEditor

### packages/qt-circuit/src/Player.tsx
- unused exports: CircuitPlayer

### packages/qt-circuit/src/Review.tsx
- unused exports: CircuitReview

### packages/qt-cloze/src/schema.ts
- unused exports: CLOZE_MAX_BLANKS, CLOZE_MAX_BLANK_LENGTH

### packages/qt-cloze/src/fixtures.ts
- unused exports: noRunner, SECRET_TEXT

### packages/qt-short/src/schema.ts
- unused exports: ShortKindSchema, ShortConstraintsSchema, ShortPrefiltersSchema

### packages/qt-short/src/grade.ts
- unused exports: applyShortPrefilters

### packages/qt-short/src/fixtures.ts
- unused exports: noRunner

### packages/qt-code/src/segments.ts
- unused exports: markerOf, isMarkerLine

### packages/qt-code/src/MonacoHost.tsx
- unused exports: default

### packages/qt-code/src/test/fixtures.ts
- unused exports: C_TEMPLATE

### packages/qt-mcq/src/schema.ts
- unused exports: McqChoiceSchema, McqModeSchema, McqPolicySchema, McqQuestionPolicySchema
- unused types: McqMode, McqDefaults

### packages/qt-mcq/src/ui.tsx
- unused exports: selectClass, legendClass

### packages/qt-mcq/src/fixtures.ts
- unused exports: noRunner

### apps/runner/src/engine.ts
- unused exports: EngineError

### apps/runner/src/images.ts
- unused exports: LANGUAGES, listAvailableLanguages

### apps/api/src/modules/guards.ts
- unused exports: courseAccess, roleAllows, staffAccessOfClassroom, loadPool

### apps/api/src/modules/evaluation/routes.ts
- unused exports: evaluationFailure

### apps/api/src/jobs.ts
- unused exports: HOUSEKEEPING_QUEUE
- unused types: SendOptions, JobHandler

### apps/api/src/seed/content.ts
- unused exports: C_POOL, ELECTRONICS_POOL
- unused types: QuestionTypeName

### apps/api/src/modules/pool/events.ts
- unused exports: questionChanged

### apps/web/src/grading/BatchBar.tsx
- unused exports: BATCH_CONFIRM_THRESHOLD

### apps/web/src/grading/progress.ts
- unused exports: gradingProgressKey

### apps/web/src/grading/labels.ts
- unused exports: scoreText

### apps/web/src/markdown/BlankPopover.tsx
- unused exports: draftFromBody, bodyFromDraft
- unused types: BlankMode

### apps/web/src/question/VersionHistory.tsx
- unused exports: statementOf

### apps/web/src/results/GradeTable.tsx
- unused exports: stateLabel

### apps/web/src/runner/runno/runner.ts
- unused exports: isRunnoLanguage, isRuntimeWarm

### apps/web/src/attempt/attemptStream.ts
- unused exports: WATCHED_EVENTS, openAttemptStream

### packages/qt-circuit/src/styles.ts
- unused exports: inputMd, textarea, codeArea, select

### packages/qt-circuit/src/canvas/canvasStyles.ts
- unused exports: hoverRing

### packages/qt-cloze/src/ui.tsx
- unused exports: legendClass, choiceLetter

### packages/qt-short/src/ui.tsx
- unused exports: legendClass

### packages/qt-code/src/styles.ts
- unused exports: inputMd, textarea

### apps/api/src/modules/org/service.ts
- unused exports: newJoinCode

### apps/api/src/modules/evaluation/events.ts
- unused exports: stateChanged

### apps/api/src/modules/pool/assets.ts
- unused exports: safeJoin

### apps/web/src/student/questionStrings.ts
- unused exports: mcqPlayerStrings, shortPlayerStrings, clozePlayerStrings, codePlayerStrings, circuitPlayerStrings

### apps/web/src/runner/runno/engine.ts
- unused exports: stdinReader, OutputFlood, outputSink, memoryImportOf, runProcess
- unused types: ProcessResult

### apps/web/src/runner/runno/tar.ts
- unused exports: gunzip, untar

### apps/api/src/events.ts
- unused types: AppEvent, DataEvent

### apps/api/src/modules/runner/index.ts
- unused types: HttpRunnerOptions

### apps/web/src/markdown/tiptap.ts
- unused types: CodeFenceOptions

### apps/web/src/runner/types.ts
- unused types: RunStage

### packages/qt-circuit/src/canvas/SchematicView.tsx
- unused types: Placement

### packages/qt-cloze/src/text.tsx
- unused types: TableAlign

### packages/qt-short/src/canonical.ts
- unused types: ShortCanonicalMatcher

### packages/qt-code/src/Editor.tsx
- unused types: CodeTryOutcome

### packages/qt-mcq/src/canonical.ts
- unused types: McqCanonicalChoice

### apps/runner/src/test/fakeEngine.ts
- unused types: FakeCall

### apps/web/src/attempt/useAttempt.ts
- unused types: ClosedInfo
