/**
 * The evidence of a project graded by criteria (ADR-106 §3): what the
 * tests said ({@link parseJunit}, pytest's JUnit XML) and what an automatic criterion
 * is worth from it ({@link automaticPoints}); and the tarball's paths
 * without GitHub's top-level directory ({@link stripTarballRoot}), which
 * carries the student's login. Pure: the `project` module fetches, runs
 * and stores.
 */
import type { CriteriaLeaf } from "./criteria.js";

/**
 * What an evidence run came to (ADR-106 §3): `ok` — the runner answered
 * with its steps; otherwise why there is no evidence, which is also the
 * reason of the 0-point rows of the automatic criteria: no student commit
 * by the deadline, a tarball over the cap, a repository gone from GitHub,
 * the runner unreachable, refusing the archive, or busy past the API's
 * wait.
 */
export const EVIDENCE_STATUSES = [
  "ok",
  "no_commit",
  "archive_too_large",
  "repo_missing",
  "runner_unavailable",
  "refused",
  "timed_out",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** One test case of a JUnit report. */
export interface JunitCase {
  name: string;
  classname: string;
  /** False for a failure, an error and a skipped case alike. */
  passed: boolean;
  /** The failure's, the error's or the skip's `message`, when it has one. */
  message?: string;
}

export interface JunitReport {
  cases: JunitCase[];
  passed: number;
  total: number;
}

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** An attribute value with its XML entities decoded (named and numeric). */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? whole;
  });
}

function attributes(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const [, key, double, single] of text.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.set(key!, decodeXml(double ?? single ?? ""));
  }
  return attrs;
}

const TESTCASE = /<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g;
const OUTCOME = /<(failure|error|skipped)\b((?:[^>"']|"[^"]*"|'[^']*')*)/;

/**
 * The test cases of a JUnit XML report as pytest writes it
 * (`--junitxml`): a case is passed unless it holds a `<failure>`, an
 * `<error>` or a `<skipped>`. Text that is not a report yields no case:
 * the automatic criteria then get nothing.
 */
export function parseJunit(xml: string): JunitReport {
  const cases: JunitCase[] = [];
  for (const [, attrText, body] of xml.matchAll(TESTCASE)) {
    const attrs = attributes(attrText ?? "");
    const outcome = body === undefined ? null : OUTCOME.exec(body);
    const message = outcome ? attributes(outcome[2] ?? "").get("message") : undefined;
    cases.push({
      name: attrs.get("name") ?? "",
      classname: attrs.get("classname") ?? "",
      passed: outcome === null,
      ...(message === undefined ? {} : { message }),
    });
  }
  return { cases, passed: cases.filter((c) => c.passed).length, total: cases.length };
}

/** `tests/test_a.py::TestX::test_one` as JUnit's dotted `classname.name`: `tests.test_a.TestX.test_one`. */
function dottedNodeId(test: string): string {
  return test.replace(/\.py(?=::|$)/, "").replace(/::/g, ".").replace(/\//g, ".");
}

/**
 * Whether a case is one a `test:` leaf covers: its name, or its dotted node
 * id, starts with the leaf's value. A plain prefix, on purpose:
 * `tests/test_parse.py` also covers `tests/test_parse_extra.py`.
 */
export function coversCase(test: string, testCase: Pick<JunitCase, "name" | "classname">): boolean {
  if (testCase.name.startsWith(test)) return true;
  const id = testCase.classname === "" ? testCase.name : `${testCase.classname}.${testCase.name}`;
  return id.startsWith(dottedNodeId(test));
}

/** Points rounded to the half point, as StudentScore's prorata. */
const toHalf = (points: number) => Math.round(points * 2) / 2;

/**
 * Whether the evidence proposes an automatic criterion's points: only a
 * criterion worth positive points. A penalty (negative points) or a bonus
 * carrying `test:` gets no `auto` row: its points are the teacher's
 * (StudentScore has no prorata for them).
 */
export const proratedByTests = (leaf: Pick<CriteriaLeaf, "maxPoints" | "bonusPoints">): boolean =>
  leaf.maxPoints > 0 && leaf.bonusPoints === undefined;

/**
 * An automatic criterion's points from the evidence's cases (ADR-106 §2),
 * StudentScore's prorata: its points times the share of passed cases among
 * those it covers — every case for the project's tests criterion, the
 * cases {@link coversCase} names for a `test:` leaf —, rounded to the half
 * point. No case covered counts as none passed. Only for a criterion
 * {@link proratedByTests}: the caller filters.
 */
export function automaticPoints(
  leaf: Pick<CriteriaLeaf, "id" | "maxPoints" | "test">,
  cases: readonly Pick<JunitCase, "name" | "classname" | "passed">[],
  testsCriterion: string,
): number {
  const covered = leaf.id === testsCriterion || leaf.test === undefined ? cases : cases.filter((c) => coversCase(leaf.test!, c));
  const share = covered.length === 0 ? 0 : covered.filter((c) => c.passed).length / covered.length;
  return toHalf(share * leaf.maxPoints);
}

/**
 * The paths of a GitHub tarball without its top-level directory
 * (`<owner>-<repo>-<sha>/`, which carries the student's login): each entry
 * whose path is under the first entry's top segment, re-rooted; the
 * top directory itself and any entry outside it are dropped.
 */
export function stripTarballRoot<T extends { path: string }>(entries: readonly T[]): T[] {
  const first = entries[0];
  if (first === undefined) return [];
  const root = `${first.path.split("/")[0]!}/`;
  return entries.flatMap((entry) => {
    if (!entry.path.startsWith(root)) return [];
    const path = entry.path.slice(root.length);
    return path === "" ? [] : [{ ...entry, path }];
  });
}
