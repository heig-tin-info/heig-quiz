/** Section 2 of the mock — see `index.ts` for the layout. */
import {
  clozeStudentTemplate,
  describeBlank,
  matchBlank,
  mcqFraction,
  parseCloze,
  splitTemplate,
  truncateSelection,
} from "@quiz/domain";
import type {
  McqScorePolicy,
} from "@quiz/domain";
/*
 * The `circuit` type's own extractor and parser, used here for the reason the
 * mock uses `@quiz/domain`'s formulas: a grading whose waveforms were invented
 * by hand would prove the markup and nothing about the feature. Both are pure
 * functions over a schematic and a runner outcome, so they cost the mock
 * bundle nothing.
 *
 * They come from `/server`, not `/client`: this file IS the server while
 * `VITE_MOCK=1`, and `./client` no longer re-exports them precisely so that
 * the grading path stays out of the real app's initial chunk (P-07).
 */
import {
  extractNets,
  parseSimulation,
} from "@quiz/qt-circuit/server";
import type {
  CircuitStudent,
  Schematic,
  StimulusDetail,
} from "@quiz/qt-circuit/client";
import type {
  Notification,
} from "@quiz/contracts";
import {
  D,
  H,
  MockError,
  MockValidation,
  flags,
  iso,
  nextId,
  on,
  params,
} from "./runtime";
import {
  ME_TEACHER,
  courseOr404,
  rooms,
  teachers,
} from "./org";
import {
  me,
} from "./session";

// --- 2. Pools, categories, questions (WP7) --------------------------------
//
// The mock carries real French content — C programming and electronics, the
// two courses above — because an empty-looking pool proves nothing about the
// screen that shows it. Student views go through the SAME pure functions the
// server uses (`@quiz/domain`), so the preview and the try panel show what a
// student would actually receive.

interface MockVersion {
  number: number;
  publishedAt: string;
  publishedBy: string | null;
  changeNote: string | null;
  deprecatedAt: string | null;
  deprecationNote: string | null;
  config: Record<string, unknown>;
  explanation: string;
  configVersion: number;
}

export interface MockQuestion {
  id: string;
  poolId: string;
  type: "mcq" | "short" | "cloze" | "code" | "circuit";
  internalName: string;
  categoryId: string | null;
  difficulty: number;
  shuffleable: boolean;
  randomizable: boolean;
  tags: string[];
  deletedAt: string | null;
  updatedAt: string;
  draft: { config: Record<string, unknown>; explanation: string };
  versions: MockVersion[];
}

interface MockPool {
  id: string;
  name: string;
  /** A lucide icon name (`poolIcons.ts`), or null for the default. */
  icon: string | null;
  visibility: "private" | "shared" | "public";
  ownerId: string;
  isPersonal: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A seat on a pool (F-POOL-05); the OWNER account holds the first one. */
interface MockMember {
  userId: string;
  email: string;
  givenName: string;
  familyName: string;
  role: "reader" | "contributor" | "owner";
  addedAt: string;
}

interface MockCategory {
  id: string;
  poolId: string;
  parentId: string | null;
  name: string;
  position: number;
}

/**
 * Three pools, because the card has three facts to show and one pool cannot
 * show them: one private and mine, one PUBLIC and mine, and one owned by a
 * colleague and shared with me as a contributor — which is the only way the
 * owner's name, the role and the "Leave" item of the menu are ever on screen.
 */
export const pools: MockPool[] = [
  { id: "p1", name: "Programmation C", icon: "code", visibility: "shared", ownerId: "u-me", isPersonal: false, createdAt: iso(-300 * D), updatedAt: iso(-2 * H) },
  { id: "p2", name: "Systèmes embarqués", icon: "cpu", visibility: "public", ownerId: "u-me", isPersonal: false, createdAt: iso(-120 * D), updatedAt: iso(-6 * D) },
  { id: "p3", name: "Électronique analogique", icon: "circuit-board", visibility: "shared", ownerId: "t1", isPersonal: false, createdAt: iso(-60 * D), updatedAt: iso(-30 * 60_000) },
];

const ADA = { userId: "t1", email: "ada.lovelace@heig-vd.ch", givenName: "Ada", familyName: "Lovelace" };
const GRACE = { userId: "t2", email: "grace.hopper@heig-vd.ch", givenName: "Grace", familyName: "Hopper" };
export const ME_MEMBER = {
  userId: "u-me",
  email: ME_TEACHER.email,
  givenName: ME_TEACHER.givenName,
  familyName: ME_TEACHER.familyName,
};

/** `pool_members`, owner first, then in the order the seats were given. */
export const poolMembers: Record<string, MockMember[]> = {
  p1: [
    { ...ME_MEMBER, role: "owner", addedAt: iso(-300 * D) },
    { ...ADA, role: "contributor", addedAt: iso(-40 * D) },
    { ...GRACE, role: "reader", addedAt: iso(-12 * D) },
  ],
  p2: [{ ...ME_MEMBER, role: "owner", addedAt: iso(-120 * D) }],
  // The one pool this browser only READS: the pool screen then draws no
  // create, edit, duplicate, delete or bulk action (F-POOL-05).
  p3: [
    { ...ADA, role: "owner", addedAt: iso(-60 * D) },
    { ...ME_MEMBER, role: "reader", addedAt: iso(-3 * D) },
  ],
};

/**
 * The bell's inbox: newest first, one unread and one already read, so both
 * halves of a row are on screen at once. `?many=1` floods it, which is the
 * only way to see the badge give up counting ("9+").
 */
const notifications: Notification[] = [
  {
    id: "n1",
    payload: {
      kind: "pool_shared",
      poolId: "p3",
      poolName: "Électronique analogique",
      role: "reader",
      byName: "Ada Lovelace",
    },
    createdAt: iso(-3 * D),
    readAt: null,
  },
  {
    id: "n2",
    payload: {
      kind: "pool_ownership",
      poolId: "p2",
      poolName: "Systèmes embarqués",
      fromName: "Grace Hopper",
    },
    createdAt: iso(-9 * D),
    readAt: iso(-8 * D),
  },
];

export const categories: MockCategory[] = [
  { id: "k1", poolId: "p1", parentId: null, name: "Pointeurs", position: 0 },
  { id: "k2", poolId: "p1", parentId: "k1", name: "Arithmétique", position: 0 },
  { id: "k3", poolId: "p1", parentId: "k1", name: "Allocation dynamique", position: 1 },
  { id: "k4", poolId: "p1", parentId: null, name: "Tableaux", position: 1 },
  { id: "k5", poolId: "p1", parentId: null, name: "Fichiers", position: 2 },
  { id: "k6", poolId: "p2", parentId: null, name: "Capteurs", position: 0 },
  { id: "k7", poolId: "p2", parentId: null, name: "Bus I²C", position: 1 },
  { id: "k8", poolId: "p3", parentId: null, name: "Amplificateurs", position: 0 },
  { id: "k9", poolId: "p3", parentId: null, name: "Filtres", position: 1 },
];

/** `course_pools`: which pools a course draws from. */
export const coursePools: Record<string, string[]> = { c1: ["p1"], c2: ["p2"] };

const mcqConfig = (
  prompt: string,
  choices: [string, boolean][],
  over: Record<string, unknown> = {},
) => ({
  configVersion: 2,
  prompt,
  choices: choices.map(([text, correct]) => ({ text, correct })),
  mode: "single",
  // The default: the evaluation that plays the question decides.
  policy: "inherit",
  shuffleChoices: true,
  ...over,
});

/** The v2 defaults of a `short` config, for a mock question that omits them. */
const shortConstraints = (config: Record<string, unknown>) => ({
  minLength: 0,
  maxLength: 255,
  integer: false,
  ...((config.constraints ?? {}) as Record<string, unknown>),
});

const shortPrefilter = (config: Record<string, unknown>) => {
  const p = { trim: true, lowercase: true, ...((config.prefilters ?? {}) as Record<string, unknown>) };
  return (raw: string): string => {
    let out = raw.normalize("NFC");
    if (p.trim) out = out.trim();
    if (p.lowercase) out = out.toLocaleLowerCase("fr");
    return out;
  };
};

const shortNumber = (prompt: string, value: number, unit?: string) => ({
  configVersion: 2,
  prompt,
  kind: "number",
  constraints: { min: 0, integer: true },
  prefilters: { trim: true, lowercase: true },
  ...(unit ? { placeholder: unit } : {}),
  matchers: [
    {
      kind: "number",
      value,
      tolerance: 0,
      toleranceMode: "abs",
      unitRequired: false,
      points: 1,
      ...(unit ? { unit } : {}),
    },
  ],
});

const codeConfig = (
  prompt: string,
  template: string,
  cases: {
    name: string;
    args?: string[];
    stdin: string;
    expected: string;
    compareStdout?: boolean;
    expectedExitCode?: number | null;
    visible: boolean;
  }[],
  reference = "",
  runtime: "backend" | "runno" = "backend",
) => ({
  configVersion: 1,
  prompt,
  language: "c",
  runtime,
  template,
  files: [],
  action: "run",
  compileArgs: "-Wall -Werror",
  limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
  runsPerMinute: 10,
  allOrNothing: false,
  referenceSolution: reference,
  tests: {
    mode: "io",
    compare: { trimTrailing: true, ignoreCase: false, numeric: null },
    cases: cases.map((c) => ({
      args: [],
      compareStdout: true,
      expectedExitCode: 0,
      ...c,
      points: 1,
      timeMs: null,
    })),
  },
});

/**
 * The RC low-pass of the `circuit` question below, drawn on the 20-unit grid
 * of `@quiz/qt-circuit`: R1 from `in+` to `out+`, C1 from that node down to
 * the `in-` / `out-` rail. It is the TEACHER's reference; the student's
 * answer further down is the same circuit with the capacitor left floating,
 * because the diagnostics strip is what the screenshot has to show.
 */
export const RC_REFERENCE: Schematic = {
  components: [
    { id: "c1", kind: "R", x: 300, y: 100, m: [1, 0, 0, 1], name: "R1", value: "1.59k" },
    { id: "c2", kind: "C", x: 480, y: 180, m: [0, 1, -1, 0], name: "C1", value: "100n" },
  ],
  wires: [
    { id: "w1", a: { kind: "port", port: "in+" }, b: { kind: "pin", c: "c1", p: 0 }, via: [], points: [[0, 100], [260, 100]] },
    { id: "w2", a: { kind: "pin", c: "c1", p: 1 }, b: { kind: "port", port: "out+" }, via: [], points: [[340, 100], [800, 100]] },
    { id: "w3", a: { kind: "pin", c: "c2", p: 0 }, b: { kind: "free", x: 480, y: 100 }, via: [], points: [[480, 160], [480, 100]] },
    { id: "w4", a: { kind: "pin", c: "c2", p: 1 }, b: { kind: "port", port: "in-" }, via: [], points: [[480, 200], [480, 400], [0, 400]] },
    { id: "w5", a: { kind: "free", x: 480, y: 400 }, b: { kind: "port", port: "out-" }, via: [], points: [[480, 400], [800, 400]] },
  ],
};

/** The same circuit with its ground wires missing: C1's lower pin hangs in the air. */
export const RC_STUDENT: Schematic = {
  components: RC_REFERENCE.components,
  wires: RC_REFERENCE.wires.filter((w) => w.id !== "w4" && w.id !== "w5"),
};

const circuitConfig = (
  prompt: string,
  over: Record<string, unknown> = {},
) => ({
  configVersion: 1,
  prompt,
  palette: { kinds: ["R", "C", "L", "GND"], maxComponents: 4 },
  supplies: { vcc: null, vee: null },
  commonGround: true,
  stimuli: [
    {
      name: "sinus 1 kHz",
      source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
      sourceOhms: 0,
      load: { kind: "resistor", ohms: 1_000_000 },
      analysis: { stopMs: 5, skipMs: 0, points: 500 },
      points: 2,
      visible: true,
    },
    {
      name: "sinus 10 kHz",
      source: { kind: "sine", amplitude: 1, frequencyHz: 10_000, offset: 0 },
      sourceOhms: 0,
      load: { kind: "resistor", ohms: 1_000_000 },
      analysis: { stopMs: 1, skipMs: 0, points: 500 },
      points: 1,
      visible: false,
    },
  ],
  reference: RC_REFERENCE,
  grading: {
    mode: "manual",
    tolerance: 0.05,
    rubric:
      "Résistance en série, condensateur en parallèle sur la sortie, produit R·C cohérent avec 1 kHz.",
  },
  showExpected: false,
  simulationsPerMinute: 10,
  ...over,
});

/**
 * REAL ngspice output, shortened from the transient of
 * `packages/qt-circuit/src/test/ngspice-rc-lowpass.stdout.txt`: the header
 * line and a hundred of its rows, in the exact format `parseSimulation`
 * reads. A hand-written table would prove the markup and nothing else.
 */
const NGSPICE_RC_LOWPASS = `
Note: No compatibility mode selected!


Circuit: * rc low-pass

Doing analysis at TEMP = 27.000000 and TNOM = 27.000000


Initial Transient Solution
--------------------------

Node                                   Voltage
----                                   -------
in                                           0
out                                          0
outl                                         0
vmeas#branch                                 0
vin#branch                                   0

 time            v(in)           v(out)          i(Vmeas)       
 0.00000000e+00  0.00000000e+00  0.00000000e+00  0.00000000e+00 
 1.00000000e-05  6.27763719e-02  2.10456606e-03  2.10456606e-09 
 2.00000000e-05  1.25280781e-01  7.88837779e-03  7.88837779e-09 
 3.00000000e-05  1.87304773e-01  1.69362232e-02  1.69362232e-08 
 4.00000000e-05  2.48589559e-01  2.91907519e-02  2.91907519e-08 
 5.00000000e-05  3.08893275e-01  4.44036884e-02  4.44036884e-08 
 6.00000000e-05  3.67977931e-01  6.23272898e-02  6.23272898e-08 
 7.00000000e-05  4.25610346e-01  8.27145789e-02  8.27145789e-08 
 8.00000000e-05  4.81563071e-01  1.05319618e-01  1.05319618e-07 
 9.00000000e-05  5.35615287e-01  1.29897823e-01  1.29897823e-07 
 1.00000000e-04  5.87553674e-01  1.56206311e-01  1.56206311e-07 
 1.10000000e-04  6.37173255e-01  1.84004280e-01  1.84004280e-07 
 1.20000000e-04  6.84278205e-01  2.13053413e-01  2.13053413e-07 
 1.30000000e-04  7.28682621e-01  2.43118312e-01  2.43118312e-07 
 1.40000000e-04  7.70211259e-01  2.73966943e-01  2.73966943e-07 
 1.50000000e-04  8.08700226e-01  3.05371103e-01  3.05371103e-07 
 1.60000000e-04  8.43997622e-01  3.37106899e-01  3.37106899e-07 
 1.70000000e-04  8.75964145e-01  3.68955232e-01  3.68955232e-07 
 1.80000000e-04  9.04473638e-01  4.00702292e-01  4.00702292e-07 
 1.90000000e-04  9.29413587e-01  4.32140049e-01  4.32140049e-07 
 2.00000000e-04  9.50685565e-01  4.63066746e-01  4.63066746e-07 
 2.10000000e-04  9.68205621e-01  4.93287389e-01  4.93287389e-07 
 2.20000000e-04  9.81904612e-01  5.22614224e-01  5.22614224e-07 
 2.30000000e-04  9.91728474e-01  5.50867206e-01  5.50867206e-07 
 2.40000000e-04  9.97638437e-01  5.77874456e-01  5.77874456e-07 
 2.50000000e-04  9.99611177e-01  6.03472698e-01  6.03472698e-07 
 2.60000000e-04  9.97638908e-01  6.27507681e-01  6.27507681e-07 
 2.70000000e-04  9.91729414e-01  6.49834571e-01  6.49834571e-07 
 2.80000000e-04  9.81906017e-01  6.70318328e-01  6.70318328e-07 
 2.90000000e-04  9.68207486e-01  6.88834054e-01  6.88834054e-07 
 3.00000000e-04  9.50687882e-01  7.05267305e-01  7.05267305e-07 
 3.10000000e-04  9.29416347e-01  7.19514385e-01  7.19514385e-07 
 3.20000000e-04  9.04476831e-01  7.31482596e-01  7.31482596e-07 
 3.30000000e-04  8.75967758e-01  7.41090462e-01  7.41090462e-07 
 3.40000000e-04  8.44001640e-01  7.48267913e-01  7.48267913e-07 
 3.50000000e-04  8.08704633e-01  7.52956434e-01  7.52956434e-07 
 3.60000000e-04  7.70216039e-01  7.55109177e-01  7.55109177e-07 
 3.70000000e-04  7.28687754e-01  7.54691033e-01  7.54691033e-07 
 3.80000000e-04  6.84283671e-01  7.51678662e-01  7.51678662e-07 
 3.90000000e-04  6.37179033e-01  7.46060490e-01  7.46060490e-07 
 4.00000000e-04  5.87559741e-01  7.37836661e-01  7.37836661e-07 
 4.10000000e-04  5.35621619e-01  7.27018945e-01  7.27018945e-07 
 4.20000000e-04  4.81569643e-01  7.13630614e-01  7.13630614e-07 
 4.30000000e-04  4.25617131e-01  6.97706270e-01  6.97706270e-07 
 4.40000000e-04  3.67984903e-01  6.79291638e-01  6.79291638e-07 
 4.50000000e-04  3.08900407e-01  6.58443316e-01  6.58443316e-07 
 4.60000000e-04  2.48596822e-01  6.35228488e-01  6.35228488e-07 
 4.70000000e-04  1.87312139e-01  6.09724601e-01  6.09724601e-07 
 4.80000000e-04  1.25288221e-01  5.82019000e-01  5.82019000e-07 
 4.90000000e-04  6.27698471e-02  5.52208532e-01  5.52208532e-07 
 5.00000000e-04  3.74936500e-06  5.20399114e-01  5.20399114e-07 
 5.10000000e-04 -6.27623631e-02  4.86705268e-01  4.86705268e-07 
 5.20000000e-04 -1.25280781e-01  4.51249627e-01  4.51249627e-07 
 5.30000000e-04 -1.87304773e-01  4.14162407e-01  4.14162407e-07 
 5.40000000e-04 -2.48589559e-01  3.75580857e-01  3.75580857e-07 
 5.50000000e-04 -3.08893275e-01  3.35648680e-01  3.35648680e-07 
 5.60000000e-04 -3.67977931e-01  2.94515433e-01  2.94515433e-07 
 5.70000000e-04 -4.25610346e-01  2.52335901e-01  2.52335901e-07 
 5.80000000e-04 -4.81563071e-01  2.09269463e-01  2.09269463e-07 
 5.90000000e-04 -5.35615287e-01  1.65479428e-01  1.65479428e-07 
 6.00000000e-04 -5.87553674e-01  1.21132369e-01  1.21132369e-07 
 6.10000000e-04 -6.37173255e-01  7.63974383e-02  7.63974383e-08 
 6.20000000e-04 -6.84278205e-01  3.14456758e-02  3.14456758e-08 
 6.30000000e-04 -7.28682621e-01 -1.35506848e-02 -1.35506848e-08 
 6.40000000e-04 -7.70211259e-01 -5.84189189e-02 -5.84189189e-08 
 6.50000000e-04 -8.08700226e-01 -1.02986511e-01 -1.02986511e-07 
 6.60000000e-04 -8.43997622e-01 -1.47081853e-01 -1.47081853e-07 
 6.70000000e-04 -8.75964145e-01 -1.90534940e-01 -1.90534940e-07 
 6.80000000e-04 -9.04473638e-01 -2.33178056e-01 -2.33178056e-07 
 6.90000000e-04 -9.29413587e-01 -2.74846451e-01 -2.74846451e-07 
 7.00000000e-04 -9.50685565e-01 -3.15379005e-01 -3.15379005e-07 
 7.10000000e-04 -9.68205621e-01 -3.54618879e-01 -3.54618879e-07 
 7.20000000e-04 -9.81904612e-01 -3.92414144e-01 -3.92414144e-07 
 7.30000000e-04 -9.91728474e-01 -4.28618393e-01 -4.28618393e-07 
 7.40000000e-04 -9.97638437e-01 -4.63091329e-01 -4.63091329e-07 
 7.50000000e-04 -9.99611177e-01 -4.95699332e-01 -4.95699332e-07 
 7.60000000e-04 -9.97638908e-01 -5.26315991e-01 -5.26315991e-07 
 7.70000000e-04 -9.91729414e-01 -5.54822617e-01 -5.54822617e-07 
 7.80000000e-04 -9.81906017e-01 -5.81108716e-01 -5.81108716e-07 
 7.90000000e-04 -9.68207486e-01 -6.05072437e-01 -6.05072437e-07 
 8.00000000e-04 -9.50687882e-01 -6.26620977e-01 -6.26620977e-07 
 8.10000000e-04 -9.29416347e-01 -6.45670956e-01 -6.45670956e-07 
 8.20000000e-04 -9.04476831e-01 -6.62148756e-01 -6.62148756e-07 
 8.30000000e-04 -8.75967758e-01 -6.75990812e-01 -6.75990812e-07 
 8.40000000e-04 -8.44001640e-01 -6.87143873e-01 -6.87143873e-07 
 8.50000000e-04 -8.08704633e-01 -6.95565215e-01 -6.95565215e-07 
 8.60000000e-04 -7.70216039e-01 -7.01222817e-01 -7.01222817e-07 
 8.70000000e-04 -7.28687754e-01 -7.04095491e-01 -7.04095491e-07 
 8.80000000e-04 -6.84283671e-01 -7.04172969e-01 -7.04172969e-07 
 8.90000000e-04 -6.37179033e-01 -7.01455951e-01 -7.01455951e-07 
 9.00000000e-04 -5.87559741e-01 -6.95956103e-01 -6.95956103e-07 
 9.10000000e-04 -5.35621619e-01 -6.87696016e-01 -6.87696016e-07 
 9.20000000e-04 -4.81569643e-01 -6.76709121e-01 -6.76709121e-07 
 9.30000000e-04 -4.25617131e-01 -6.63039558e-01 -6.63039558e-07 
 9.40000000e-04 -3.67984903e-01 -6.46742008e-01 -6.46742008e-07 
 9.50000000e-04 -3.08900407e-01 -6.27881479e-01 -6.27881479e-07 
 9.60000000e-04 -2.48596822e-01 -6.06533051e-01 -6.06533051e-07 
 9.70000000e-04 -1.87312139e-01 -5.82781583e-01 -5.82781583e-07 
 9.80000000e-04 -1.25288221e-01 -5.56721381e-01 -5.56721381e-07 
 9.90000000e-04 -6.27698471e-02 -5.28455828e-01 -5.28455828e-07 
No. of Data Rows : 512
Note: Simulation executed from .control section 
`;

export type MockSchematic = Schematic;
export const EMPTY_SCHEMATIC: Schematic = { components: [], wires: [] };

/** One runner case carrying the transient above. */
const ngspiceCase = () => ({
  exitCode: 0,
  stdout: NGSPICE_RC_LOWPASS,
  stderr: "",
  ms: 340,
  timedOut: false,
  oom: false,
  truncated: false,
});

/** A `RunnerOutcome` for `n` decks, which is what `POST /simulate` answers. */
export const ngspiceOutcome = (n: number) => ({
  compile: { ok: true, stdout: "", stderr: "", ms: 0 },
  cases: Array.from({ length: n }, ngspiceCase),
});

/**
 * `gradings.details` for a circuit answer: the visible stimuli carry the
 * waveforms the parser read out of the transient above, the hidden ones carry
 * none (they were never run in this mock), and the mode stays `manual` —
 * which is what a deployment without a container engine produces (D14).
 */
export function mockCircuitDetails(
  student: CircuitStudent,
  stimuli: CircuitStimulusLike[],
  schematic: MockSchematic,
): { fraction: number; details: Record<string, unknown> } {
  // The diagnostics are EXTRACTED from the answer, never invented: the mock
  // runs the same `extractNets` the grader does, so a screenshot shows the
  // sentence a student would really get.
  const netlist = extractNets(schematic, {
    commonGround: student.commonGround,
    palette: student.palette,
    supplies: student.supplies,
  });
  const ok = netlist.issues.length === 0 && netlist.counted > 0;
  const parsed = ok ? parseSimulation(student, ngspiceOutcome(student.visibleStimuli.length)) : [];
  let visibleSeen = 0;
  const details: StimulusDetail[] = stimuli.map((st) => {
    const visible = st.visible !== false;
    const read = visible && ok ? (parsed[visibleSeen++] ?? null) : null;
    return {
      name: st.name,
      visible,
      points: st.points,
      ok,
      // Nothing was compared when the netlist did not come out, so there is
      // no distance to report — `—`, not a number a teacher would trust.
      error: ok ? 0.012 : null,
      series: read?.series ?? null,
      expected: null,
      ...(ok ? {} : { reason: netlist.counted === 0 ? "not_run" : "floating_pin" }),
    };
  });
  const total = stimuli.reduce((sum, st) => sum + st.points, 0);
  return {
    fraction: ok ? 1 : 0,
    details: {
      mode: "manual",
      runner: ok ? "ok" : "none",
      netlist: {
        components: netlist.counted,
        nets: netlist.nets.length,
        issues: netlist.issues.map((i) => `${i.code}:${i.ref}`),
      },
      stimuli: details,
      earned: ok ? total : 0,
      total,
    },
  };
}

const SUM_TEMPLATE = `/* @@lock */
#include <stddef.h>
#include <stdio.h>

int somme(const int *t, size_t n) {
/* @@endlock */
    /* à compléter : l'opérateur [] est interdit */
    return 0;
/* @@lock */
}

int main(void) {
    int t[5] = {10, 20, 30, 40, 50};
    printf("%d\\n", somme(t, 5));
    return 0;
}
/* @@endlock */
`;

let questionSeq = 0;
export function makeQuestion(
  init: Omit<MockQuestion, "id" | "versions" | "draft" | "deletedAt" | "updatedAt"> & {
    config: Record<string, unknown>;
    explanation?: string;
    published?: { number: number; changeNote: string; daysAgo: number }[];
    draftChanges?: boolean;
  },
): MockQuestion {
  const { config, explanation = "", published = [], draftChanges = false, ...rest } = init;
  questionSeq += 1;
  const versions: MockVersion[] = published.map((v) => ({
    number: v.number,
    publishedAt: iso(-v.daysAgo * D),
    publishedBy: "u-me",
    changeNote: v.changeNote,
    deprecatedAt: null,
    deprecationNote: null,
    config,
    explanation,
    configVersion: 1,
  }));
  return {
    ...rest,
    id: `q${questionSeq}`,
    deletedAt: null,
    updatedAt: iso(-(draftChanges ? 1 : (published.at(-1)?.daysAgo ?? 30)) * D),
    draft: { config, explanation },
    versions,
  };
}

export const questions: MockQuestion[] = [
  makeQuestion({
    poolId: "p1",
    type: "code",
    internalName: "ptr-arith-01",
    categoryId: "k2",
    difficulty: 3,
    shuffleable: false,
    randomizable: false,
    tags: ["pointeurs", "arithmetique"],
    config: codeConfig(
      "Écrivez la fonction `somme` qui retourne la somme des `n` premiers éléments de `t`.\n\nL'opérateur d'indexation `[]` est **interdit** : utilisez l'arithmétique des pointeurs.",
      SUM_TEMPLATE,
      [
        { name: "cas nominal", stdin: "", expected: "150", visible: true },
        { name: "tableau vide", stdin: "", expected: "0", visible: false },
        { name: "valeurs négatives", stdin: "", expected: "-6", visible: false },
      ],
      "    int s = 0;\n    for (const int *p = t; p < t + n; p++) s += *p;\n    return s;\n",
    ),
    explanation:
      "`p + 1` avance d'un `int`, soit `sizeof(int)` octets. La boucle s'arrête quand le pointeur atteint `t + n`.",
    published: [
      { number: 1, changeNote: "Première version", daysAgo: 60 },
      { number: 2, changeNote: "Ajout d'un cas caché sur le tableau vide", daysAgo: 20 },
      { number: 3, changeNote: "Énoncé reformulé", daysAgo: 2 },
    ],
    draftChanges: true,
  }),
  makeQuestion({
    poolId: "p1",
    type: "mcq",
    internalName: "ptr-null-check",
    categoryId: "k1",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["pointeurs", "securite"],
    config: mcqConfig(
      "Soit `int *p;` déclaré dans une fonction, sans initialisation. Que vaut `p` ?",
      [
        ["`NULL`", false],
        ["Une valeur indéterminée : le lire est un comportement indéfini", true],
        ["`0` sur toute machine conforme à C17", false],
        ["L'adresse de la fonction englobante", false],
      ],
    ),
    explanation:
      "Une variable automatique n'est pas initialisée : `p` contient ce qui traînait sur la pile.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 21 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "short",
    internalName: "sizeof-ptr-64",
    categoryId: "k1",
    difficulty: 1,
    shuffleable: false,
    randomizable: false,
    tags: ["pointeurs", "sizeof"],
    config: shortNumber(
      "Sur une machine 64 bits (LP64), que vaut `sizeof(int *)` ? Répondez en octets.",
      8,
      "octets",
    ),
    explanation: "Une adresse tient sur 64 bits, soit 8 octets, quel que soit le type pointé.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 40 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "cloze",
    internalName: "malloc-tableau",
    categoryId: "k3",
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: ["memoire", "pointeurs"],
    /*
     * The question the rich cloze editor was built for: a dropdown inside a
     * TABLE cell. The `|` of the hole is exactly the character a markdown row
     * is split on, and it survives because the editor takes it out of the row
     * before the table lexer sees it (markdown/clozeHole.ts) and the domain
     * parser replaces the whole hole by a sentinel before markdown runs at all
     * (decision D5).
     */
    config: {
      configVersion: 2,
      text:
        "Pour allouer un tableau de `n` entiers on écrit `int *t = {{malloc|calloc}}(n * sizeof({{int}}));`, " +
        "puis on libère la mémoire avec {{=free|delete|dispose}}.\n\n" +
        "| Fonction | Met la mémoire à zéro |\n" +
        "| -------- | --------------------- |\n" +
        "| `malloc` | {{oui|=non}}          |\n" +
        "| `calloc` | {{=oui|non}}          |",
      caseSensitive: false,
      shuffleOptions: true,
    },
    explanation: "`malloc` renvoie `void *` ; en C la conversion est implicite et le cast est inutile.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 12 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "mcq",
    internalName: "array-decay",
    categoryId: "k4",
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: ["tableaux", "pointeurs"],
    config: mcqConfig(
      "Dans `void f(int t[10])`, que vaut `sizeof(t)` à l'intérieur de `f` sur une machine 64 bits ?",
      [
        ["40, la taille du tableau", false],
        ["8, la taille d'un pointeur", true],
        ["10, le nombre d'éléments", false],
        ["4, la taille d'un `int`", false],
      ],
    ),
    explanation: "Un paramètre tableau se convertit en pointeur : `int t[10]` y est exactement `int *t`.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 30 }],
    draftChanges: true,
  }),
  makeQuestion({
    poolId: "p1",
    type: "mcq",
    internalName: "fopen-modes",
    categoryId: "k5",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["fichiers"],
    // The one MULTIPLE-answer question of the mock: two keys, so the scoring
    // card of the editor is shown whole — the policy, the answer limit and
    // the shuffling exception all live there and single mode hides two of
    // the three.
    config: mcqConfig(
      "Quels modes de `fopen` permettent d'écrire dans un fichier **sans** effacer son contenu ?",
      [
        ['`"a"`', true],
        ['`"a+"`', true],
        ['`"w"`', false],
        ['`"w+"`', false],
      ],
      { mode: "multiple", policy: "symmetric" },
    ),
    explanation:
      "`\"a\"` et `\"a+\"` écrivent à la fin du fichier ; `\"w\"` et `\"w+\"` le tronquent à l'ouverture.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 55 }],
  }),
  makeQuestion({
    poolId: "p1",
    type: "code",
    internalName: "strcpy-overflow",
    categoryId: "k4",
    difficulty: 4,
    shuffleable: false,
    randomizable: false,
    tags: ["tableaux", "securite"],
    config: codeConfig(
      "Le programme ci-dessous déborde d'un tampon. Corrigez-le sans changer la taille de `dest`.",
      "#include <stdio.h>\n#include <string.h>\n\nint main(void) {\n    char dest[8];\n    const char *src = \"bonjour tout le monde\";\n    strcpy(dest, src);\n    printf(\"%s\\n\", dest);\n    return 0;\n}\n",
      [{ name: "troncature", stdin: "", expected: "bonjour", visible: true }],
    ),
    explanation: "`strncpy` ne termine pas toujours la chaîne : il faut écrire le `\\0` soi-même.",
  }),
  makeQuestion({
    poolId: "p2",
    type: "circuit",
    internalName: "filtre-capteur-rc",
    categoryId: "k6",
    difficulty: 3,
    shuffleable: false,
    randomizable: false,
    tags: ["filtre", "capteur", "rc"],
    config: circuitConfig(
      "La sortie analogique du capteur est bruitée au-delà de quelques kilohertz. " +
        "Câblez entre l'entrée et la sortie du quadripôle un filtre **passe-bas** du " +
        "premier ordre, de fréquence de coupure 1 kHz.",
    ),
    explanation:
      "f = 1 / (2 π R C). Avec R = 1,59 kΩ et C = 100 nF, f ≈ 1 kHz. " +
      "La sortie se prend aux bornes du condensateur.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 9 }],
  }),
  makeQuestion({
    poolId: "p2",
    type: "short",
    internalName: "loi-ohm-led",
    categoryId: "k6",
    difficulty: 1,
    shuffleable: false,
    randomizable: false,
    tags: ["electronique", "resistances"],
    config: shortNumber(
      "Une LED rouge (chute de 2,0 V) est alimentée en 5,0 V à travers une résistance de 200 Ω. Quel courant la traverse, en mA ?",
      15,
      "mA",
    ),
    explanation: "I = (5,0 − 2,0) / 200 = 15 mA.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 18 }],
  }),
  makeQuestion({
    poolId: "p2",
    type: "mcq",
    internalName: "i2c-adressage",
    categoryId: "k7",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["i2c", "bus"],
    config: mcqConfig(
      "Sur un bus I²C en adressage 7 bits, combien de périphériques distincts peut-on adresser au maximum ?",
      [
        ["128, moins les adresses réservées", true],
        ["127, l'adresse 0 étant interdite", false],
        ["256", false],
        ["Autant que de fils SDA disponibles", false],
      ],
    ),
    explanation: "7 bits donnent 128 adresses, dont seize sont réservées par la spécification.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 9 }],
  }),
  makeQuestion({
    poolId: "p2",
    type: "cloze",
    internalName: "adc-resolution",
    categoryId: "k6",
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: ["can", "mesure"],
    config: {
      configVersion: 2,
      text: "Un convertisseur analogique-numérique de {{#12}} bits découpe sa pleine échelle en {{#4096}} paliers. Sous 3,3 V, un palier vaut environ {{#0.8:0.05}} mV.",
      caseSensitive: false,
      shuffleOptions: true,
    },
    explanation: "2^12 = 4096 paliers ; 3,3 V / 4096 ≈ 0,8 mV.",
  }),

  /*
   * `p3` — the pool this browser only READS (`poolMembers`). Its questions
   * exist so the read-only screen has something to show: without rows it is
   * an empty state, and an empty state shows none of the actions the role is
   * supposed to have taken away.
   */
  makeQuestion({
    poolId: "p3",
    type: "mcq",
    internalName: "ao-gain-inverseur",
    categoryId: "k8",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["amplificateur", "gain"],
    config: mcqConfig(
      "Un montage inverseur a `R1 = 1 kΩ` en entrée et `R2 = 10 kΩ` en contre-réaction. Quel est son gain ?",
      [
        ["-10", true],
        ["+10", false],
        ["-0,1", false],
        ["+11", false],
      ],
    ),
    explanation: "Le gain d'un inverseur vaut `-R2 / R1`, soit -10.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 45 }],
  }),
  makeQuestion({
    poolId: "p3",
    type: "short",
    internalName: "ao-slew-rate",
    categoryId: "k8",
    difficulty: 3,
    shuffleable: false,
    randomizable: false,
    tags: ["amplificateur"],
    config: shortNumber(
      "Un AOP a un slew rate de 0,5 V/µs. Quelle est la durée minimale d'un front de 5 V ? Répondez en µs.",
      10,
      "µs",
    ),
    explanation: "5 V / 0,5 V·µs⁻¹ = 10 µs.",
    published: [
      { number: 1, changeNote: "Première version", daysAgo: 30 },
      { number: 2, changeNote: "Unité précisée dans l'énoncé", daysAgo: 8 },
    ],
  }),
  makeQuestion({
    poolId: "p3",
    type: "cloze",
    internalName: "filtre-rc-passe-bas",
    categoryId: "k9",
    difficulty: 2,
    shuffleable: true,
    randomizable: false,
    tags: ["filtre", "gain"],
    config: {
      configVersion: 2,
      text: "Un RC série est un filtre {{passe-bas|passe-haut}} dont la fréquence de coupure vaut 1 / (2π{{RC}}).",
      caseSensitive: false,
      shuffleOptions: true,
    },
    explanation: "La sortie est prise aux bornes du condensateur : les hautes fréquences y tombent.",
    published: [{ number: 1, changeNote: "Première version", daysAgo: 16 }],
  }),
  makeQuestion({
    poolId: "p3",
    type: "mcq",
    internalName: "filtre-ordre-pente",
    categoryId: "k9",
    difficulty: 4,
    shuffleable: true,
    randomizable: false,
    tags: ["filtre"],
    config: mcqConfig("Quelle est la pente d'atténuation d'un filtre passif du second ordre ?", [
      ["-20 dB/décade", false],
      ["-40 dB/décade", true],
      ["-6 dB/octave", false],
      ["-3 dB/décade", false],
    ]),
    explanation: "Chaque ordre ajoute -20 dB/décade ; le second ordre en donne -40.",
  }),
];

/**
 * One published version is deprecated, like one question is unpublished: the
 * amber badge of the pool table, of the evaluation's question picker and of
 * its item table is then a state of the data rather than a prop.
 */
const deprecated = questions.find((q) => q.internalName === "fopen-modes")?.versions.at(-1);
if (deprecated) {
  deprecated.deprecatedAt = iso(-3 * D);
  deprecated.deprecationNote = "Remplacée par une question sur les modes binaires.";
}

/** `?many=1`: a pool long enough to need the cursor and the "load more" row. */
function inflatePool() {
  const topics = [
    ["boucles", "Une boucle `for` qui compte à rebours"],
    ["chaines", "Longueur d'une chaîne sans `strlen`"],
    ["structs", "Taille d'une structure alignée"],
    ["recursion", "Factorielle récursive"],
    ["makefile", "Une règle implicite de `make`"],
    ["bits", "Masquage d'un bit de poids faible"],
  ];
  for (let i = 0; i < 60; i += 1) {
    const [tag, title] = topics[i % topics.length]!;
    questions.push(
      makeQuestion({
        poolId: "p1",
        type: (["mcq", "short", "cloze", "code"] as const)[i % 4]!,
        internalName: `${tag}-${String(i + 1).padStart(2, "0")}`,
        categoryId: categories[i % 5]!.id,
        difficulty: (i % 5) + 1,
        shuffleable: true,
        randomizable: false,
        tags: [tag!],
        config:
          i % 4 === 0
            ? mcqConfig(`${title} — que se passe-t-il ?`, [
                ["Le programme compile et affiche la bonne valeur", true],
                ["Le programme ne compile pas", false],
              ])
            : i % 4 === 1
              ? shortNumber(`${title} — combien d'itérations ?`, 10 + i)
              : i % 4 === 2
                ? {
                    configVersion: 2,
                    text: `${title} : le compteur vaut {{#${i}}} à la sortie.`,
                    caseSensitive: false,
                    shuffleOptions: true,
                  }
                : codeConfig(`${title}`, SUM_TEMPLATE, [
                    { name: "cas nominal", stdin: "", expected: "150", visible: true },
                  ]),
        published: [{ number: 1, changeNote: "Première version", daysAgo: (i % 40) + 1 }],
      }),
    );
  }
}

/** `?empty=1`: one pool with nothing in it, so the empty states are reachable. */
function stripPool() {
  questions.length = 0;
  categories.length = 0;
  pools.length = 0;
  for (const key of Object.keys(poolMembers)) delete poolMembers[key];
  notifications.length = 0;
  for (const key of Object.keys(coursePools)) coursePools[key] = [];
}

/** `?many=1`: an inbox the badge cannot count on one hand. */
function inflateNotifications() {
  for (let i = 0; i < 12; i += 1) {
    notifications.push({
      id: `n${i + 10}`,
      payload: {
        kind: "pool_shared",
        poolId: "p1",
        poolName: `Banque ${i + 1}`,
        role: i % 2 === 0 ? "reader" : "contributor",
        byName: i % 3 === 0 ? "Grace Hopper" : "Ada Lovelace",
      },
      createdAt: iso(-(i + 1) * H),
      readAt: null,
    });
  }
  notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

if (flags.many) {
  inflatePool();
  inflateNotifications();
}
if (flags.empty) stripPool();

// --- Views -----------------------------------------------------------------

const liveQuestions = (poolId: string) => questions.filter((q) => q.poolId === poolId);

/** The caller's own seat on a pool; the owner account always has one. */
const myMembership = (poolId: string): MockMember | undefined =>
  (poolMembers[poolId] ?? []).find((m) => m.userId === (me?.id ?? "u-me"));

const poolOwnerName = (pool: MockPool) => {
  const owner = (poolMembers[pool.id] ?? []).find((m) => m.userId === pool.ownerId);
  return owner ? `${owner.givenName} ${owner.familyName}` : "—";
};

export const poolSummary = (pool: MockPool) => ({
  ...pool,
  questionCount: liveQuestions(pool.id).filter((q) => !q.deletedAt).length,
  // The server sends the caller's EFFECTIVE role; a pool with no member row
  // at all is one this browser just created, so it is theirs.
  role: myMembership(pool.id)?.role ?? (pool.ownerId === (me?.id ?? "u-me") ? "owner" : "reader"),
  ownerName: poolOwnerName(pool),
  memberCount: (poolMembers[pool.id] ?? []).filter((m) => m.userId !== pool.ownerId).length,
});

interface TreeNode extends MockCategory {
  children: TreeNode[];
}

const categoryTree = (poolId: string): TreeNode[] => {
  const nodes = new Map<string, TreeNode>();
  const rows = categories
    .filter((c) => c.poolId === poolId)
    .sort((a, b) => a.position - b.position);
  for (const row of rows) nodes.set(row.id, { ...row, children: [] });
  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};

const poolTags = (poolId: string) =>
  [...new Set(liveQuestions(poolId).flatMap((q) => q.tags))].sort();

/**
 * The descriptions a teacher wrote in this session, keyed `poolId\u0000tag`.
 * A few are pre-written: the tag field is about a documented vocabulary, and
 * an empty column would show none of it.
 */
const tagDescriptions = new Map<string, string>([
  ["p1\u0000pointeurs", "Adresses, déréférencement, arithmétique de pointeurs"],
  ["p1\u0000memoire", "malloc, free et la durée de vie des objets"],
  ["p1\u0000securite", "Débordements, entrées non validées, comportements indéfinis"],
  ["p1\u0000tableaux", "Tableaux, indices et leur relation aux pointeurs"],
]);

/** `GET /pools/:id/tags`: the vocabulary of the pool, with its usage counts. */
const poolTagDetails = (poolId: string) =>
  poolTags(poolId).map((tag) => ({
    tag,
    description: tagDescriptions.get(`${poolId}\u0000${tag}`) ?? "",
    count: liveQuestions(poolId).filter((q) => q.tags.includes(tag)).length,
  }));

const questionRow = (q: MockQuestion) => ({
  id: q.id,
  type: q.type,
  internalName: q.internalName,
  difficulty: q.difficulty,
  tags: q.tags,
  categoryId: q.categoryId,
  latestNumber: q.versions.at(-1)?.number ?? null,
  hasDraftChanges:
    q.versions.length === 0 ||
    JSON.stringify(q.versions.at(-1)!.config) !== JSON.stringify(q.draft.config),
  updatedAt: q.updatedAt,
  deprecated: q.versions.at(-1)?.deprecatedAt !== null && q.versions.length > 0,
  deletedAt: q.deletedAt,
});

const questionMeta = (q: MockQuestion) => ({
  id: q.id,
  poolId: q.poolId,
  type: q.type,
  internalName: q.internalName,
  categoryId: q.categoryId,
  difficulty: q.difficulty,
  shuffleable: q.shuffleable,
  randomizable: q.randomizable,
  tags: q.tags,
  createdBy: "u-me",
  originQuestionId: null,
  deletedAt: q.deletedAt,
  updatedAt: q.updatedAt,
});

const versionRow = (v: MockVersion) => ({
  number: v.number,
  publishedAt: v.publishedAt,
  publishedBy: v.publishedBy,
  changeNote: v.changeNote,
  deprecatedAt: v.deprecatedAt,
  deprecationNote: v.deprecationNote,
});

/** What the editor loads: the meta, the draft, the versions and the latest one. */
export const questionDetail = (q: MockQuestion) => ({
  meta: questionMeta(q),
  draft: {
    config: q.draft.config,
    explanation: q.draft.explanation,
    configVersion: 1,
    updatedAt: q.updatedAt,
    valid: draftIssues(q).length === 0,
  },
  versions: q.versions.map(versionRow),
  latestPublished: q.versions.length ? versionRow(q.versions.at(-1)!) : null,
});

/**
 * A deliberately small stand-in for `configSchema.parse` (decision D16): it
 * catches the mistakes a teacher actually makes on these screens, so the
 * "publication refused" path is reachable in the mock.
 */
function draftIssues(q: MockQuestion): { path: string[]; code: string; message: string }[] {
  const config = q.draft.config as Record<string, unknown>;
  const out: { path: string[]; code: string; message: string }[] = [];
  const prompt = typeof config.prompt === "string" ? config.prompt : "";
  if (q.type !== "cloze" && prompt.trim() === "") {
    out.push({ path: ["prompt"], code: "too_small", message: "String must contain at least 1 character(s)" });
  }
  if (q.type === "mcq") {
    const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
    if (!choices.some((c) => c.correct)) {
      out.push({ path: ["choices"], code: "custom", message: "mcq.no_correct_choice" });
    }
    if (config.mode === "single" && choices.filter((c) => c.correct).length > 1) {
      out.push({ path: ["choices"], code: "custom", message: "mcq.single_needs_one" });
    }
    // A cap below the key set makes the full mark unreachable. The editor
    // says so at the keystroke; this is the SERVER's copy of it, so the mock
    // answers a save the way the API does.
    if (
      typeof config.maxSelections === "number" &&
      config.maxSelections < choices.filter((c) => c.correct).length
    ) {
      out.push({ path: ["maxSelections"], code: "custom", message: "mcq.max_below_correct" });
    }
    choices.forEach((choice, i) => {
      if (choice.text.trim() === "") {
        out.push({
          path: ["choices", String(i), "text"],
          code: "too_small",
          message: "String must contain at least 1 character(s)",
        });
      }
    });
  }
  if (q.type === "cloze") {
    const parse = parseCloze(String(config.text ?? ""));
    if (parse.blanks.length === 0) {
      out.push({ path: ["text"], code: "custom", message: "cloze.no_blank" });
    }
  }
  return out;
}

/** `toStudent`, as the server's registry would do it (seed 0, no shuffle). */
export function studentView(q: MockQuestion, config: Record<string, unknown>): unknown {
  switch (q.type) {
    case "mcq": {
      const choices = (config.choices ?? []) as { text: string }[];
      return {
        prompt: config.prompt,
        choices: choices.map((c, id) => ({ id, text: c.text })),
        mode: config.mode,
        ...(config.maxSelections === undefined ? {} : { maxSelections: config.maxSelections }),
      };
    }
    case "short":
      return {
        prompt: config.prompt,
        kind: config.kind,
        // Not part of the key: what the FIELD takes (`toStudent` in
        // `@quiz/qt-short/server` sends the same thing).
        constraints: shortConstraints(config),
        ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      };
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""));
      return clozeStudentTemplate(parse, 0, q.id, false);
    }
    case "circuit": {
      const stimuli = (config.stimuli ?? []) as CircuitStimulusLike[];
      const visible = stimuli.filter((st) => st.visible !== false);
      const hidden = stimuli.filter((st) => st.visible === false);
      return {
        prompt: config.prompt,
        palette: config.palette,
        supplies: config.supplies,
        commonGround: config.commonGround !== false,
        // The reference and the hidden stimuli stop HERE, exactly as
        // `toStudent` stops them server-side (invariant 4).
        visibleStimuli: visible.map((st) => ({
          name: st.name,
          source: st.source,
          sourceOhms: st.sourceOhms ?? 0,
          load: st.load,
          analysis: st.analysis,
          points: st.points,
        })),
        hiddenCount: hidden.length,
        hiddenPoints: hidden.reduce((sum, st) => sum + st.points, 0),
        canSimulate: visible.length > 0,
        showExpected: config.showExpected === true,
        simulationsPerMinute: config.simulationsPerMinute ?? 10,
      };
    }
    case "code": {
      const cases = ((config.tests as { cases?: CodeCaseLike[] })?.cases ?? []) as CodeCaseLike[];
      const visible = cases.filter((c) => c.visible);
      const hidden = cases.filter((c) => !c.visible);
      return {
        prompt: config.prompt,
        language: config.language,
        runtime: config.runtime ?? "backend",
        segments: splitTemplate(String(config.template ?? ""), "c"),
        limits: config.limits,
        runsPerMinute: config.runsPerMinute,
        visibleCases: visible.map((c) => ({
          name: c.name,
          args: c.args ?? [],
          stdin: c.stdin,
          expected: c.compareStdout === false ? "" : c.expected,
          compareStdout: c.compareStdout ?? true,
          expectedExitCode: c.expectedExitCode === undefined ? 0 : c.expectedExitCode,
          points: c.points,
        })),
        hiddenCount: hidden.length,
        hiddenPoints: hidden.reduce((sum, c) => sum + c.points, 0),
        filesPreview: [],
        allOrNothing: config.allOrNothing === true,
      };
    }
  }
}

export interface CircuitStimulusLike {
  name: string;
  source: unknown;
  sourceOhms?: number;
  load: unknown;
  analysis: unknown;
  points: number;
  visible?: boolean;
}

export interface CodeCaseLike {
  name: string;
  args?: string[];
  stdin: string;
  expected: string;
  compareStdout?: boolean;
  expectedExitCode?: number | null;
  visible: boolean;
  points: number;
}

/**
 * `POST /try`, in the browser. Grading is deliberately naive — it exists so
 * the panel has something true to render — and `code` answers the same
 * `runner_unavailable` a machine without a container engine answers
 * (decision D14).
 */
/**
 * The applied MCQ policy (docs/04 §4.4): the question's own, or the
 * evaluation's when it says `inherit`, or `all_or_nothing` when there is no
 * evaluation at all — which is what the teacher's Try panel is.
 */
function mcqPolicyOf(
  config: Record<string, unknown>,
  evaluationPolicy: McqScorePolicy | null,
): McqScorePolicy {
  if (config.mode === "single") return "all_or_nothing";
  const own = config.policy;
  if (typeof own === "string" && own !== "inherit") return own as McqScorePolicy;
  return evaluationPolicy ?? "all_or_nothing";
}


/*
 * The two adapters the rest of the mock reads a question through. They live
 * here, with the question they describe, rather than in `evaluation.ts`
 * where the frozen item needs them: `tryAnswer` below is their first caller,
 * and a pool that had to import the evaluations to grade a try would be a
 * cycle in the module graph.
 */
/** The config an item is frozen on: the last published one, or the draft. */
export const frozenConfig = (q: MockQuestion): Record<string, unknown> =>
  q.versions.at(-1)?.config ?? q.draft.config;

/** The key, in the shape each type's `Review` reads (`solutionSchema`). */
export function solutionOf(q: MockQuestion): unknown {
  const config = frozenConfig(q);
  switch (q.type) {
    case "mcq": {
      const choices = (config.choices ?? []) as { correct: boolean }[];
      return { correct: choices.flatMap((c, i) => (c.correct ? [i] : [])) };
    }
    case "short": {
      const matchers = (config.matchers ?? []) as { value?: unknown }[];
      return { expected: matchers.map((m) => String(m.value)) };
    }
    case "cloze": {
      const parse = parseCloze(String(config.text ?? ""));
      return { blanks: parse.blanks.map((b) => ({ index: b.index, expected: describeBlank(b) })) };
    }
    case "code": {
      const tests = (config.tests ?? {}) as { compare?: unknown; cases?: CodeCaseLike[] };
      return {
        referenceSolution: String(config.referenceSolution ?? ""),
        cases: (tests.cases ?? []).map((c) => ({
          name: c.name,
          args: c.args ?? [],
          stdin: c.stdin,
          expected: c.expected,
          compareStdout: c.compareStdout ?? true,
          expectedExitCode: c.expectedExitCode === undefined ? 0 : c.expectedExitCode,
          points: c.points,
          visible: c.visible,
        })),
        compare: tests.compare,
      };
    }
    case "circuit":
      return {
        reference: config.reference ?? null,
        stimuli: config.stimuli ?? [],
        grading: config.grading ?? { mode: "manual", tolerance: 0.05, rubric: "" },
      };
  }
}

export function tryAnswer(
  q: MockQuestion,
  config: Record<string, unknown>,
  answer: unknown,
  evaluationPolicy: McqScorePolicy | null = null,
): unknown {
  if (q.type === "code") return { status: "runner_unavailable", reason: "not_configured" };
  /*
   * `circuit` does NOT answer `runner_unavailable`: the mock has a real
   * ngspice transient to hand, so the teacher's "Simulate the reference" and
   * the try panel's review both show the waveforms a working deployment
   * would. The mode stays `manual`, so the verdict is still the teacher's.
   */
  if (q.type === "circuit") {
    const stimuli = (config.stimuli ?? []) as CircuitStimulusLike[];
    const student = studentView(q, config) as CircuitStudent;
    const schematic =
      (answer as { schematic?: MockSchematic } | null)?.schematic ?? EMPTY_SCHEMATIC;
    const built = mockCircuitDetails(student, stimuli, schematic);
    const total = stimuli.reduce((sum, st) => sum + st.points, 0);
    return {
      status: "graded",
      points: Math.round(built.fraction * total * 100) / 100,
      maxPoints: total,
      details: built.details,
      solution: solutionOf(q),
    };
  }
  if (q.type === "mcq") {
    const choices = (config.choices ?? []) as { text: string; correct: boolean }[];
    const correct = choices.flatMap((c, i) => (c.correct ? [i] : []));
    // The five formulas come from `@quiz/domain`, never reimplemented here:
    // the mock must score exactly what the server would.
    const policy = mcqPolicyOf(config, evaluationPolicy);
    const { selected, truncated } = truncateSelection(
      (answer as { selected?: number[] } | null)?.selected ?? [],
      (config.maxSelections as number | undefined) ?? null,
    );
    const score = mcqFraction({ correct, selected, choiceCount: choices.length, policy });
    return {
      status: "graded",
      points: Math.round(score.fraction * 100) / 100,
      maxPoints: 1,
      details: {
        policy,
        correct,
        selected,
        c: score.c,
        w: score.w,
        C: score.C,
        W: score.W,
        fraction: score.fraction,
        truncated,
      },
      solution: { correct },
    };
  }
  if (q.type === "short") {
    const matchers = (config.matchers ?? []) as { kind: string; value?: unknown }[];
    // The v2 prefilters, applied to the answer AND to every expected text,
    // exactly as `@quiz/qt-short` does it.
    const filter = shortPrefilter(config);
    const text = filter(String((answer as { text?: string } | null)?.text ?? ""));
    const index = matchers.findIndex((m) =>
      m.kind === "number"
        ? Number(text.replace(",", ".")) === Number(m.value)
        : text === filter(String(m.value)),
    );
    return {
      status: "graded",
      points: index >= 0 ? 1 : 0,
      maxPoints: 1,
      details: {
        matchedIndex: index >= 0 ? index : null,
        matchedKind: index >= 0 ? matchers[index]!.kind : null,
        normalized: text,
        fraction: index >= 0 ? 1 : 0,
      },
      solution: { expected: matchers.map((m) => String(m.value)) },
    };
  }
  const parse = parseCloze(String(config.text ?? ""));
  const given = ((answer as { blanks?: (string | null)[] } | null)?.blanks ?? []) as (string | null)[];
  const perBlank = parse.blanks.map((blank, i) => ({
    index: blank.index,
    weight: blank.weight,
    kind: blank.kind,
    ok: matchBlank(blank, given[i] ?? null, config.caseSensitive === true),
    given: given[i] ?? null,
    expected: describeBlank(blank),
  }));
  const earned = perBlank.filter((b) => b.ok).reduce((sum, b) => sum + b.weight, 0);
  const total = parse.blanks.reduce((sum, b) => sum + b.weight, 0) || 1;
  return {
    status: "graded",
    points: Math.round((earned / total) * 100) / 100,
    maxPoints: 1,
    details: { perBlank, earned, total, fraction: earned / total },
    solution: { blanks: parse.blanks.map((b) => ({ index: b.index, expected: describeBlank(b) })) },
  };
}

// --- Routes ----------------------------------------------------------------

export const poolOr404 = (id: string) => {
  const pool = pools.find((p) => p.id === id);
  if (!pool) throw new MockError(404, "Pool not found");
  return pool;
};
export const questionOr404 = (id: string) => {
  const q = questions.find((x) => x.id === id);
  if (!q) throw new MockError(404, "Question not found");
  return q;
};

on("GET", "/app/api/pools", () => pools.map(poolSummary));
on("POST", "/app/api/pools", (_m, body) => {
  const pool: MockPool = {
    id: nextId("p"),
    name: String(body.name),
    icon: typeof body.icon === "string" ? body.icon : null,
    visibility: "private",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: iso(0),
    updatedAt: iso(0),
  };
  pools.push(pool);
  poolMembers[pool.id] = [{ ...ME_MEMBER, role: "owner", addedAt: iso(0) }];
  return poolSummary(pool);
});
on("GET", "/app/api/pools/:id", (m) => {
  const pool = poolOr404(m.groups!.id!);
  return {
    pool,
    role: poolSummary(pool).role,
    categories: categoryTree(pool.id),
    tags: poolTags(pool.id),
    questionCount: liveQuestions(pool.id).filter((q) => !q.deletedAt).length,
  };
});
on("PATCH", "/app/api/pools/:id", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  if (typeof body.name === "string") pool.name = body.name;
  // `icon: null` is a real value (the default icon), so the key being THERE
  // is what decides, not its truthiness.
  if ("icon" in body) pool.icon = typeof body.icon === "string" ? body.icon : null;
  if (typeof body.visibility === "string") {
    pool.visibility = body.visibility as MockPool["visibility"];
  }
  pool.updatedAt = iso(0);
  return poolSummary(pool);
});
on("DELETE", "/app/api/pools/:id", (m) => {
  const i = pools.findIndex((p) => p.id === m.groups!.id);
  if (i >= 0) pools.splice(i, 1);
  delete poolMembers[m.groups!.id!];
  return undefined;
});

// --- Pool members and the bell (F-POOL-05) --------------------------------

/** `PoolMembers`, which is also what the two write routes answer with. */
const memberList = (pool: MockPool) => ({
  visibility: pool.visibility,
  // The owner's row first, whatever order the seats were given in.
  members: [...(poolMembers[pool.id] ?? [])]
    .sort((a, b) => Number(b.userId === pool.ownerId) - Number(a.userId === pool.ownerId))
    .map((mem) => ({ ...mem, isOwner: mem.userId === pool.ownerId })),
});

on("GET", "/app/api/pools/:id/members", (m) => memberList(poolOr404(m.groups!.id!)));
/** `PoolCandidates`: the teachers with an account, not yet seated, by name or address. */
on("GET", "/app/api/pools/:id/candidates", (m, _body, url) => {
  const pool = poolOr404(m.groups!.id!);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const seated = new Set([pool.ownerId, ...(poolMembers[pool.id] ?? []).map((mem) => mem.userId)]);
  return teachers
    .filter((t) => t.signedUp && !seated.has(t.id))
    .filter((t) => `${t.givenName ?? ""} ${t.familyName ?? ""} ${t.email}`.toLowerCase().includes(q))
    .slice(0, 10)
    .map((t) => ({
      userId: t.id,
      email: t.email,
      givenName: t.givenName ?? "",
      familyName: t.familyName ?? "",
    }));
});
on("POST", "/app/api/pools/:id/members", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const email = String(body.email ?? "").trim().toLowerCase();
  // Picked in the list (`userId`), or spelled out as an address.
  const found = teachers.find((t) =>
    body.userId !== undefined ? t.id === body.userId : t.email.toLowerCase() === email,
  );
  if (!found) throw new MockError(404, "No teacher account with this e-mail.");
  const rows = (poolMembers[pool.id] ??= []);
  if (rows.some((mem) => mem.userId === found.id)) {
    throw new MockError(409, "This teacher already has access to the pool.");
  }
  rows.push({
    userId: found.id,
    email: found.email,
    givenName: found.givenName ?? found.email.split(".")[0] ?? "",
    familyName: found.familyName ?? "",
    role: (body.role as MockMember["role"] | undefined) ?? "reader",
    addedAt: iso(0),
  });
  // Inviting someone is what makes a pool shared, exactly as the API does it.
  if (pool.visibility === "private") pool.visibility = "shared";
  return memberList(pool);
});
on("PATCH", "/app/api/pools/:id/members/:userId", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const row = (poolMembers[pool.id] ?? []).find((mem) => mem.userId === m.groups!.userId);
  if (!row) throw new MockError(404, "Member not found");
  row.role = body.role as MockMember["role"];
  return memberList(pool);
});
on("DELETE", "/app/api/pools/:id/members/:userId", (m) => {
  const pool = poolOr404(m.groups!.id!);
  const rows = poolMembers[pool.id] ?? [];
  const i = rows.findIndex((mem) => mem.userId === m.groups!.userId);
  if (i >= 0) rows.splice(i, 1);
  // Leaving a pool someone else owns takes it off my shelf.
  if (m.groups!.userId === (me?.id ?? "u-me") && pool.ownerId !== (me?.id ?? "u-me")) {
    const p = pools.findIndex((x) => x.id === pool.id);
    if (p >= 0) pools.splice(p, 1);
  }
  return undefined;
});

/** `NotificationList`: the capped page, and the unread count of the WHOLE inbox. */
const notificationList = (limit = 30) => ({
  items: notifications.slice(0, limit),
  unread: notifications.filter((n) => n.readAt === null).length,
});

on("GET", "/app/api/notifications", (_m, _body, url) =>
  notificationList(Number(url.searchParams.get("limit") ?? 30)),
);
// Both writes answer with the inbox as it now stands, like the API: the bell
// adopts the reply instead of asking for the list a second time.
on("POST", "/app/api/notifications/:id/read", (m) => {
  const row = notifications.find((n) => n.id === m.groups!.id);
  if (!row) throw new MockError(404, "Notification not found");
  row.readAt ??= iso(0);
  return notificationList();
});
on("POST", "/app/api/notifications/read-all", () => {
  for (const row of notifications) row.readAt ??= iso(0);
  return notificationList();
});
on("GET", "/app/api/pools/:id/tags", (m) => poolTagDetails(poolOr404(m.groups!.id!).id));
on("PATCH", "/app/api/pools/:id/tags/:tag", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const tag = decodeURIComponent(m.groups!.tag!).toLowerCase();
  const description = String(body.description ?? "");
  tagDescriptions.set(`${pool.id}\u0000${tag}`, description);
  return {
    tag,
    description,
    count: liveQuestions(pool.id).filter((q) => q.tags.includes(tag)).length,
  };
});

on("POST", "/app/api/pools/:id/categories", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const parentId = (body.parentId as string | null | undefined) ?? null;
  const category: MockCategory = {
    id: nextId("k"),
    poolId: pool.id,
    parentId,
    name: String(body.name),
    position: categories.filter((c) => c.poolId === pool.id && c.parentId === parentId).length,
  };
  categories.push(category);
  return category;
});
on("PATCH", "/app/api/categories/:id", (m, body) => {
  const category = categories.find((c) => c.id === m.groups!.id);
  if (!category) throw new MockError(404, "Category not found");
  if (typeof body.name === "string") category.name = body.name;
  if (body.parentId !== undefined) category.parentId = body.parentId as string | null;
  if (typeof body.position === "number") category.position = body.position;
  return category;
});
on("PUT", "/app/api/pools/:id/categories/order", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  for (const item of (body.items ?? []) as { id: string; parentId: string | null; position: number }[]) {
    const category = categories.find((c) => c.id === item.id && c.poolId === pool.id);
    if (category) {
      category.parentId = item.parentId;
      category.position = item.position;
    }
  }
  return categoryTree(pool.id);
});
on("DELETE", "/app/api/categories/:id", (m) => {
  const id = m.groups!.id!;
  const gone = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parentId && gone.has(c.parentId) && !gone.has(c.id)) {
        gone.add(c.id);
        grew = true;
      }
    }
  }
  for (let i = categories.length - 1; i >= 0; i -= 1) {
    if (gone.has(categories[i]!.id)) categories.splice(i, 1);
  }
  for (const q of questions) if (q.categoryId && gone.has(q.categoryId)) q.categoryId = null;
  return undefined;
});

on("GET", "/app/api/pools/:id/questions", (m, _body, url) => {
  const pool = poolOr404(m.groups!.id!);
  const params = url.searchParams;
  const list = params.getAll("type").flatMap((v) => v.split(","));
  const tags = params.getAll("tag").flatMap((v) => v.split(","));
  const difficulties = params.getAll("difficulty").flatMap((v) => v.split(",")).map(Number);
  const q = (params.get("q") ?? "").trim().toLowerCase();
  const categoryId = params.get("categoryId");
  const includeDeleted = params.get("includeDeleted") === "1";
  const limit = Number(params.get("limit") ?? 25);
  const cursor = params.get("cursor");
  // `versionMin` / `versionMax` are bounds on the highest PUBLISHED number,
  // so a draft-only question (no number at all) matches neither of them.
  const versionMin = params.get("versionMin");
  const versionMax = params.get("versionMax");
  const sort = params.get("sort") ?? "updated";
  const dir = params.get("dir") === "asc" ? 1 : -1;

  /** What the sorted column holds for one question, as a comparable value. */
  const rank = (question: MockQuestion): string | number => {
    switch (sort) {
      case "name":
        return question.internalName.toLowerCase();
      case "type":
        return question.type;
      case "difficulty":
        return question.difficulty;
      case "version":
        // A draft sorts below v1, which is where a teacher looks for it.
        return question.versions.at(-1)?.number ?? 0;
      default:
        return question.updatedAt;
    }
  };

  const matching = liveQuestions(pool.id)
    .filter((question) => includeDeleted || question.deletedAt === null)
    .filter((question) => list.length === 0 || list.includes(question.type))
    .filter((question) => tags.length === 0 || question.tags.some((x) => tags.includes(x)))
    .filter((question) => difficulties.length === 0 || difficulties.includes(question.difficulty))
    .filter((question) => categoryId === null || question.categoryId === categoryId)
    .filter((question) => {
      if (versionMin === null && versionMax === null) return true;
      const number = question.versions.at(-1)?.number ?? null;
      if (number === null) return false;
      return (
        (versionMin === null || number >= Number(versionMin)) &&
        (versionMax === null || number <= Number(versionMax))
      );
    })
    .filter(
      (question) =>
        q === "" ||
        question.internalName.toLowerCase().includes(q) ||
        JSON.stringify(question.draft.config).toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const x = rank(a);
      const y = rank(b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      // The internal name breaks a tie, so a page never re-shuffles under a
      // cursor that encodes the order it was cut in.
      return (cmp === 0 ? a.internalName.localeCompare(b.internalName) : cmp) * dir;
    });
  const start = cursor ? matching.findIndex((x) => x.id === cursor) + 1 : 0;
  const page = matching.slice(start, start + limit);
  const next = start + limit < matching.length ? page.at(-1)!.id : null;
  return { items: page.map(questionRow), nextCursor: next };
});

on("POST", "/app/api/pools/:id/questions", (m, body) => {
  const pool = poolOr404(m.groups!.id!);
  const type = String(body.type) as MockQuestion["type"];
  const created = makeQuestion({
    poolId: pool.id,
    type,
    internalName: String(body.internalName),
    categoryId: (body.categoryId as string | null | undefined) ?? null,
    difficulty: 3,
    shuffleable: true,
    randomizable: false,
    tags: [],
    config: emptyConfig(type),
  });
  created.updatedAt = iso(0);
  questions.push(created);
  return questionDetail(created);
});

/**
 * The `emptyDraft()` of each type, as the API pre-fills it: the shape and the
 * defaults, with NO content. It does not validate, and that is intended —
 * decision D16 stores a draft whatever it holds.
 */
export function emptyConfig(type: MockQuestion["type"]): Record<string, unknown> {
  switch (type) {
    case "mcq":
      return mcqConfig("", [
        ["", true],
        ["", false],
      ]);
    case "short":
      return {
        configVersion: 2,
        prompt: "",
        kind: "text",
        constraints: { minLength: 0, maxLength: 255, integer: false },
        prefilters: { trim: true, lowercase: true },
        matchers: [{ kind: "exact", value: "", points: 1 }],
      };
    case "cloze":
          return { configVersion: 2, text: "", caseSensitive: false, shuffleOptions: true };
    case "code":
      return codeConfig("", "", [{ name: "", stdin: "", expected: "", visible: true }]);
    case "circuit":
      return {
        configVersion: 1,
        prompt: "",
        palette: { kinds: ["R", "C", "L", "D", "GND"], maxComponents: 10 },
        supplies: { vcc: null, vee: null },
        commonGround: true,
        stimuli: [],
        reference: null,
        grading: { mode: "manual", tolerance: 0.05, rubric: "" },
        showExpected: false,
        simulationsPerMinute: 10,
      };
  }
}

on("GET", "/app/api/questions/:id", (m) => questionDetail(questionOr404(m.groups!.id!)));
on("PATCH", "/app/api/questions/:id", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  if (typeof body.internalName === "string") q.internalName = body.internalName;
  if (body.categoryId !== undefined) q.categoryId = body.categoryId as string | null;
  if (typeof body.difficulty === "number") q.difficulty = body.difficulty;
  if (typeof body.shuffleable === "boolean") q.shuffleable = body.shuffleable;
  if (Array.isArray(body.tags)) q.tags = body.tags as string[];
  q.updatedAt = iso(0);
  return questionMeta(q);
});
on("PUT", "/app/api/questions/:id/draft", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  q.draft = {
    config: (body.config ?? {}) as Record<string, unknown>,
    explanation: typeof body.explanation === "string" ? body.explanation : q.draft.explanation,
  };
  q.updatedAt = iso(0);
  const issues = draftIssues(q);
  return { updatedAt: q.updatedAt, valid: issues.length === 0, issues };
});
on("POST", "/app/api/questions/:id/publish", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const issues = draftIssues(q);
  if (issues.length > 0) {
    throw new MockValidation("Fix the draft before publishing", issues);
  }
  const version: MockVersion = {
    number: (q.versions.at(-1)?.number ?? 0) + 1,
    publishedAt: iso(0),
    publishedBy: "u-me",
    changeNote: typeof body.changeNote === "string" ? body.changeNote : null,
    deprecatedAt: null,
    deprecationNote: null,
    config: q.draft.config,
    explanation: q.draft.explanation,
    configVersion: 1,
  };
  q.versions.push(version);
  return versionRow(version);
});
on("GET", "/app/api/questions/:id/versions", (m) =>
  questionOr404(m.groups!.id!).versions.map(versionRow),
);
on("GET", "/app/api/questions/:id/versions/:number", (m) => {
  const q = questionOr404(m.groups!.id!);
  const version = q.versions.find((v) => v.number === Number(m.groups!.number));
  if (!version) throw new MockError(404, "Version not found");
  return { ...versionRow(version), config: version.config, explanation: version.explanation, configVersion: 1 };
});
on("POST", "/app/api/questions/:id/versions/:number/restore", (m) => {
  const q = questionOr404(m.groups!.id!);
  const version = q.versions.find((v) => v.number === Number(m.groups!.number));
  if (!version) throw new MockError(404, "Version not found");
  q.draft = { config: version.config, explanation: version.explanation };
  q.updatedAt = iso(0);
  return questionDetail(q);
});
on("POST", "/app/api/questions/:id/versions/:number/deprecate", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const version = q.versions.find((v) => v.number === Number(m.groups!.number));
  if (!version) throw new MockError(404, "Version not found");
  version.deprecatedAt = iso(0);
  version.deprecationNote = String(body.note ?? "");
  return versionRow(version);
});
on("DELETE", "/app/api/questions/:id", (m) => {
  const q = questionOr404(m.groups!.id!);
  q.deletedAt = iso(0);
  return undefined;
});
on("POST", "/app/api/questions/:id/copy", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const copy = makeQuestion({
    poolId: String(body.targetPoolId ?? q.poolId),
    type: q.type,
    internalName: `${q.internalName}-copie`,
    categoryId: q.categoryId,
    difficulty: q.difficulty,
    shuffleable: q.shuffleable,
    randomizable: q.randomizable,
    tags: [...q.tags],
    config: q.draft.config,
    explanation: q.draft.explanation,
  });
  copy.updatedAt = iso(0);
  questions.push(copy);
  return questionDetail(copy);
});


on("POST", "/app/api/questions/:id/preview", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const source = body.source ?? "draft";
  const config =
    source === "draft"
      ? q.draft.config
      : (q.versions.find((v) => v.number === Number(source))?.config ?? q.draft.config);
  const issues = draftIssues(q);
  if (source === "draft" && issues.length > 0) {
    throw new MockValidation("This version cannot be rendered", issues);
  }
  return { type: q.type, student: studentView(q, config), itemPoints: 1 };
});
on("POST", "/app/api/questions/:id/try", (m, body) => {
  const q = questionOr404(m.groups!.id!);
  const source = body.source ?? "draft";
  const config =
    source === "draft"
      ? q.draft.config
      : (q.versions.find((v) => v.number === Number(source))?.config ?? q.draft.config);
  return tryAnswer(q, config, body.answer);
});
on("POST", "/app/api/pools/:id/assets", (m) => {
  poolOr404(m.groups!.id!);
  const id = nextId("a");
  return { id, url: `/app/api/assets/${id}`, mime: "image/png", bytes: 12_345, width: 640, height: 360 };
});

// The course side of `course_pools` (F-POOL-05).
on("GET", "/app/api/courses/:id", (m) => {
  const course = courseOr404(m.groups!.id!);
  return {
    course: { id: course.id, name: course.name, code: course.code },
    staff: course.staff.map((s) => ({
      userId: s.userId,
      givenName: s.givenName,
      familyName: s.familyName,
      email: s.email,
    })),
    pools: (coursePools[course.id] ?? [])
      .map((poolId) => pools.find((p) => p.id === poolId))
      .filter((p): p is MockPool => p !== undefined)
      .map(poolSummary),
    classrooms: rooms
      .filter((r) => r.courseId === course.id)
      .map((r) => ({
        id: r.id,
        name: r.name,
        period: r.period,
        archivedAt: r.archivedAt,
        joinCode: null,
        joinCodeEnabled: false,
      })),
  };
});
on("PUT", "/app/api/courses/:id/pools", (m, body) => {
  const course = courseOr404(m.groups!.id!);
  coursePools[course.id] = (body.poolIds as string[] | undefined) ?? [];
  return coursePools[course.id]!
    .map((poolId) => pools.find((p) => p.id === poolId))
    .filter((p): p is MockPool => p !== undefined)
    .map(poolSummary);
});

