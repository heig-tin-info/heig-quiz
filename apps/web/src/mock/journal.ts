/**
 * 9. The classroom's journal (F-JRN-06, F-JRN-07, F-JRN-12; M1-05, for the
 * reader of M4-04): the navigation and the pages, rendered, as the journal's
 * read routes serve them — a student payload with only what a student may
 * read, a staff payload with everything (the drafts, the source, the
 * warnings).
 *
 * Scene flag `?journal=1`: the classroom PRG1-2026 (`r1`) has a journal.
 * Without it no classroom has one: the staff read "no journal yet" (a
 * repository of `null`, the name "Create a journal" would propose), a student
 * a 404. `?journalerror=1`: that journal's last synchronisation failed (the
 * repository is gone).
 *
 * The staff's writes (M4-03, for the Settings of M4-05) change the journals
 * for the page's life, as the API would: create (a name among `ORG_REPOS` is
 * refused `409 name_taken` with a suggestion), use (a repository outside
 * `ORG_REPOS`, a branch other than `main` or `dev`, a folder other than
 * `docs` or `journal` are refused with their codes), remove, and refresh,
 * which answers at once and "synchronises" 2.5 s later — the reader and the
 * Settings see it on their next read (the mock sends no hint).
 *
 * The pages are HTML fixtures shaped like `packages/docrender`'s output: an
 * `id` on every heading, relative links left as the renderer rewrites them.
 * One page lives in a folder whose name has a space and an accent, so the
 * route's encoded paths are exercised by the mock too.
 */
import type {
  Journal,
  JournalCreate,
  JournalFileWritten,
  JournalNavNode,
  JournalPage,
  JournalPageAdd,
  JournalPageSave,
  JournalPageStaff,
  JournalPreview,
  JournalPreviewResult,
  JournalRepository,
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
  editable: true,
});

/** Each classroom's journal, by classroom id. */
const journals = new Map<string, JournalRepository>();
if (flags.journal) {
  journals.set(
    JOURNAL_ROOM,
    flags.journalerror
      ? { ...repository("prg1-2026-journal", "main", "", iso(-2 * D)), syncStatus: "error", syncError: "repo_not_found", editable: false }
      : repository("prg1-2026-journal", "main", "", iso(-2 * D)),
  );
}

/** When a refresh of a classroom "ends" (ms), until the next read applies it. */
const refreshes = new Map<string, number>();

/** Whether a classroom has a journal: the student classroom page and the GitHub disconnect read it. */
export const hasMockJournal = (classroomId: string) => journals.has(classroomId);

/** The repository as the API holds it now: a refresh that has ended moves its last synchronisation. */
function currentRepository(classroomId: string): JournalRepository | null {
  const repo = journals.get(classroomId);
  if (!repo) return null;
  const due = refreshes.get(classroomId);
  if (due !== undefined && Date.now() >= due) {
    refreshes.delete(classroomId);
    const next = { ...repo, lastSyncedAt: new Date(due).toISOString() };
    journals.set(classroomId, next);
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
  const repo = currentRepository(classroomId);
  if (!repo) {
    const room = rooms.find((r) => r.id === classroomId)!;
    return {
      view: "staff",
      repository: null,
      nav: [],
      homePath: null,
      hiddenPaths: [],
      warningCount: 0,
      proposedName: `${room.name.toLowerCase()}-journal`,
    };
  }
  return {
    view: "staff",
    repository: repo,
    nav: navOf(PAGES),
    homePath: homePage(PAGES)?.path ?? null,
    hiddenPaths: PAGES.filter(hidden).map((p) => p.path),
    warningCount: PAGES.filter((p) => (p.warnings ?? []).length > 0).length,
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
  const name = (body as JournalCreate).name ?? staffJournal(id).proposedName!;
  // Never an adoption (F-JRN-02): a free name instead, as the API words it.
  if (ORG_REPOS.includes(name)) throw refusal(409, "name_taken", { suggestion: `${name}-0190d3c4` });
  ORG_REPOS.push(name);
  journals.set(id, repository(name));
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
  journals.set(id, repository(name, ref ?? "main", rootPath ?? ""));
  return staffJournal(id);
});

on("DELETE", "/app/api/classrooms/:id/journal", (m) => {
  const id = m.groups!.id!;
  staffRoom(id);
  journals.delete(id);
  refreshes.delete(id);
  return undefined;
});

on("POST", "/app/api/classrooms/:id/journal/refresh", (m) => {
  const id = m.groups!.id!;
  staffRoom(id);
  if (!journals.has(id)) throw refusal(409, "no_journal");
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
  return staffPageOf(page);
});

const commonOf = (page: Fixture) => ({
  path: page.path,
  title: page.title,
  html: page.html,
  toc: page.toc,
  updatedAt: iso(-3 * D),
});

const staffPageOf = (page: Fixture): JournalPageStaff => ({
  view: "staff",
  ...commonOf(page),
  draft: page.draft,
  visibleFrom: page.visibleInDays === null ? null : iso(page.visibleInDays * D),
  hidden: hidden(page),
  markdown: page.markdown,
  blobSha: blobOf(page.markdown),
  warnings: page.warnings ?? [],
});

// --------------------------------------------------------------- writes
// The editor's routes (M4-06): save against the blob (`?journalconflict=1`:
// every save meets a moved file), add, delete, upload, preview. A written
// page is rendered by the journal's own renderer (`@quiz/docrender`), as
// the API's ingestion would; an upload is accepted and not kept (the
// editor draws a picture it uploaded from the browser's copy).

/** A 40-hex "blob sha" of a text, stable for the same text (FNV-1a, five times salted). */
function blobOf(text: string): string {
  let out = "";
  for (let salt = 0; salt < 5; salt += 1) {
    let h = 0x811c9dc5 ^ salt;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
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

/** A write's answer: the file, its new blob, a commit, and the page as the copy now holds it. */
const written = (path: string, page: Fixture | null): JournalFileWritten => ({
  path,
  blobSha: blobOf(page?.markdown ?? path),
  commitSha: blobOf(`commit ${path} ${Date.now()}`),
  page: page ? staffPageOf(page) : null,
});

/** The page of a write, or the 404 a missing one is. */
function writablePage(m: RegExpMatchArray): Fixture {
  const id = m.groups!.id!;
  staffRoom(id);
  if (!journals.has(id)) throw refusal(409, "no_journal");
  const page = PAGES.find((p) => p.path === decodeURIComponent(m.groups!.path!));
  if (!page) throw new MockError(404, "Not found");
  return page;
}

on("PUT", "/app/api/classrooms/:id/journal/pages/(?<path>.+)", (m, body): JournalFileWritten => {
  const page = writablePage(m);
  const { markdown, baseSha } = body as JournalPageSave;
  if (flags.journalconflict || baseSha !== blobOf(page.markdown)) throw refusal(409, "conflict");
  page.markdown = markdown;
  rerender(page);
  return written(page.path, page);
});

on("POST", "/app/api/classrooms/:id/journal/pages", (m, body): JournalFileWritten => {
  const id = m.groups!.id!;
  staffRoom(id);
  if (!journals.has(id)) throw refusal(409, "no_journal");
  const { path, title } = body as JournalPageAdd;
  if (PAGES.some((p) => p.path === path)) throw refusal(409, "page_exists");
  const page: Fixture = { path, title: title ?? path, html: "", toc: [], draft: false, visibleInDays: null, markdown: title ? `# ${title}\n` : "" };
  PAGES.push(page);
  rerender(page);
  return written(path, page);
});

on("DELETE", "/app/api/classrooms/:id/journal/pages/(?<path>.+)", (m) => {
  const page = writablePage(m);
  PAGES.splice(PAGES.indexOf(page), 1);
  return undefined;
});

on("POST", "/app/api/classrooms/:id/journal/assets/(?<path>.+)", (m): JournalFileWritten => {
  const id = m.groups!.id!;
  staffRoom(id);
  if (!journals.has(id)) throw refusal(409, "no_journal");
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
