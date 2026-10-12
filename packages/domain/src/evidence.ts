/**
 * The evidence of a project graded by criteria (ADR-106 §3): what the
 * tests said ({@link parseJunit}, pytest's JUnit XML) and what an automatic criterion
 * is worth from it ({@link automaticPoints}); and the tarball's paths
 * without GitHub's top-level directory ({@link stripTarballRoot}), which
 * carries the student's login; what the identity criterion is worth from
 * the commits' metadata ({@link commitIdentityPoints}). Pure: the `project`
 * module fetches, runs and stores.
 */
import type { CriteriaLeaf } from "./criteria.js";

/**
 * What an evidence run came to (ADR-106 §3): `ok` — the runner answered
 * with its steps; otherwise why there is no evidence, which is also the
 * reason of the 0-point rows of the automatic criteria: no student commit
 * by the deadline, a tarball over the cap, a repository gone from GitHub,
 * GitHub failing otherwise (the App, the distribution's head, the tarball's
 * download: try again by a Regrade), the runner unreachable, refusing the
 * archive, or busy past the API's wait.
 */
export const EVIDENCE_STATUSES = [
  "ok",
  "no_commit",
  "archive_too_large",
  "repo_missing",
  "github_unavailable",
  "runner_unavailable",
  "refused",
  "timed_out",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** The JUnit report the default test command writes: its cases are the evidence's summary, never a source. */
export const REPORT_FILE = "report.xml";

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
    attrs.set(key!, decodeXml(double ?? single!));
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
    const attrs = attributes(attrText!);
    const outcome = body === undefined ? null : OUTCOME.exec(body);
    const message = outcome ? attributes(outcome[2]!).get("message") : undefined;
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

/**
 * `grading.sources` as the evidence run takes them (ADR-106 §4): plain
 * paths, a directory with its trailing `/`; a wildcard pattern is not one
 * (the runner brings back named paths only) — `wildcards` lists them.
 */
export function plainSources(sources: readonly string[]): { plain: string[]; wildcards: string[] } {
  const plain: string[] = [];
  const wildcards: string[] = [];
  for (const source of sources) (/[*?[]/.test(source) ? wildcards : plain).push(source.replace(/^\.\//, ""));
  return { plain, wildcards };
}

/**
 * The paths of `paths` the sources name — equal to a plain source, or under
 * a source directory — in their order; every path when there is no source.
 */
export function sourcePaths(sources: readonly string[], paths: readonly string[]): string[] {
  const { plain } = plainSources(sources);
  if (sources.length === 0) return [...paths];
  return paths.filter((path) => plain.some((source) => (source.endsWith("/") ? path.startsWith(source) : path === source)));
}

// ---------------------------------------------------------- the identity criterion (ADR-106 §2)

/**
 * A student's commit of the handed-out branch up to the evidence's target
 * (bots' and handed-out commits are not kept), as the evidence keeps it for
 * the identity criterion: personal data, never sent to the model nor shown
 * as such (the rationale masks the e-mail).
 */
export interface EvidenceCommit {
  sha: string;
  /** The author's git identity, empty when the commit carries none. */
  name: string;
  email: string;
  /** The message's first line. */
  subject: string;
}

/** The example identity of the lab's instructions (`git config user.name "Emmett Lathrop Brown"`), by its full name only. */
const EXAMPLE_NAME = /^emmett( lathrop)? brown$/i;
const EXAMPLE_EMAIL = /@example\.(com|org|net)$/i;
/** `local@domain.tld`, the domain neither a local machine's nor reserved. */
const EMAIL = /^[^\s@]+@([^\s@]+\.[a-z]{2,})$/i;
const LOCAL_DOMAIN = /(^|\.)(localhost|localdomain|local|lan|home|internal|invalid|test)$/i;
/** A name's word: letters, with an apostrophe, a hyphen or a dot inside (`O'Neil`, `Jean-Luc`, `J.`). */
const NAME_WORD = /^\p{L}[\p{L}\p{M}'’.-]*$/u;
/** Messages that say nothing, whatever their length; compared lower-cased, without the final punctuation. */
const MEANINGLESS = new Set([
  "a", "add", "change", "changes", "commit", "commit message", "done", "first commit", "fix", "fixes", "initial commit",
  "maj", "modif", "modifs", "no message", "ok", "save", "test", "tests", "update", "updates", "wip", "work in progress",
]);
/** GitHub's web editor's defaults: `Update README.md`, `Create notes.txt`, `Add files via upload`. */
const GITHUB_DEFAULT_MESSAGE = /^(update|create|delete) \S+$|^add files via upload$/i;

/** Whether a name is a person's: at least two words of letters. */
const realName = (name: string) => name.trim().split(/\s+/).filter((word) => NAME_WORD.test(word)).length >= 2;

/** Whether an address is plausible (GitHub's private address included). */
function plausibleEmail(email: string): boolean {
  const domain = EMAIL.exec(email.trim())?.[1];
  return domain !== undefined && !LOCAL_DOMAIN.test(domain);
}

/** Whether a commit's message says what it does: 3 words or 15 characters, not a meaningless one nor GitHub's default. */
export function descriptiveMessage(subject: string): boolean {
  const text = subject.trim();
  if (MEANINGLESS.has(text.toLowerCase().replace(/[.!…\s]+$/, "")) || GITHUB_DEFAULT_MESSAGE.test(text)) return false;
  return text.split(/\s+/).length >= 3 || text.length >= 15;
}

type IdentityVerdict = "missing" | "example" | "weak" | "ok";

function identityOf(commit: Pick<EvidenceCommit, "name" | "email">): IdentityVerdict {
  const name = commit.name.trim();
  const email = commit.email.trim();
  if (name === "" || email === "") return "missing";
  if (EXAMPLE_NAME.test(name.replace(/\s+/g, " ")) || EXAMPLE_EMAIL.test(email)) return "example";
  return realName(name) && plausibleEmail(email) ? "ok" : "weak";
}

/**
 * The identity criterion's points from the student's commits of the
 * handed-out branch (ADR-106 §2, labo 00's `git.commits`): 0 when there is
 * none, or when one carries no identity or the instructions' example one
 * (Emmett Brown, an `example.com` address); otherwise every point when
 * each identity is a person's (a name of two words of letters, a plausible
 * address) and each message is descriptive ({@link descriptiveMessage});
 * half of them, rounded to the half point, for one of the two faults; none
 * for both.
 */
export function commitIdentityPoints(commits: readonly Pick<EvidenceCommit, "name" | "email" | "subject">[], max: number): number {
  const verdicts = new Set(commits.map(identityOf));
  if (commits.length === 0 || verdicts.has("missing") || verdicts.has("example")) return 0;
  const faults = (verdicts.has("weak") ? 1 : 0) + (commits.every((c) => descriptiveMessage(c.subject)) ? 0 : 1);
  return toHalf(max * [1, 0.5, 0][faults]!);
}

/** An address with its local part masked: `***@heig-vd.ch`; `—` when there is none. */
const maskedEmail = (email: string) => (email.includes("@") ? `***@${email.slice(email.lastIndexOf("@") + 1)}` : email.trim() === "" ? "—" : "***");
/** The distinct identities a rationale names. */
const IDENTITIES_SHOWN = 3;

/**
 * The identity row's rationale: the facts, language-neutral, safe to show
 * to the repository's students after the freeze — the student's commits,
 * their distinct identities (the name, the e-mail's local part masked) and
 * how many messages are descriptive. `3 commits · Ada Lovelace <***@heig-vd.ch> · messages: 2 descriptive, 1 short`.
 */
export function commitIdentityRationale(commits: readonly Pick<EvidenceCommit, "name" | "email" | "subject">[]): string {
  if (commits.length === 0) return "0 commits";
  const identities = [...new Set(commits.map((c) => `${c.name.trim().slice(0, 80) || "—"} <${maskedEmail(c.email)}>`))];
  const shown = identities.slice(0, IDENTITIES_SHOWN).join(", ") + (identities.length > IDENTITIES_SHOWN ? ` (+${identities.length - IDENTITIES_SHOWN})` : "");
  const descriptive = commits.filter((c) => descriptiveMessage(c.subject)).length;
  return `${commits.length} commit${commits.length === 1 ? "" : "s"} · ${shown} · messages: ${descriptive} descriptive, ${commits.length - descriptive} short`;
}
