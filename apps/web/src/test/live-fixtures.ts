import type {
  DashboardCell,
  DashboardRow,
  DashboardView,
  EvaluationDetail,
  ItemRow,
} from "@quiz/contracts";

/*
 * WP8 payload fixtures (evaluation configuration and live dashboard), typed
 * against @quiz/contracts so a wire change breaks the tests rather than
 * letting them assert on a shape the server no longer sends.
 *
 * Ids are UUID-shaped because the SSE client validates every frame with the
 * contract schemas: a test that fabricated "row-1" would be testing a stream
 * the browser drops.
 */

const HOUR = 3_600_000;
export const LIVE_NOW = new Date();
export const liveAt = (offsetMs: number): string =>
  new Date(LIVE_NOW.getTime() + offsetMs).toISOString();

/** Deterministic UUIDs: `id("row", 3)` is stable and distinct per family. */
export function id(family: string, n: number): string {
  let h = 0;
  for (const ch of family) h = (h * 31 + ch.charCodeAt(0)) % 0xffff;
  return `00000000-0000-4000-8000-${h.toString(16).padStart(6, "0")}${n
    .toString(16)
    .padStart(6, "0")}`;
}

export const EVALUATION_ID = id("evaluation", 1);

export function makeCell(overrides: Partial<DashboardCell> & { itemId: string }): DashboardCell {
  return {
    status: "empty",
    verdict: null,
    points: null,
    revision: 0,
    summary: null,
    ...overrides,
  };
}

/**
 * Pseudonyms whose ALPHABETICAL order is deliberately not the row order: the
 * dashboard numbers the anonymous rows by sorting on this string (D20), so a
 * list already in order would let a wrong implementation — "number them as
 * they come" — pass the test.
 */
const PSEUDONYMS = [
  "Wise Otter",
  "Amber Lynx",
  "Nimble Ibex",
  "Bold Raven",
  "Serene Quokka",
  "Calm Heron",
  "Golden Marmot",
  "Eager Puffin",
];

export function makeRow(index: number, itemIds: string[], overrides: Partial<DashboardRow> = {}): DashboardRow {
  return {
    attemptId: id("attempt", index),
    userId: id("user", index),
    // A NAME, not "Student 0": with the names hidden the grid shows
    // "Student <n>" itself, and a fixture that already said that would make
    // the toggle untestable.
    displayName: `Nadia Roux ${index}`,
    staff: false,
    pseudonym:
      index < PSEUDONYMS.length
        ? PSEUDONYMS[index]!
        : `${PSEUDONYMS[index % PSEUDONYMS.length]!} ${index}`,
    state: "in_progress",
    online: true,
    lastSeenAt: liveAt(-2000),
    deadlineAt: liveAt(10 * 60_000),
    timeBonusPercent: 0,
    points: null,
    maxPoints: itemIds.length,
    cells: itemIds.map((itemId) => makeCell({ itemId })),
    ...overrides,
  };
}

/** A dashboard of `rows` students by `items` questions, everything empty. */
export function makeDashboard(rows = 3, items = 4): DashboardView {
  const itemIds = Array.from({ length: items }, (_, i) => id("item", i));
  return {
    evaluation: {
      id: EVALUATION_ID,
      state: "running",
      startedAt: liveAt(-10 * 60_000),
      pausedAt: null,
      closesAt: liveAt(20 * 60_000),
      serverNow: liveAt(0),
    },
    items: itemIds.map((itemId, i) => ({
      id: itemId,
      position: i + 1,
      points: 1,
      type: i % 2 === 0 ? "mcq" : "short",
      internalName: `Question ${i + 1}`,
      milestone: false,
    })),
    rows: Array.from({ length: rows }, (_, i) => makeRow(i, itemIds)),
    totals: itemIds.map((itemId) => ({ itemId, completion: 0, successRate: null })),
  };
}

export function makeItemRow(index: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: id("item", index),
    position: index + 1,
    points: 1,
    milestone: false,
    questionId: id("question", index),
    questionVersionId: id("version", index),
    type: "mcq",
    internalName: `Question ${index + 1}`,
    versionNumber: 1,
    latestVersionNumber: 1,
    deprecated: false,
    ...overrides,
  };
}

export function makeEvaluationDetail(overrides: Partial<EvaluationDetail> = {}): EvaluationDetail {
  const items = overrides.items ?? [makeItemRow(0), makeItemRow(1)];
  return {
    evaluation: {
      id: EVALUATION_ID,
      classroomId: id("classroom", 1),
      title: "Quiz 3 — pointers",
      mode: "exam",
      state: "draft",
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
        showKey: false,
        showExplanation: false,
        showHiddenCaseNames: true,
        showTeacherComment: true,
      },
      mcqPolicy: "all_or_nothing",
      opensAt: null,
      closesAt: null,
      durationS: 45 * 60,
      accessCode: null,
      ipAllowlist: [],
      startedAt: null,
      pausedAt: null,
      closedAt: null,
      releasedAt: null,
      modifiedAfterRelease: false,
      createdAt: liveAt(-HOUR),
      ...overrides.evaluation,
    },
    items,
    totalPoints: items.reduce((sum, i) => sum + i.points, 0),
    staleItems: [],
    attemptCount: 0,
    editable: true,
    self: { seat: false, staffSeat: false, attemptId: null },
    ...overrides,
  };
}
