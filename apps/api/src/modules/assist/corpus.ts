/**
 * The assistant's corpus (ADR-080 §5): the user guide (`docs/guide/*.md`,
 * English) and the per-screen help (`apps/web/src/help/<topic>.md` and its
 * `<topic>.fr.md`), parsed by `buildCorpus` of `@quiz/domain`.
 *
 * Built at BUILD time: `scripts/assist-corpus.ts` writes it to
 * `dist/assist-corpus.json` after `tsc`, from the files of the commit being
 * built, so the documentation the assistant reads is the deployed code's.
 * The image holds no `docs/`: the artifact is all it reads. Outside
 * production (development, the tests) the corpus is built from the
 * repository's files when no artifact exists.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCorpus, type AssistCorpus, type AssistSource } from "@quiz/domain";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/modules/assist` or `dist/modules/assist`: the repository is five levels up either way. */
export const REPO_ROOT = resolve(HERE, "../../../../..");
/** The artifact, beside the compiled server (`dist/assist-corpus.json`). */
export const CORPUS_ARTIFACT = resolve(HERE, "../../assist-corpus.json");

const GUIDE_DIR = "docs/guide";
const HELP_DIR = "apps/web/src/help";
/** `pool.md` is the English topic, `pool.fr.md` its French one. */
const HELP_FILE = /^([a-z0-9-]+)(?:\.(fr))?\.md$/;

const markdownIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();

/**
 * The source files of the corpus, from a checkout of the repository. Throws
 * when the guide is missing: a build that cannot see `docs/guide` must fail,
 * not ship an assistant that knows nothing.
 */
export function readCorpusSources(root: string = REPO_ROOT): AssistSource[] {
  const guide = join(root, GUIDE_DIR);
  const help = join(root, HELP_DIR);
  if (!existsSync(guide) || !existsSync(help)) {
    throw new Error(`assist corpus: ${GUIDE_DIR} or ${HELP_DIR} is missing under ${root}`);
  }
  const sources: AssistSource[] = markdownIn(guide).map((file) => ({
    id: `guide/${file.replace(/\.md$/, "")}`,
    locale: "en",
    text: readFileSync(join(guide, file), "utf8"),
  }));
  for (const file of markdownIn(help)) {
    const m = HELP_FILE.exec(file);
    if (!m) continue;
    sources.push({ id: `help/${m[1]}`, locale: m[2] === "fr" ? "fr" : "en", text: readFileSync(join(help, file), "utf8") });
  }
  return sources;
}

/**
 * The corpus the server answers from: the build's artifact, else (outside
 * production) one built from the repository; null when neither exists, and
 * then the assistant is unavailable.
 */
export function loadCorpus(production: boolean, artifact: string = CORPUS_ARTIFACT): AssistCorpus | null {
  if (existsSync(artifact)) return JSON.parse(readFileSync(artifact, "utf8")) as AssistCorpus;
  if (production) return null;
  try {
    return buildCorpus(readCorpusSources());
  } catch {
    return null;
  }
}
