/**
 * The group sets' fixtures (ADR-070, M3-16a): a set as `GET
 * /app/api/group-sets/:id` answers it and a classroom's list of them.
 * Real uuids where a body parses one (`GroupMemberPut`, `ProjectPatch`).
 */
import type { GroupSetDetail, GroupSetSummary, GroupStudent } from "@quiz/contracts";

export const ROOM_ID = "0190d3c4-0000-7000-8000-0000000000c1";
export const SET_ID = "0190d3c4-0000-7000-8000-00000000f001";
export const SET_BASE = `/app/api/group-sets/${SET_ID}`;
export const GROUP_1 = "0190d3c4-0000-7000-8000-00000000b001";
export const GROUP_2 = "0190d3c4-0000-7000-8000-00000000b002";

const NAMES: [string, string][] = [
  ["Dupont", "Alice"],
  ["Favre", "Benoît"],
  ["Martin", "Chloé"],
  ["Rochat", "David"],
  ["Vuille", "Emma"],
];

/** The n-th student (0-based), claimed unless said otherwise. */
export function student(n: number, claimed = true): GroupStudent {
  const [nom, prenom] = NAMES[n % NAMES.length]!;
  return { enrollmentId: `0190d3c4-0000-7000-8000-00000000e${String(n).padStart(3, "0")}`, nom, prenom, claimed };
}

/** Two groups — Alice and Benoît in Groupe 1, Groupe 2 empty — and Chloé, David (unclaimed), Emma in none. */
export function makeSet(over: Partial<GroupSetDetail> = {}, setOver: Partial<GroupSetDetail["set"]> = {}): GroupSetDetail {
  return {
    set: {
      id: SET_ID,
      classroomId: ROOM_ID,
      name: "Projet final",
      maxSize: null,
      createdAt: "2026-10-01T08:00:00.000Z",
      readOnly: false,
      ...setOver,
    },
    groups: [
      { id: GROUP_1, name: "Groupe 1", position: 0, members: [student(0), student(1)] },
      { id: GROUP_2, name: "Groupe 2", position: 1, members: [] },
    ],
    unplaced: [student(2), student(3, false), student(4)],
    usedBy: [],
    ...over,
  };
}

export function makeSummary(over: Partial<GroupSetSummary> = {}): GroupSetSummary {
  return {
    id: SET_ID,
    name: "Projet final",
    maxSize: 4,
    groups: 2,
    placed: 2,
    unplaced: 3,
    createdAt: "2026-10-01T08:00:00.000Z",
    usedBy: [],
    ...over,
  };
}
