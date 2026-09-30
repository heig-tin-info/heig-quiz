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
 * a 404 — which is what every default scene sees, since no screen asks yet.
 *
 * The pages are HTML fixtures shaped like `packages/docrender`'s output: an
 * `id` on every heading, relative links left as the renderer rewrites them.
 * One page lives in a folder whose name has a space and an accent, so the
 * route's encoded paths are exercised by the mock too.
 */
import { rooms } from "./org";
import { flags, iso, D, MockError, on, role } from "./runtime";

/*
 * TODO(M4-01, #371): replace these local shapes with the journal contracts of
 * `packages/contracts/src/journal.ts` (`Journal`, `JournalPage`,
 * `JournalNavNode`) once #371 is merged, and move the two routes below from
 * `UNCHECKED` to `CHECKED` in `contract.test.ts`. They mirror the field names
 * of #371 and nothing more: they are NOT a second contract, and nothing
 * outside this file may import them.
 */
interface NavNode {
  path: string;
  title: string;
  pagePath: string | null;
  children: NavNode[];
}
interface TocEntry {
  id: string;
  depth: number;
  text: string;
}

/** The classroom that has a journal under `?journal=1`. */
const JOURNAL_ROOM = "r1";

interface Fixture {
  path: string;
  title: string;
  html: string;
  toc: TocEntry[];
  draft: boolean;
  /** Days from now; in the future, the page is hidden from students. */
  visibleInDays: number | null;
  markdown: string;
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
      '<p>Les semaines sont dans la navigation. Commencez par <a href="10-semaine-1/README.md">la semaine 1</a>.</p>',
    ].join("\n"),
    toc: [
      { id: "programmation-1", depth: 1, text: "Programmation 1" },
      { id: "organisation", depth: 2, text: "Organisation" },
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
    markdown: "# Les pointeurs\n\nUn pointeur est une variable qui contient une adresse.\n",
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
    html: [heading(1, "brouillon-exercices", "Brouillon — exercices"), "<p>À compléter.</p>"].join("\n"),
    toc: [{ id: "brouillon-exercices", depth: 1, text: "Brouillon — exercices" }],
    draft: true,
    visibleInDays: null,
    markdown: "---\ndraft: true\n---\n# Brouillon — exercices\n",
  },
];

const hidden = (p: Fixture) => p.draft || (p.visibleInDays !== null && p.visibleInDays > 0);

/** The navigation of the pages `pages` (F-JRN-06): folders as sections, their README as landing page. */
function navOf(pages: Fixture[]): NavNode[] {
  const root: NavNode[] = [];
  for (const page of pages) {
    const parts = page.path.split("/");
    if (parts.length === 1) {
      if (page.path !== "README.md") root.push({ path: page.path, title: page.title, pagePath: page.path, children: [] });
      continue;
    }
    const folder = parts[0]!;
    let section = root.find((n) => n.path === folder);
    if (!section) {
      section = { path: folder, title: folder.replace(/^\d+-/, ""), pagePath: null, children: [] };
      root.push(section);
    }
    if (parts[1] === "README.md") {
      section.pagePath = page.path;
      section.title = page.title;
    } else section.children.push({ path: page.path, title: page.title, pagePath: page.path, children: [] });
  }
  return root;
}

/** Whether this request is served the student payload: a student, or the staff asking for it. */
const studentPayload = (url: URL) => role === "student" || url.searchParams.get("view") === "student";

/** The classroom's journal, or a 404 for a student when it has none (F-JRN-12). */
function journalOr404(classroomId: string, url: URL): boolean {
  const room = rooms.find((r) => r.id === classroomId);
  if (!room) throw new MockError(404, "Not found");
  const has = flags.journal && classroomId === JOURNAL_ROOM;
  if (!has && studentPayload(url)) throw new MockError(404, "Not found");
  return has;
}

on("GET", "/app/api/classrooms/:id/journal", (m, _body, url) => {
  const id = m.groups!.id!;
  const has = journalOr404(id, url);
  if (studentPayload(url)) {
    const visible = PAGES.filter((p) => !hidden(p));
    return { view: "student", nav: navOf(visible), homePath: "README.md" };
  }
  if (!has) {
    const room = rooms.find((r) => r.id === id)!;
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
    repository: {
      fullName: "heig-tin-info/prg1-2026-journal",
      ref: "main",
      rootPath: "",
      htmlUrl: "https://github.com/heig-tin-info/prg1-2026-journal",
      syncStatus: "ok",
      syncError: null,
      lastSyncedAt: iso(-2 * D),
      lastCommitSha: "3f9c2a1d8e7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a",
      editable: true,
    },
    nav: navOf(PAGES),
    homePath: "README.md",
    hiddenPaths: PAGES.filter(hidden).map((p) => p.path),
    warningCount: 0,
    proposedName: null,
  };
});

on("GET", "/app/api/classrooms/:id/journal/pages/(?<path>.+)", (m, _body, url) => {
  if (!journalOr404(m.groups!.id!, url)) throw new MockError(404, "Not found");
  const path = decodeURIComponent(m.groups!.path!);
  const page = PAGES.find((p) => p.path === path);
  // A page a student may not read is a page that does not exist (F-JRN-07).
  if (!page || (studentPayload(url) && hidden(page))) throw new MockError(404, "Not found");
  const common = {
    path: page.path,
    title: page.title,
    html: page.html,
    toc: page.toc,
    updatedAt: iso(-3 * D),
  };
  if (studentPayload(url)) return { view: "student", ...common };
  return {
    view: "staff",
    ...common,
    draft: page.draft,
    visibleFrom: page.visibleInDays === null ? null : iso(page.visibleInDays * D),
    hidden: hidden(page),
    markdown: page.markdown,
    blobSha: `blob-${page.path.length}`,
    warnings: [],
  };
});
