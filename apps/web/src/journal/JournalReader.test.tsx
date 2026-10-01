import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Journal, JournalPage, JournalPageStaff, JournalStaff } from "@quiz/contracts";

import type { Route } from "../router";
import { fail, mockFetch, ok, renderWithProviders, type RouteHandler } from "../test/render";
// The journal's route parses in every build since M4-05: no flag to stub.
import { journalLinkTarget } from "./JournalArticle";
import { JournalReader } from "./JournalReader";

/*
 * The journal reader (F-JRN-07): the strip of pages and its current entry, the
 * article's internal links routed in the app, the staff's badges, warnings
 * and sync state worded from their codes, and a student view that shows none
 * of them — it is given the student payload, which has none of them.
 */

const BASE = "/app/api/classrooms/r1/journal";
const HOME = "README.md";
const POINTERS = "10-semaine-1/10-pointeurs.md";
const DRAFT = "20-semaine 2 été/20-brouillon.md";
const DRAFT_URL = `${BASE}/pages/20-semaine%202%20%C3%A9t%C3%A9/20-brouillon.md`;

const nav = [
  {
    path: "10-semaine-1",
    title: "Semaine 1",
    pagePath: "10-semaine-1/README.md",
    children: [{ path: POINTERS, title: "Les pointeurs", pagePath: POINTERS, children: [] }],
  },
  {
    path: "20-semaine 2 été",
    title: "Semaine 2 été",
    pagePath: null,
    children: [{ path: DRAFT, title: "Brouillon", pagePath: DRAFT, children: [] }],
  },
];

const staffJournal = (over: Partial<JournalStaff> = {}): JournalStaff => ({
  view: "staff",
  mode: "github",
  repository: {
    fullName: "heig-tin-info/prg1-journal",
    ref: "main",
    rootPath: "",
    htmlUrl: "https://github.com/heig-tin-info/prg1-journal",
    syncStatus: "ok",
    syncError: null,
    lastSyncedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastCommitSha: "abc",
    editable: true,
  },
  nav,
  homePath: HOME,
  hiddenPaths: [DRAFT],
  warningCount: 1,
  proposedName: null,
  ...over,
});

const studentJournal: Journal = { view: "student", nav: [nav[0]!], homePath: HOME };

const HOME_HTML =
  '<h1 id="prg1">Programmation 1</h1>' +
  '<p>Lisez <a href="./10-semaine-1/10-pointeurs.md#arith">les pointeurs</a>, ' +
  '<a href="https://example.org/doc" target="_blank" rel="noreferrer">la doc</a>, ' +
  '<a href="/app/api/classrooms/r1/journal/assets/cours.pdf">le PDF</a>.</p>' +
  '<h2 id="organisation">Organisation</h2><h2 id="evaluation">Évaluation</h2>';

const common = (path: string, title: string, html: string) => ({
  path,
  title,
  html,
  toc: [
    { id: "prg1", depth: 1, text: title },
    { id: "organisation", depth: 2, text: "Organisation" },
    { id: "evaluation", depth: 2, text: "Évaluation" },
  ],
  updatedAt: new Date(0).toISOString(),
});

const staffPage = (path: string, over: Partial<JournalPageStaff> = {}): JournalPageStaff => ({
  view: "staff",
  ...common(path, "Programmation 1", HOME_HTML),
  draft: false,
  visibleFrom: null,
  hidden: false,
  markdown: "# Programmation 1",
  blobSha: "sha",
  warnings: [],
  editUrl: null,
  ...over,
});

const studentPage = (path: string, title = "Programmation 1", html = HOME_HTML): JournalPage => ({
  view: "student",
  ...common(path, title, html),
});

/** jsdom has no layout: the reader asks `matchMedia` which layout to draw. */
function setWidth(px: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const min = /min-width: (\d+)px/.exec(query);
    return {
      matches: min ? px >= Number(min[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

const navigateSpy = vi.fn();

/** The reader under a route held in state, as `App` holds it. */
function Reader({ path, studentView = false }: { path?: string; studentView?: boolean }) {
  const [route, setRoute] = useState<Route>({ view: "classroomJournal", id: "r1", path });
  if (route.view !== "classroomJournal") return <p>left the journal</p>;
  return (
    <JournalReader
      classroomId={route.id}
      path={route.path}
      studentView={studentView}
      navigate={(r, options) => {
        navigateSpy(r, options);
        setRoute(r);
      }}
    />
  );
}

beforeEach(() => {
  navigateSpy.mockReset();
  setWidth(1440);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
});

describe("JournalReader — the strip of pages", () => {
  it("draws the home, a page, and splits a folder with a landing page into its link and its menu", async () => {
    const { calls } = mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
      [`GET ${BASE}/pages/${POINTERS}`]: ok(staffPage(POINTERS, { title: "Les pointeurs", html: "<h1 id=\"p\">Les pointeurs</h1>" })),
    });
    renderWithProviders(<Reader path={HOME} />);

    const pages = await screen.findByRole("navigation", { name: "Pages of the journal" });
    // Links, not tabs: the strip is no tablist.
    expect(within(pages).queryByRole("tab")).toBeNull();
    const home = within(pages).getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("aria-current", "page");
    // The folder's label opens its landing page; its chevron, its menu.
    const landing = within(pages).getByRole("link", { name: "Semaine 1" });
    expect(landing).toHaveAttribute("href", "/classrooms/r1/journal/10-semaine-1/README.md");
    expect(landing).not.toHaveAttribute("aria-current");
    const chevron = within(pages).getByRole("button", { name: "Pages in Semaine 1" });
    await userEvent.click(chevron);
    const menu = screen.getByRole("menu", { name: "Pages in Semaine 1" });
    // The landing page first, then the pages under it.
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Semaine 1", "Les pointeurs"]);
    const pointers = within(menu).getByRole("menuitem", { name: "Les pointeurs" });
    expect(pointers).toHaveAttribute("href", "/classrooms/r1/journal/10-semaine-1/10-pointeurs.md");
    await userEvent.click(pointers);

    expect(navigateSpy).toHaveBeenLastCalledWith({ view: "classroomJournal", id: "r1", path: POINTERS }, undefined);
    expect(await screen.findByRole("heading", { level: 1, name: "Les pointeurs" })).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toContain(`${BASE}/pages/${POINTERS}`);
    // The folder holding the page is the current entry; the page, in its menu.
    expect(within(pages).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    expect(within(pages).getByRole("button", { name: "Pages in Semaine 1" })).toHaveAttribute("aria-current", "true");
    await userEvent.click(within(pages).getByRole("button", { name: "Pages in Semaine 1" }));
    expect(screen.getByRole("menuitem", { name: "Les pointeurs" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("menuitem", { name: "Semaine 1" })).not.toHaveAttribute("aria-current");
  });

  it("routes a plain click on the landing link and leaves a modified one to the browser", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
      [`GET ${BASE}/pages/10-semaine-1/README.md`]: ok(staffPage("10-semaine-1/README.md")),
    });
    renderWithProviders(<Reader path={HOME} />);
    const landing = await screen.findByRole("link", { name: "Semaine 1" });
    const taken: boolean[] = [];
    const record = (e: Event) => {
      taken.push(e.defaultPrevented);
      e.preventDefault();
    };
    window.addEventListener("click", record);
    fireEvent.click(landing, { ctrlKey: true });
    fireEvent.click(landing);
    window.removeEventListener("click", record);
    expect(taken).toEqual([false, true]);
    expect(navigateSpy).toHaveBeenLastCalledWith(
      { view: "classroomJournal", id: "r1", path: "10-semaine-1/README.md" },
      undefined,
    );
  });

  it("opens the menu of a folder without a landing page, never a page, with the eye on its hidden page only", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
    });
    renderWithProviders(<Reader path={HOME} />);
    const pages = await screen.findByRole("navigation", { name: "Pages of the journal" });
    expect(within(pages).queryByRole("link", { name: /Semaine 2 été/ })).toBeNull();
    // The eye is on the page, never summed up on its folder's entry.
    expect(within(pages).queryByRole("img", { name: "Hidden from students" })).toBeNull();
    navigateSpy.mockClear();
    await userEvent.click(within(pages).getByRole("button", { name: "Semaine 2 été" }));
    expect(navigateSpy).not.toHaveBeenCalled();
    const draft = within(screen.getByRole("menu")).getByRole("menuitem", { name: /Brouillon/ });
    expect(draft).toContainElement(within(draft).getByRole("img", { name: "Hidden from students" }));
  });

  it("has no home entry when the journal has no home page", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal({ homePath: null })),
      [`GET ${BASE}/pages/${POINTERS}`]: ok(staffPage(POINTERS)),
    });
    renderWithProviders(<Reader path={POINTERS} />);
    const pages = await screen.findByRole("navigation", { name: "Pages of the journal" });
    expect(within(pages).getByRole("link", { name: "Semaine 1" })).toBeInTheDocument();
    expect(within(pages).queryByRole("link", { name: "Home" })).toBeNull();
  });

  it("opens the home page at its own address when none is named", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
    });
    renderWithProviders(<Reader />);
    expect(await screen.findByRole("heading", { level: 1, name: "Programmation 1" })).toBeInTheDocument();
    expect(navigateSpy).toHaveBeenCalledWith({ view: "classroomJournal", id: "r1", path: HOME }, { replace: true });
  });

  it("shows the table of contents of the page beside it, as text, from 1280 px", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
    });
    renderWithProviders(<Reader path={HOME} />);
    const toc = await screen.findByRole("navigation", { name: "On this page" });
    expect(within(toc).getByRole("link", { name: "Organisation" })).toHaveAttribute("href", "#organisation");
    expect(within(toc).getByRole("link", { name: "Évaluation" })).toHaveAttribute("href", "#evaluation");
    // The page's own title is not an entry of its table of contents.
    expect(within(toc).queryByText("Programmation 1")).toBeNull();
    expect(screen.queryByRole("button", { name: "On this page" })).toBeNull();
  });

  it("folds the table of contents above the page below 1280 px, the strip still there", async () => {
    setWidth(390);
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
    });
    renderWithProviders(<Reader path={HOME} />);
    const toggle = await screen.findByRole("button", { name: "On this page" });
    expect(screen.getByRole("navigation", { name: "Pages of the journal" })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
    await userEvent.click(toggle);
    const toc = screen.getByRole("navigation", { name: "On this page" });
    // Following a link from the panel folds it again.
    await userEvent.click(within(toc).getByRole("link", { name: "Organisation" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});

describe("JournalReader — links inside the article", () => {
  it("routes a link to another page in the app, anchor kept, and leaves the others to the browser", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
      [`GET ${BASE}/pages/${POINTERS}`]: ok(staffPage(POINTERS, { html: '<h2 id="arith">Arithmétique</h2>' })),
    });
    renderWithProviders(<Reader path={HOME} />);
    const article = await screen.findByRole("article");

    // Whether the reader took each click, read after React's handler, which
    // then cancels it so that jsdom does not try to follow the link.
    const taken: boolean[] = [];
    const record = (e: Event) => {
      taken.push(e.defaultPrevented);
      e.preventDefault();
    };
    window.addEventListener("click", record);
    const click = (name: string, init?: MouseEventInit) => {
      fireEvent.click(within(article).getByRole("link", { name }), init);
      return taken.at(-1);
    };
    // External and asset links: not routed, the browser follows them; and a
    // modified click (a new tab) stays the browser's too.
    expect(click("la doc")).toBe(false);
    expect(click("le PDF")).toBe(false);
    expect(click("les pointeurs", { ctrlKey: true })).toBe(false);
    expect(navigateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ path: POINTERS }), undefined);

    expect(click("les pointeurs")).toBe(true); // the app routes it
    window.removeEventListener("click", record);
    expect(navigateSpy).toHaveBeenLastCalledWith({ view: "classroomJournal", id: "r1", path: POINTERS }, undefined);
    expect(window.location.hash).toBe("#arith");
    expect(await screen.findByRole("heading", { name: "Arithmétique" })).toBeInTheDocument();
  });

  it("resolves a relative href against the page, whatever the address", () => {
    // From a page in a folder, `../` climbs to the root; encoded paths decode.
    expect(journalLinkTarget("../README.md", "r1", POINTERS)).toEqual({ path: HOME, hash: "" });
    expect(journalLinkTarget("../20-semaine%202%20%C3%A9t%C3%A9/20-brouillon.md#x", "r1", POINTERS)).toEqual({
      path: DRAFT,
      hash: "#x",
    });
    expect(journalLinkTarget("./20-brouillon.md", "r1", DRAFT)).toEqual({ path: DRAFT, hash: "" });
    // Not a page of this journal: an anchor, an asset, another site, a climb out.
    expect(journalLinkTarget("#organisation", "r1", HOME)).toBeNull();
    expect(journalLinkTarget("./images/plan.png", "r1", HOME)).toBeNull();
    expect(journalLinkTarget("https://example.org/x.md", "r1", HOME)).toBeNull();
    expect(journalLinkTarget("../../../x.md", "r1", HOME)).toBeNull();
    expect(journalLinkTarget("/classrooms/r2/journal/README.md", "r1", HOME)).toBeNull();
  });
});

describe("JournalReader — the staff", () => {
  const draftPage = staffPage(DRAFT, {
    title: "Brouillon",
    html: '<h1 id="b">Brouillon</h1>',
    draft: true,
    hidden: true,
    warnings: [
      { code: "raw_html" },
      { code: "target_missing", href: "../x.md", path: "x.md" },
      { code: "front_matter_yaml", line: 3 },
    ],
  });

  it("badges a draft and words its warnings", async () => {
    mockFetch({ [`GET ${BASE}`]: ok(staffJournal()), [`GET ${DRAFT_URL}`]: ok(draftPage) });
    renderWithProviders(<Reader path={DRAFT} />);
    expect(await screen.findByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Warnings on this page")).toBeInTheDocument();
    expect(screen.getByText("Raw HTML is shown as text.")).toBeInTheDocument();
    expect(screen.getByText("The link ../x.md leads to nothing in the journal (x.md).")).toBeInTheDocument();
    expect(
      screen.getByText("The front matter is not valid YAML (line 3); the page renders without it."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Synced/)).toBeInTheDocument();
  });

  it("words the warnings in French too", async () => {
    mockFetch({ [`GET ${BASE}`]: ok(staffJournal()), [`GET ${DRAFT_URL}`]: ok(draftPage) });
    renderWithProviders(<Reader path={DRAFT} />, { locale: "fr" });
    expect(await screen.findByText("Le HTML brut est affiché comme du texte.")).toBeInTheDocument();
    expect(screen.getByText("Le lien ../x.md ne mène à rien dans le journal (x.md).")).toBeInTheDocument();
  });

  it("badges a page not visible yet with its date", async () => {
    const at = "2031-03-02T08:00:00.000Z";
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${POINTERS}`]: ok(staffPage(POINTERS, { hidden: true, visibleFrom: at })),
    });
    renderWithProviders(<Reader path={POINTERS} />);
    expect(await screen.findByText(/^Visible from 2031-03-0/)).toBeInTheDocument();
    expect(screen.queryByText("Draft")).toBeNull();
  });

  it("says why the last synchronisation failed", async () => {
    const journal = staffJournal();
    mockFetch({
      [`GET ${BASE}`]: ok({ ...journal, repository: { ...journal.repository!, syncStatus: "error", syncError: "ref_not_found" } }),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
    });
    renderWithProviders(<Reader path={HOME} />);
    expect(await screen.findByText(/The branch the journal follows no longer exists/)).toBeInTheDocument();
  });

  it("says so when the classroom has no journal", async () => {
    mockFetch({ [`GET ${BASE}`]: ok(staffJournal({ repository: null, nav: [], homePath: null, hiddenPaths: [] })) });
    renderWithProviders(<Reader />);
    expect(await screen.findByRole("heading", { level: 1, name: "No journal yet" })).toBeInTheDocument();
  });
});

describe("JournalReader — Refresh (M4-05)", () => {
  it("sits in the staff bar, secondary, and reads Refreshing… once clicked", async () => {
    const { calls } = mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
      [`POST ${BASE}/refresh`]: { status: 202 },
    });
    renderWithProviders(<Reader path={HOME} />);
    const refresh = await screen.findByRole("button", { name: /Refresh/ });
    expect(refresh.className).not.toMatch(/\bbg-accent\b/);
    await userEvent.click(refresh);
    expect(await screen.findByText("Refreshing…")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/refresh`)).toBe(true);
  });

  it("words a refused refresh, in French too", async () => {
    mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(staffPage(HOME)),
      [`POST ${BASE}/refresh`]: fail(503, { error: "github_unavailable", message: "github_unavailable" }),
    });
    renderWithProviders(<Reader path={HOME} />, { locale: "fr" });
    await userEvent.click(await screen.findByRole("button", { name: /Actualiser/ }));
    expect(await screen.findByText(/GitHub n'a pas répondu/)).toBeInTheDocument();
    expect(screen.queryByText("Actualisation…")).toBeNull();
  });

  it("says to Refresh when the journal has no page yet", async () => {
    mockFetch({ [`GET ${BASE}`]: ok(staffJournal({ nav: [], homePath: null, hiddenPaths: [] })) });
    renderWithProviders(<Reader />);
    expect(await screen.findByText("Add a markdown file to the journal's repository, then Refresh.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toBeInTheDocument();
  });
});

describe("JournalReader — the student", () => {
  it("reads the student payload, never the staff one, and shows no staff field", async () => {
    // The staff routes answer with every staff field set: were the student
    // view reading them, the badges, warnings and marks would show.
    const { calls } = mockFetch({
      [`GET ${BASE}`]: ok(staffJournal()),
      [`GET ${BASE}/pages/${HOME}`]: ok(
        staffPage(HOME, {
          draft: true,
          hidden: true,
          visibleFrom: "2031-03-02T08:00:00.000Z",
          warnings: [{ code: "raw_html" }],
        }),
      ),
      [`GET ${BASE}?view=student`]: ok(studentJournal),
      [`GET ${BASE}/pages/${HOME}?view=student`]: ok(studentPage(HOME)),
    });
    renderWithProviders(<Reader path={HOME} studentView />);
    expect(await screen.findByRole("heading", { level: 1, name: "Programmation 1" })).toBeInTheDocument();
    expect(calls.every((c) => c.url.endsWith("?view=student"))).toBe(true);
    for (const text of [/Draft/, /Visible from/, /Warnings/, /Synced/, /Hidden from students/]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("img", { name: "Hidden from students" })).toBeNull();
    // No staff bar: a student has no action here (F-JRN-07).
    expect(screen.queryByRole("button", { name: /Refresh/ })).toBeNull();
    // The staff navigation's second section is not the student's.
    expect(screen.queryByText("Semaine 2 été")).toBeNull();
    // Nor does a folder's menu carry a staff mark.
    await userEvent.click(screen.getByRole("button", { name: "Pages in Semaine 1" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem")).toHaveLength(2);
    expect(screen.queryByRole("img", { name: "Hidden from students" })).toBeNull();
  });

  it("reads a 404 of the journal as not found", async () => {
    mockFetch({ [`GET ${BASE}?view=student`]: fail(404, { message: "Not found" }) });
    renderWithProviders(<Reader studentView />);
    expect(await screen.findByRole("heading", { level: 1, name: "Journal not found" })).toBeInTheDocument();
  });

  it("reads a 404 of a page as a page not found, the navigation still there", async () => {
    mockFetch({
      [`GET ${BASE}?view=student`]: ok(studentJournal),
      [`GET ${BASE}/pages/nope.md?view=student`]: fail(404, { message: "Not found" }),
      [`GET ${BASE}/pages/${HOME}?view=student`]: ok(studentPage(HOME)),
    });
    renderWithProviders(<Reader path="nope.md" studentView />);
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Pages of the journal" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to the journal's home" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Programmation 1" })).toBeInTheDocument();
  });

  it("offers a retry when the journal fails to load", async () => {
    const routes: Record<string, RouteHandler> = { [`GET ${BASE}?view=student`]: fail(500, { message: "Boom" }) };
    mockFetch(routes);
    renderWithProviders(<Reader studentView />);
    expect(await screen.findByText("Boom")).toBeInTheDocument();
    routes[`GET ${BASE}?view=student`] = ok({ ...studentJournal, nav: [], homePath: null });
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Nothing to read yet" })).toBeInTheDocument());
  });
});
