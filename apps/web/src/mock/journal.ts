/**
 * 9. The classroom's journal (F-JRN-06, F-JRN-07, F-JRN-12; M1-05, for the
 * reader of M4-04): the navigation and the pages, rendered, as the journal's
 * read routes serve them — a student payload with only what a student may
 * read, a staff payload with everything (the drafts, the source, the
 * warnings).
 *
 * Scene flag `?journal=1`: the classroom PRG1-2026 (`r1`) has a journal, in
 * Quiz mode (ADR-057): editable, with revisions and a deleted page.
 * `?journalgithub=1` makes it a GitHub-mode one instead (read-only, Edit on
 * GitHub), and `?journalerror=1` a GitHub-mode one whose last
 * synchronisation failed (the repository is gone). Without `?journal=1` no
 * classroom has one: the staff read "no journal yet" (a mode of `null`, the
 * name "Create a journal" would propose), a student a 404.
 *
 * The staff's writes change the journals for the page's life, as the API
 * would: create in Quiz mode, or in GitHub mode (a name among `ORG_REPOS`
 * is refused `409 name_taken` with a suggestion), use (a repository outside
 * `ORG_REPOS`, a branch other than `main` or `dev`, a folder other than
 * `docs` or `journal` are refused with their codes), remove (a Quiz-mode
 * journal holding pages only with the classroom's name, `?confirm=`), and
 * refresh, which answers at once and "synchronises" 2.5 s later — the
 * reader and the Settings see it on their next read (the mock sends no
 * hint).
 *
 * The pages are HTML fixtures shaped like `packages/docrender`'s output: an
 * `id` on every heading, relative links left as the renderer rewrites them.
 * One page lives in a folder whose name has a space and an accent, so the
 * route's encoded paths are exercised by the mock too.
 */
import type {
  Journal,
  JournalCreate,
  JournalDeletedPage,
  JournalFileWritten,
  JournalMode,
  JournalNavNode,
  JournalPage,
  JournalPageAdd,
  JournalPageSave,
  JournalPageStaff,
  JournalPreview,
  JournalPreviewResult,
  JournalRepository,
  JournalRestore,
  JournalRevision,
  JournalRevisionContent,
  JournalStaff,
  JournalTocEntry,
  JournalUse,
  JournalWarning,
} from "@quiz/contracts";
import { renderPage } from "@quiz/docrender";
import { buildNav, homePage, placePage } from "@quiz/docrender/journalTree";

import { rooms } from "./org";
import { flags, iso, D, MockError, MockPayload, on, role } from "./runtime";

/** The classroom that has a journal under `?journal=1`. */
const JOURNAL_ROOM = "r1";

/** The organization the mock's journals live in (PRG1-2026's, `mock/github.ts`). */
const ORG = "heig-tin-info";

/** The repositories that already exist in it: "Use a repository" takes one, "Create" refuses their names. */
const ORG_REPOS = ["prg1-journal", "prg1-2025-journal", "cours-prg1"];

const repository = (name: string, ref = "main", rootPath = "", syncedAt = iso(0)): JournalRepository => ({
  fullName: `${ORG}/${name}`,
  ref,
  rootPath,
  htmlUrl: `https://github.com/${ORG}/${name}`,
  syncStatus: "ok",
  syncError: null,
  lastSyncedAt: syncedAt,
  lastCommitSha: "3f9c2a1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a",
});

/** A classroom's journal: its mode, and its repository in GitHub mode. */
interface MockJournal {
  mode: JournalMode;
  repo: JournalRepository | null;
}

/** Each classroom's journal, by classroom id. */
const journals = new Map<string, MockJournal>();
if (flags.journal) {
  const repo = repository("prg1-2026-journal", "main", "", iso(-2 * D));
  journals.set(
    JOURNAL_ROOM,
    flags.journalerror
      ? { mode: "github", repo: { ...repo, syncStatus: "error", syncError: "repo_not_found" } }
      : flags.journalgithub
        ? { mode: "github", repo }
        : { mode: "quiz", repo: null },
  );
}

/** When a refresh of a classroom "ends" (ms), until the next read applies it. */
const refreshes = new Map<string, number>();

/** Whether a classroom has a journal: the student classroom page reads it. */
export const hasMockJournal = (classroomId: string) => journals.has(classroomId);

/** Whether its journal lives in a repository: what keeps the GitHub section from disconnecting it (D28). */
export const hasMockGithubJournal = (classroomId: string) => journals.get(classroomId)?.mode === "github";

/**
 * F-JRN-04, F-ORG-09: a Quiz-mode journal holding pages goes only with the
 * classroom's name typed (`?confirm=`); the refusal the API answers, or null.
 */
export function journalRemovalRefusal(classroomId: string, url: URL): MockPayload | null {
  const room = rooms.find((r) => r.id === classroomId);
  if (journals.get(classroomId)?.mode !== "quiz" || PAGES.length === 0 || !room) return null;
  return url.searchParams.get("confirm")?.trim() === room.name.trim() ? null : refusal(409, "confirm_required");
}

/** The repository as the API holds it now: a refresh that has ended moves its last synchronisation. */
function currentRepository(classroomId: string): JournalRepository | null {
  const journal = journals.get(classroomId);
  const repo = journal?.repo ?? null;
  if (!journal || !repo) return null;
  const due = refreshes.get(classroomId);
  if (due !== undefined && Date.now() >= due) {
    refreshes.delete(classroomId);
    const next = { ...repo, lastSyncedAt: new Date(due).toISOString() };
    journals.set(classroomId, { ...journal, repo: next });
    return next;
  }
  return repo;
}

interface Fixture {
  path: string;
  title: string;
  html: string;
  toc: JournalTocEntry[];
  draft: boolean;
  /** Days from now; in the future, the page is hidden from students. */
  visibleInDays: number | null;
  markdown: string;
  warnings?: JournalWarning[];
  /** The save's lock (`baseVersion`); 0 until a save. */
  version?: number;
}

const heading = (depth: number, id: string, text: string) => `<h${depth} id="${id}">${text}</h${depth}>`;

const PAGES: Fixture[] = [
  {
    path: "README.md",
    title: "Programmation 1",
    html: [
      heading(1, "programmation-1", "Programmation 1"),
      "<p>Bienvenue dans le journal du cours. Chaque semaine a sa page : ce qui a été vu, les exercices, les liens.</p>",
      heading(2, "organisation", "Organisation"),
      '<p>Les semaines sont dans la navigation. Commencez par <a href="./10-semaine-1/README.md">la semaine 1</a>, puis lisez <a href="./10-semaine-1/10-pointeurs.md#arithmetique">l\'arithmétique des pointeurs</a>.</p>',
      heading(2, "evaluation", "Évaluation"),
      "<p>Deux tests écrits et un projet en groupe. Les tests se passent sur Quiz, en salle, avec Safe Exam Browser.</p>",
      heading(3, "tests", "Tests"),
      "<ul><li>Test 1 — bases du C</li><li>Test 2 — pointeurs et tableaux</li></ul>",
      heading(2, "ressources", "Ressources"),
      '<p>Le cours suit <a href="https://en.cppreference.com/w/c" target="_blank" rel="noreferrer">cppreference</a> pour la bibliothèque standard.</p>',
    ].join("\n"),
    toc: [
      { id: "programmation-1", depth: 1, text: "Programmation 1" },
      { id: "organisation", depth: 2, text: "Organisation" },
      { id: "evaluation", depth: 2, text: "Évaluation" },
      { id: "tests", depth: 3, text: "Tests" },
      { id: "ressources", depth: 2, text: "Ressources" },
    ],
    draft: false,
    visibleInDays: null,
    markdown: "# Programmation 1\n\nBienvenue dans le journal du cours.\n",
  },
  {
    path: "10-semaine-1/README.md",
    title: "Semaine 1 — Premiers pas",
    html: [
      heading(1, "semaine-1-premiers-pas", "Semaine 1 — Premiers pas"),
      "<p>Compiler un premier programme, lire une erreur du compilateur.</p>",
      '<pre><code class="language-c">int main(void) { return 0; }</code></pre>',
    ].join("\n"),
    toc: [{ id: "semaine-1-premiers-pas", depth: 1, text: "Semaine 1 — Premiers pas" }],
    draft: false,
    visibleInDays: null,
    markdown: "# Semaine 1 — Premiers pas\n\nCompiler un premier programme.\n",
  },
  {
    path: "10-semaine-1/10-pointeurs.md",
    title: "Les pointeurs",
    html: [
      heading(1, "les-pointeurs", "Les pointeurs"),
      "<p>Un pointeur est une variable qui contient une adresse.</p>",
      heading(2, "arithmetique", "Arithmétique"),
      '<p>La taille du pas est celle du type pointé : <span class="katex">p + 1</span>.</p>',
    ].join("\n"),
    toc: [
      { id: "les-pointeurs", depth: 1, text: "Les pointeurs" },
      { id: "arithmetique", depth: 2, text: "Arithmétique" },
    ],
    draft: false,
    visibleInDays: null,
    // The page the editor scenes open (M4-06): front matter, emphasis written
    // with `_`, a fence, KaTeX, a table, a relative link and raw HTML.
    markdown: [
      "---",
      "title: Les pointeurs",
      "date: 2026-09-23",
      "author: Équipe PRG1",
      "---",
      "",
      "# Les pointeurs",
      "",
      "Un pointeur est une variable qui contient une _adresse_. On le déclare avec `*` :",
      "",
      "```c",
      "int x = 42;",
      "int *p = &x;",
      "```",
      "",
      "## Arithmétique",
      "",
      "La taille du pas est celle du type pointé : $p + 1$ avance de $\\text{sizeof}(*p)$ octets.",
      "",
      "| Type | Pas |",
      "| --- | --- |",
      "| `char *` | 1 |",
      "| `int *` | 4 |",
      "",
      "Retour à [la semaine 1](README.md). <kbd>Ctrl</kbd>+<kbd>S</kbd> n'enregistre pas.",
      "",
    ].join("\n"),
  },
  {
    // A folder with a space and an accent: the reader's addresses are encoded.
    path: "20-semaine 2 été/10-tableaux.md",
    title: "Tableaux et chaînes",
    html: [
      heading(1, "tableaux-et-chaines", "Tableaux et chaînes"),
      "<p>Une chaîne est un tableau de caractères terminé par un zéro.</p>",
    ].join("\n"),
    toc: [{ id: "tableaux-et-chaines", depth: 1, text: "Tableaux et chaînes" }],
    draft: false,
    // Visible from next week: the staff see it, badged; a student does not.
    visibleInDays: 7,
    markdown: "---\nvisible_from: next week\n---\n# Tableaux et chaînes\n",
  },
  {
    path: "20-semaine 2 été/20-brouillon.md",
    title: "Brouillon — exercices",
    html: [
      heading(1, "brouillon-exercices", "Brouillon — exercices"),
      "<p>À compléter. &lt;div class=&quot;box&quot;&gt; Voir les exercices de la semaine.</p>",
    ].join("\n"),
    toc: [{ id: "brouillon-exercices", depth: 1, text: "Brouillon — exercices" }],
    draft: true,
    visibleInDays: null,
    markdown: '---\ndraft: true\n---\n# Brouillon — exercices\n\nÀ compléter. <div class="box"> [Voir](../exercices.md) les exercices de la semaine.\n',
    // What the renderer reports for that source (codes, worded by the reader).
    warnings: [
      { code: "raw_html" },
      { code: "target_missing", href: "../exercices.md", path: "exercices.md" },
    ],
  },
];

/** A short page: a title and one paragraph, in the renderer's shape. */
const plainPage = (path: string, title: string, text: string, visibleInDays: number | null = null): Fixture => {
  const id = path.replace(/\W+/g, "-");
  return {
    path,
    title,
    html: [heading(1, id, title), `<p>${text}</p>`].join("\n"),
    toc: [{ id, depth: 1, text: title }],
    draft: false,
    visibleInDays,
    markdown: `# ${title}\n\n${text}\n`,
  };
};

// A semester's worth of weeks, so the reader's strip of pages has to scroll
// (one folder per week, as the course's real journals have): week 1 also
// holds a folder of exercises one level deeper, and the annexes are a folder
// without a landing page (a menu that never navigates, F-JRN-06).
const WEEKS = [
  "Fonctions",
  "Tableaux à deux dimensions et matrices",
  "Structures",
  "Fichiers",
  "Allocation dynamique",
  "Listes chaînées",
  "Récursivité",
  "Tri et recherche",
  "Préprocesseur",
  "Compilation séparée",
  "Révisions",
];
/** Weeks 3 to 6 are out; the later ones open to the students a week apart. */
const future = (i: number) => (i < 4 ? null : (i - 3) * 7);
PAGES.push(
  plainPage("10-semaine-1/90-exercices/10-serie-1.md", "Série 1", "Exercices sur les pointeurs."),
  plainPage("10-semaine-1/90-exercices/20-serie-2.md", "Série 2", "Exercices sur l'arithmétique des pointeurs."),
  ...WEEKS.flatMap((title, i) => {
    const folder = `${21 + i}-semaine-${i + 3}`;
    return [
      plainPage(`${folder}/README.md`, `Semaine ${i + 3} — ${title}`, "Ce qui sera vu cette semaine.", future(i)),
      plainPage(`${folder}/10-exercices.md`, "Exercices", "La série de la semaine.", future(i)),
    ];
  }),
  plainPage("90-annexes/10-outils.md", "Outils", "Le compilateur, l'éditeur, le débogueur."),
  plainPage("90-annexes/20-style.md", "Conventions de style", "Nommer, indenter, commenter."),
);

const hidden = (p: Fixture) => p.draft || (p.visibleInDays !== null && p.visibleInDays > 0);

/**
 * The navigation of the pages `pages` (F-JRN-06), built by the renderer's own
 * rules (`@quiz/docrender/journalTree`), as the API's ingestion builds it.
 */
function navOf(pages: Fixture[]): JournalNavNode[] {
  return buildNav(
    pages.flatMap((page) => {
      const placed = placePage(page.path);
      return placed ? [{ ...placed, title: page.title }] : [];
    }),
  );
}

/** Whether this request is served the student payload: a student, or the staff asking for it. */
const studentPayload = (url: URL) => role === "student" || url.searchParams.get("view") === "student";

/** The classroom's journal, or a 404 for a student when it has none (F-JRN-12). */
function journalOr404(classroomId: string, url: URL): boolean {
  const room = rooms.find((r) => r.id === classroomId);
  if (!room) throw new MockError(404, "Not found");
  const has = journals.has(classroomId);
  if (!has && studentPayload(url)) throw new MockError(404, "Not found");
  return has;
}

/** The staff payload of a classroom's journal. */
function staffJournal(classroomId: string): JournalStaff {
  const journal = journals.get(classroomId);
  if (!journal) {
    const room = rooms.find((r) => r.id === classroomId)!;
    return {
      view: "staff",
      mode: null,
      repository: null,
      nav: [],
      homePath: null,
      hiddenPaths: [],
      warningCount: 0,
      pageCount: 0,
      proposedName: `${room.name.toLowerCase()}-journal`,
    };
  }
  return {
    view: "staff",
    mode: journal.mode,
    repository: currentRepository(classroomId),
    nav: navOf(PAGES),
    homePath: homePage(PAGES)?.path ?? null,
    hiddenPaths: PAGES.filter(hidden).map((p) => p.path),
    warningCount: PAGES.filter((p) => (p.warnings ?? []).length > 0).length,
    pageCount: PAGES.length,
    proposedName: null,
  };
}

/** A classroom of the staff persona, or the 404 the writes answer anyone else. */
function staffRoom(id: string) {
  if (role === "student" || !rooms.some((r) => r.id === id)) throw new MockError(404, "Not found");
}

/** A refused write, as `JournalRefusal` (`message` is the code again). */
const refusal = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  new MockPayload(status, { error, message: error, ...extra });

on("GET", "/app/api/classrooms/:id/journal", (m, _body, url): Journal => {
  const id = m.groups!.id!;
  journalOr404(id, url);
  if (studentPayload(url)) {
    const visible = PAGES.filter((p) => !hidden(p));
    return { view: "student", nav: navOf(visible), homePath: homePage(visible)?.path ?? null };
  }
  return staffJournal(id);
});

on("POST", "/app/api/classrooms/:id/journal", (m, body): JournalStaff => {
  const id = m.groups!.id!;
  staffRoom(id);
  if (journals.has(id)) throw refusal(409, "journal_exists");
  const create = body as JournalCreate;
  if (create.mode === "quiz") {
    journals.set(id, { mode: "quiz", repo: null });
    return staffJournal(id);
  }
  const name = create.name ?? staffJournal(id).proposedName!;
  // Never an adoption (F-JRN-02): a free name instead, as the API words it.
  if (ORG_REPOS.includes(name)) throw refusal(409, "name_taken", { suggestion: `${name}-0190d3c4` });
  ORG_REPOS.push(name);
  journals.set(id, { mode: "github", repo: repository(name) });
  return staffJournal(id);
});

on("POST", "/app/api/classrooms/:id/journal/use", (m, body): JournalStaff => {
  const id = m.groups!.id!;
  staffRoom(id);
  if (journals.has(id)) throw refusal(409, "journal_exists");
  const { name, ref, rootPath } = body as JournalUse;
  if (!ORG_REPOS.includes(name)) throw refusal(409, "repo_not_found");
  if (ref !== undefined && ref !== "main" && ref !== "dev") throw refusal(409, "ref_not_found");
  if (rootPath && rootPath !== "docs" && rootPath !== "journal") throw refusal(409, "root_not_found");
  journals.set(id, { mode: "github", repo: repository(name, ref ?? "main", rootPath ?? "") });
  return staffJournal(id);
});

on("DELETE", "/app/api/classrooms/:id/journal", (m, _body, url) => {
  const id = m.groups!.id!;
  staffRoom(id);
  const refused = journalRemovalRefusal(id, url);
  if (refused) throw refused;
  journals.delete(id);
  refreshes.delete(id);
  return undefined;
});

on("POST", "/app/api/classrooms/:id/journal/refresh", (m) => {
  const id = m.groups!.id!;
  staffRoom(id);
  if (!journals.get(id)?.repo) throw refusal(409, "no_journal");
  refreshes.set(id, Date.now() + 2_500);
  return undefined;
});

on("GET", "/app/api/classrooms/:id/journal/pages/(?<path>.+)", (m, _body, url): JournalPage => {
  if (!journalOr404(m.groups!.id!, url)) throw new MockError(404, "Not found");
  const path = decodeURIComponent(m.groups!.path!);
  const page = PAGES.find((p) => p.path === path);
  // A page a student may not read is a page that does not exist (F-JRN-07).
  if (!page || (studentPayload(url) && hidden(page))) throw new MockError(404, "Not found");
  if (studentPayload(url)) return { view: "student", ...commonOf(page) };
  return staffPageOf(page, journals.get(m.groups!.id!)?.repo ?? null);
});

const commonOf = (page: Fixture) => ({
  path: page.path,
  title: page.title,
  html: page.html,
  toc: page.toc,
  updatedAt: iso(-3 * D),
});

/** github.com's editor of a page's file, as the API builds it (GitHub mode only). */
const editUrlOf = (repo: JournalRepository, path: string) =>
  `https://github.com/${repo.fullName}/edit/${repo.ref}/${[repo.rootPath, path]
    .filter(Boolean)
    .join("/")
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

const staffPageOf = (page: Fixture, repo: JournalRepository | null = null): JournalPageStaff => ({
  view: "staff",
  ...commonOf(page),
  draft: page.draft,
  visibleFrom: page.visibleInDays === null ? null : iso(page.visibleInDays * D),
  hidden: hidden(page),
  markdown: page.markdown,
  version: page.version ?? 0,
  warnings: page.warnings ?? [],
  editUrl: repo ? editUrlOf(repo, page.path) : null,
});

// --------------------------------------------------------------- writes
// The editor's routes, Quiz mode only (ADR-057; a GitHub-mode journal is
// `409 read_only`): save against the version (`?journalconflict=1`: every
// save meets a page saved meanwhile), add, delete, upload, preview, and the
// revisions (list, read, deleted pages, restore). A written page is rendered
// by the journal's own renderer (`@quiz/docrender`), as the API would; an
// upload is accepted and not kept (the editor draws a picture it uploaded
// from the browser's copy).

/** One saved state of a page: every save, add and restore writes one. */
type Revision = JournalRevisionContent;
const revisions: Revision[] = [];
let revisionSeq = 0;
/** A revision of `path`, `hoursAgo` hours old. */
function addRevision(path: string, markdown: string, author: string | null, hoursAgo = 0): Revision {
  revisionSeq += 1;
  const revision: Revision = {
    id: `0190d3c4-0000-7000-8000-${String(revisionSeq).padStart(12, "0")}`,
    path,
    author,
    createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    markdown,
  };
  revisions.push(revision);
  return revision;
}
/** A page's revisions, newest first, metadata only. */
const revisionsOf = (path: string): JournalRevision[] =>
  revisions
    .filter((r) => r.path === path)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ markdown: _markdown, ...meta }) => meta);

// The history the scenes show: the page the editor opens has three saves,
// every other page the one that created it, and one page was deleted.
for (const page of PAGES) addRevision(page.path, page.markdown, "Yves Chevallier", 24 * 9);
{
  const pointers = PAGES.find((p) => p.path === "10-semaine-1/10-pointeurs.md")!;
  const first = pointers.markdown.replace(/\n\| Type[\s\S]*?\n\n/, "\n");
  revisions.find((r) => r.path === pointers.path)!.markdown = first.replace("_adresse_", "adresse");
  addRevision(pointers.path, first, "Anne Dupuis", 24 * 4);
  addRevision(pointers.path, pointers.markdown, "Yves Chevallier", 3);
  addRevision(
    "20-semaine 2 été/30-ancien-td.md",
    "# Ancien TD — chaînes\n\nLa série de l'an passé, remplacée par les exercices de la semaine.\n",
    "Anne Dupuis",
    24 * 2,
  );
}

/** The title a revision's markdown gives the page: its front matter's, else its first heading. */
const titleOf = (markdown: string): string | null =>
  /^title:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? null;

/** A Quiz-mode journal to write to: no journal, or a GitHub-mode one, is refused as the API does. */
function writableJournal(id: string): void {
  staffRoom(id);
  const journal = journals.get(id);
  if (!journal) throw refusal(409, "no_journal");
  if (journal.mode === "github") throw refusal(409, "read_only");
}

/** The page rendered again from its markdown, as an ingestion would. */
function rerender(page: Fixture): void {
  const rendered = renderPage(page.markdown, {
    classroomId: JOURNAL_ROOM,
    pagePath: page.path,
    fallbackTitle: null,
    pages: new Set(PAGES.map((p) => p.path)),
    assets: new Set(),
  });
  page.html = rendered.html;
  page.title = rendered.title ?? page.path;
  page.toc = rendered.toc;
  page.draft = rendered.draft;
  page.visibleInDays = rendered.visibleFrom ? (rendered.visibleFrom.getTime() - Date.now()) / D : null;
  page.warnings = rendered.warnings;
}

/** A write's answer: the file, and the page as it now reads. */
const written = (path: string, page: Fixture | null): JournalFileWritten => ({
  path,
  page: page ? staffPageOf(page) : null,
});

/** The page of a write, or the 404 a missing one is. */
function writablePage(m: RegExpMatchArray): Fixture {
  const id = m.groups!.id!;
  writableJournal(id);
  const page = PAGES.find((p) => p.path === decodeURIComponent(m.groups!.path!));
  if (!page) throw new MockError(404, "Not found");
  return page;
}

on("PUT", "/app/api/classrooms/:id/journal/pages/(?<path>.+)", (m, body): JournalFileWritten => {
  const page = writablePage(m);
  const { markdown, baseVersion } = body as JournalPageSave;
  if (flags.journalconflict || baseVersion !== (page.version ?? 0)) throw refusal(409, "conflict");
  page.markdown = markdown;
  page.version = (page.version ?? 0) + 1;
  rerender(page);
  addRevision(page.path, markdown, "Yves Chevallier");
  return written(page.path, page);
});

on("POST", "/app/api/classrooms/:id/journal/pages", (m, body): JournalFileWritten => {
  const id = m.groups!.id!;
  writableJournal(id);
  const { path, title } = body as JournalPageAdd;
  if (PAGES.some((p) => p.path === path)) throw refusal(409, "page_exists");
  const page: Fixture = { path, title: title ?? path, html: "", toc: [], draft: false, visibleInDays: null, markdown: title ? `# ${title}\n` : "" };
  PAGES.push(page);
  rerender(page);
  addRevision(path, page.markdown, "Yves Chevallier");
  return written(path, page);
});

on("DELETE", "/app/api/classrooms/:id/journal/pages/(?<path>.+)", (m) => {
  const page = writablePage(m);
  PAGES.splice(PAGES.indexOf(page), 1);
  return undefined;
});

on("POST", "/app/api/classrooms/:id/journal/assets/(?<path>.+)", (m): JournalFileWritten => {
  writableJournal(m.groups!.id!);
  return written(decodeURIComponent(m.groups!.path!), null);
});

on("POST", "/app/api/classrooms/:id/journal/preview", (m, body): JournalPreviewResult => {
  staffRoom(m.groups!.id!);
  const { path, markdown } = body as JournalPreview;
  const rendered = renderPage(markdown, {
    classroomId: m.groups!.id!,
    pagePath: path,
    fallbackTitle: null,
    pages: new Set(PAGES.map((p) => p.path)),
    assets: new Set(),
  });
  return {
    title: rendered.title,
    html: rendered.html,
    toc: rendered.toc,
    draft: rendered.draft,
    visibleFrom: rendered.visibleFrom?.toISOString() ?? null,
    warnings: rendered.warnings,
  };
});

on("GET", "/app/api/classrooms/:id/journal/revisions/(?<path>.+)", (m): JournalRevision[] => {
  staffRoom(m.groups!.id!);
  return revisionsOf(decodeURIComponent(m.groups!.path!));
});

on("GET", "/app/api/classrooms/:id/journal/revision/:rev", (m): JournalRevisionContent => {
  staffRoom(m.groups!.id!);
  const revision = revisions.find((r) => r.id === m.groups!.rev);
  if (!revision) throw new MockError(404, "Not found");
  return revision;
});

on("GET", "/app/api/classrooms/:id/journal/deleted", (m): JournalDeletedPage[] => {
  staffRoom(m.groups!.id!);
  const gone = [...new Set(revisions.map((r) => r.path))].filter((path) => !PAGES.some((p) => p.path === path));
  return gone
    .map((path) => {
      const latest = revisions.filter((r) => r.path === path).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
      return { path, title: titleOf(latest.markdown), savedAt: latest.createdAt };
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
});

on("POST", "/app/api/classrooms/:id/journal/restore", (m, body): JournalFileWritten => {
  writableJournal(m.groups!.id!);
  const revision = revisions.find((r) => r.id === (body as JournalRestore).revisionId);
  if (!revision) throw new MockError(404, "Not found");
  let page = PAGES.find((p) => p.path === revision.path);
  if (!page) {
    page = { path: revision.path, title: revision.path, html: "", toc: [], draft: false, visibleInDays: null, markdown: "" };
    PAGES.push(page);
  }
  page.markdown = revision.markdown;
  page.version = (page.version ?? 0) + 1;
  rerender(page);
  addRevision(page.path, page.markdown, "Yves Chevallier");
  return written(page.path, page);
});
