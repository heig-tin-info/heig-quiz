import type {
  EvaluationDetail,
  Grading,
  GradingEntry,
  GradingQueue,
  ResultsView,
  StudentFeedback,
} from "@quiz/contracts";

/**
 * Fixtures of the grading and results screens (WP10). They live beside the
 * screens rather than in `test/fixtures.ts` so the shared file stays the
 * shape three work packages agreed on.
 */

const MCQ_STUDENT = {
  prompt: "What is `sizeof(int *)` on LP64?",
  choices: [
    { id: 0, text: "4" },
    { id: 1, text: "8" },
  ],
  mode: "single",
};

const MCQ_SOLUTION = { correct: [1] };

const MCQ_DETAILS = {
  policy: "all_or_nothing",
  correct: [1],
  selected: [1],
  c: 1,
  w: 0,
  C: 1,
  W: 1,
  fraction: 1,
};

export function makeGrading(over: Partial<Grading> = {}): Grading {
  return {
    id: "g1",
    answerId: "ans1",
    attemptId: "a1",
    itemId: "i1",
    points: 2,
    maxPoints: 2,
    source: "auto",
    state: "proposed",
    details: MCQ_DETAILS,
    confidence: "high",
    comment: null,
    gradedBy: null,
    gradedAt: "2026-09-01T08:00:00.000Z",
    supersedesId: null,
    regradeNote: null,
    ...over,
  };
}

export function makeEntry(over: Partial<GradingEntry> = {}): GradingEntry {
  const grading = over.grading === undefined ? makeGrading() : over.grading;
  return {
    answerId: "ans1",
    attemptId: "a1",
    itemId: "i1",
    label: "Swift Otter",
    answer: { selected: [1] },
    student: MCQ_STUDENT,
    solution: MCQ_SOLUTION,
    history: [],
    ...over,
    grading,
  };
}

export function makeQueue(entries: GradingEntry[], over: Partial<GradingQueue> = {}): GradingQueue {
  const proposed = entries.filter((e) => e.grading?.state === "proposed").length;
  const validated = entries.filter((e) => e.grading?.state === "validated").length;
  return {
    order: "question",
    // `position` is 0-based, exactly as the API stores and serves it.
    items: [{ id: "i1", position: 0, internalName: "sizeof-ptr", type: "mcq", points: 2 }],
    entries,
    counts: {
      total: entries.length,
      validated,
      proposed,
      missing: entries.length - validated - proposed,
    },
    ...over,
  };
}

export function makeEvaluationDetail(over: Partial<EvaluationDetail> = {}): EvaluationDetail {
  return {
    evaluation: {
      id: "e1",
      classroomId: "r1",
      title: "Quiz 3",
      mode: "exam",
      state: "closed",
      settings: {
        navigation: "free",
        presentation: "zen",
        lobby: "manual",
        shuffleItems: false,
        shuffleChoices: true,
        timing: "duration",
        showProgressBar: true,
        logVisibility: true,
        requireFullscreen: false,
      },
      gradingScale: { kind: "linear", rounding: "nearest" },
      feedbackPolicy: {
        when: "on_release",
        showAnswer: true,
        showKey: true,
        showExplanation: true,
        showHiddenCaseNames: false,
        showTeacherComment: true,
      },
      opensAt: null,
      closesAt: null,
      durationS: null,
      accessCode: null,
      ipAllowlist: [],
      startedAt: null,
      pausedAt: null,
      closedAt: "2026-09-01T09:00:00.000Z",
      releasedAt: null,
      modifiedAfterRelease: false,
      createdAt: "2026-09-01T08:00:00.000Z",
    },
    items: [
      {
        id: "i1",
        position: 0,
        points: 2,
        milestone: false,
        questionId: "q1",
        questionVersionId: "v1",
        type: "mcq",
        internalName: "sizeof-ptr",
        versionNumber: 1,
        latestVersionNumber: 1,
        deprecated: false,
      },
      {
        id: "i2",
        position: 1,
        points: 3,
        milestone: false,
        questionId: "q2",
        questionVersionId: "v2",
        type: "mcq",
        internalName: "array-decay",
        versionNumber: 1,
        latestVersionNumber: 1,
        deprecated: false,
      },
    ],
    totalPoints: 5,
    staleItems: [],
    attemptCount: 2,
    editable: false,
    ...over,
  };
}

let userSeq = 0;
function row(displayName: string, points: number, grade: number, over: Partial<ResultsView["rows"][number]> = {}) {
  const [firstName = "", lastName = ""] = displayName.split(" ");
  userSeq += 1;
  return {
    userId: `u${userSeq}`,
    displayName,
    lastName,
    firstName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@heig-vd.ch`,
    attemptId: `a${userSeq}`,
    perItem: { i1: points },
    points,
    grade,
    durationS: 600,
    state: "submitted" as const,
    ...over,
  };
}

export function makeResultsView(over: Partial<ResultsView> = {}): ResultsView {
  userSeq = 0;
  const rows = [
    row("Zoe Blanc", 5, 6),
    row("Adam Perret", 1, 2),
    row("Marie Rochat", 3, 4),
    row("Noah Currat", 0, 1, { attemptId: null, durationS: null, state: "absent", perItem: {} }),
  ];
  return {
    evaluationId: "e1",
    title: "Quiz 3",
    totalPoints: 5,
    scale: { kind: "linear", rounding: "nearest" },
    released: false,
    releasedAt: null,
    modifiedAfterRelease: false,
    items: [
      { id: "i1", position: 0, internalName: "sizeof-ptr", type: "mcq", points: 5, successRate: 0.6 },
    ],
    rows,
    stats: {
      count: 4,
      mean: 3.25,
      median: 3,
      stdev: 1.92,
      min: 1,
      max: 6,
      histogram: [
        { bucket: 1, count: 1 },
        { bucket: 1.5, count: 0 },
        { bucket: 2, count: 1 },
        { bucket: 2.5, count: 0 },
        { bucket: 3, count: 0 },
        { bucket: 3.5, count: 0 },
        { bucket: 4, count: 1 },
        { bucket: 4.5, count: 0 },
        { bucket: 5, count: 0 },
        { bucket: 5.5, count: 0 },
        { bucket: 6, count: 1 },
      ],
    },
    ...over,
  };
}

export function makeFeedback(over: Partial<Extract<StudentFeedback, { available: true }>> = {}) {
  return {
    available: true as const,
    evaluation: { id: "e1", title: "Quiz 3", releasedAt: "2026-09-10T08:00:00.000Z" },
    attemptId: "a1",
    points: 4,
    totalPoints: 5,
    grade: 5,
    items: [
      {
        itemId: "i1",
        position: 0,
        type: "mcq",
        points: 2,
        maxPoints: 2,
        verdict: "correct" as const,
        student: MCQ_STUDENT,
        answer: { selected: [1] },
        solution: MCQ_SOLUTION,
        explanation: "An address is 64 bits wide.",
        details: MCQ_DETAILS,
        comment: "Clean answer.",
      },
    ],
    ...over,
  };
}
