import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JournalFileWritten, JournalPageStaff, JournalStaff } from "@quiz/contracts";

import type { Route } from "../../router";
import { fail, mockFetch, noContent, ok, renderWithProviders, type RouteHandler } from "../../test/render";
import { JournalReader } from "../JournalReader";
// The reader loads the editor lazily; loaded here once, Edit finds it ready.
import "./JournalEditor";

/*
 * The journal's editor in the reader (F-JRN-10, F-JRN-11, ADR-057), Quiz
 * mode: Edit in the staff bar, the platform's standard rich text field, the
 * front matter as fields, Save against the version it opened (and nothing
 * sent while nothing changed), the next save against the version the save
 * answered, a 409 that keeps the draft, a picture stored beside the page
 * with a relative path, add and delete a page, the history and its
 * restore, the deleted pages, and leaving with unsaved changes.
 */

// ProseMirror asks jsdom for rectangles it does not lay out (markdown/RichText.test.tsx).
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
document.elementFromPoint ??= () => null;

const BASE = "/app/api/classrooms/r1/journal";
const PATH = "semaine-01/index.md";
const MARKDOWN = [
  "---",
  "title: Semaine 1",
  "author: Yves",
  "---",
  "",
  "# Introduction",
  "",
  "Un texte avec de l'_emphase_ et [un lien](../annexe/outils.md#gcc).",
  "",
  "![Le schéma](images/schema.png)",
  "",
].join("\n");

const journal = (): JournalStaff => ({
  view: "staff",
  mode: "quiz",
  repository: null,
  nav: [
    {
      path: "semaine-01",
      title: "Semaine 1",
      pagePath: PATH,
      children: [],
    },
  ],
  homePath: PATH,
  hiddenPaths: [],
  warningCount: 0,
  pageCount: 1,
  proposedName: null,
});

const page = (over: Partial<JournalPageStaff> = {}): JournalPageStaff => ({
  view: "staff",
  path: PATH,
  title: "Semaine 1",
  html: '<h1 id="introduction">Introduction</h1><p>Le texte publié.</p>',
  toc: [{ id: "introduction", depth: 1, text: "Introduction" }],
  updatedAt: new Date(0).toISOString(),
  draft: false,
  visibleFrom: null,
  hidden: false,
  markdown: MARKDOWN,
  version: 4,
  warnings: [],
  editUrl: null,
  ...over,
});

const written = (markdown: string, version = 5): JournalFileWritten => ({
  path: PATH,
  page: page({ markdown, version, html: "<p>Saved.</p>" }),
});

const navigateSpy = vi.fn();

function Reader() {
  const [route, setRoute] = useState<Route>({ view: "classroomJournal", id: "r1", path: PATH });
  if (route.view !== "classroomJournal") return <p>left the journal</p>;
  return (
    <JournalReader
      classroomId={route.id}
      path={route.path}
      studentView={false}
      navigate={(r, options) => {
        navigateSpy(r, options);
        setRoute(r);
      }}
    />
  );
}

function setup(routes: Record<string, RouteHandler> = {}) {
  const fetch = mockFetch({
    [`GET ${BASE}`]: ok(journal()),
    [`GET ${BASE}/pages/${PATH}`]: ok(page()),
    ...routes,
  });
  renderWithProviders(<Reader />, { route: `/classrooms/r1/journal/${PATH}` });
  return fetch;
}

async function openEditor() {
  const edit = await screen.findByRole("button", { name: "Edit" });
  // Enabled once the page is on view.
  await waitFor(() => expect(edit).toBeEnabled());
  await userEvent.click(edit);
  return screen.findByRole("textbox", { name: "Page text" });
}

const saveButton = () => screen.getByRole("button", { name: "Save" });

/** An item of the staff bar's Pages menu. */
async function pagesMenu(item: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Pages" }));
  await userEvent.click(screen.getByRole("menuitem", { name: item }));
}

beforeEach(() => {
  navigateSpy.mockReset();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /min-width: (\d+)px/.test(query) ? 1440 >= Number(/(\d+)px/.exec(query)![1]) : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
});

describe("Edit in the staff bar", () => {
  it("is the primary of the bar, and opens the page's source in the editor", async () => {
    setup();
    const surface = await openEditor();
    // The body, rendered: no front matter in it, the emphasis as a node.
    expect(within(surface).getByRole("heading", { level: 1, name: "Introduction" })).toBeInTheDocument();
    expect(surface.textContent).not.toContain("author: Yves");
    expect(surface.querySelector("em")?.textContent).toBe("emphase");
    // The relative picture is drawn from the journal's asset route.
    expect(surface.querySelector("img")?.getAttribute("src")).toBe(`${BASE}/assets/semaine-01/images/schema.png`);
  });

});

describe("a page that was not edited is never written", () => {
  it("keeps Save off while the markdown is the page's, byte for byte, and sends nothing", async () => {
    const { calls } = setup();
    await openEditor();
    expect(screen.getByText("No changes")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    // A field changed and changed back is no edit either.
    const title = screen.getByLabelText("Title");
    await userEvent.type(title, "!");
    expect(saveButton()).toBeEnabled();
    await userEvent.type(title, "{Backspace}");
    expect(saveButton()).toBeDisabled();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("the front matter as fields", () => {
  it("shows the four fields and writes a change into its own line only", async () => {
    const { calls } = setup({
      [`PUT ${BASE}/pages/${PATH}`]: (call) => ok(written((call.body as { markdown: string }).markdown)),
    });
    await openEditor();
    const title = screen.getByLabelText("Title");
    expect(title).toHaveValue("Semaine 1");
    expect(screen.getByLabelText("Date")).toHaveValue("");
    expect(screen.getByRole("switch", { name: "Draft" })).toHaveAttribute("aria-checked", "false");
    await userEvent.clear(title);
    await userEvent.type(title, "Semaine 1: les bases");
    await userEvent.click(screen.getByRole("switch", { name: "Draft" }));
    // No commit message any more (ADR-057): nothing but the page is sent.
    expect(screen.queryByLabelText(/Describe the change/)).toBeNull();
    await userEvent.click(saveButton());

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({
      markdown: MARKDOWN.replace("title: Semaine 1", 'title: "Semaine 1: les bases"').replace(
        "author: Yves\n",
        "author: Yves\ndraft: true\n",
      ),
      baseVersion: 4,
    });
    // Saved: back to reading.
    expect(await screen.findByText("Page saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Page text" })).toBeNull();
  });
});

describe("F-JRN-09: an image outside the journal is never fetched", () => {
  it("shows its alt text, puts no external src in the DOM, and keeps the markdown", async () => {
    const md = "# A\n\n![logo](https://evil/x.png)\n\n![](//evil/y.png)\n";
    const { calls } = setup({
      [`GET ${BASE}/pages/${PATH}`]: ok(page({ markdown: md })),
      [`PUT ${BASE}/pages/${PATH}`]: (call) => ok(written((call.body as { markdown: string }).markdown)),
    });
    const surface = await openEditor();
    expect(document.querySelector('img[src^="http"], img[src^="//"]')).toBeNull();
    expect(within(surface).getByText("Image outside the journal, not shown: logo")).toBeInTheDocument();
    expect(within(surface).getByText("Image outside the journal, not shown")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    // A field changed: the body, images included, goes back as it was read.
    await userEvent.type(screen.getByLabelText("Title"), "T");
    await userEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect((calls.find((c) => c.method === "PUT")!.body as { markdown: string }).markdown).toBe(
      `---\ntitle: T\n---\n${md}`,
    );
  });

  it("reads `draft: 1` as the renderer does: a draft", async () => {
    setup({ [`GET ${BASE}/pages/${PATH}`]: ok(page({ markdown: "---\ndraft: 1\n---\n# A\n" })) });
    await openEditor();
    expect(screen.getByRole("switch", { name: "Draft" })).toHaveAttribute("aria-checked", "true");
  });

  it("words a failed preview as a journal refusal", async () => {
    setup({ [`POST ${BASE}/preview`]: fail(409, { error: "no_journal", message: "no_journal" }) });
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Markdown source" }));
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("This classroom has no journal any more.")).toBeInTheDocument();
  });
});

describe("the date fields", () => {
  it("writes a date and a visibility moment, each in its own line", async () => {
    const { calls } = setup({
      [`PUT ${BASE}/pages/${PATH}`]: (call) => ok(written((call.body as { markdown: string }).markdown)),
    });
    await openEditor();
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-02" } });
    fireEvent.change(screen.getByLabelText("Visible to students from"), { target: { value: "2026-10-05T08:00" } });
    await userEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const yaml = (calls.find((c) => c.method === "PUT")!.body as { markdown: string }).markdown.split("---")[1]!;
    expect(yaml).toMatch(/\ndate: 2026-10-02\nvisible_from: 2026-10-05T08:00:00[+-]\d{2}:\d{2}\n$/);
    expect(yaml).toContain("title: Semaine 1\nauthor: Yves\n");
  });

  it("shows a value that is not a date as text, untouched until edited", async () => {
    setup({
      [`GET ${BASE}/pages/${PATH}`]: ok(page({ markdown: "---\ndate: semaine 3\nvisible_from: next week\n---\n# A\n" })),
    });
    await openEditor();
    expect(screen.getByLabelText("Date")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Date")).toHaveValue("semaine 3");
    expect(screen.getByLabelText("Visible to students from")).toHaveValue("next week");
    await userEvent.type(screen.getByLabelText("Visible to students from"), "!");
    expect(saveButton()).toBeEnabled();
  });
});

describe("the source view", () => {
  it("previews the markdown through the students' renderer, on demand", async () => {
    const { calls } = setup({
      [`POST ${BASE}/preview`]: ok({
        title: "Introduction",
        html: "<h1 id=\"introduction\">Introduction</h1><p>Rendu par le serveur.</p>",
        toc: [],
        draft: false,
        visibleFrom: null,
        warnings: [],
      }),
    });
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Markdown source" }));
    const source = screen.getByRole("textbox", { name: "Page text" });
    expect(source).toHaveValue(splitPageBody(MARKDOWN));
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("Rendu par le serveur.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === `${BASE}/preview`)!.body).toEqual({ path: PATH, markdown: MARKDOWN });
  });
});

/** The body the editor opens on: the page without its front matter. */
const splitPageBody = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, "");

describe("the save flow", () => {
  it("sends the markdown the standard editor writes, with the front matter, against the version opened", async () => {
    const { calls } = setup({
      [`PUT ${BASE}/pages/${PATH}`]: (call) => ok(written((call.body as { markdown: string }).markdown)),
    });
    const surface = await openEditor();
    // A word typed at the end of the heading.
    const heading = within(surface).getByRole("heading", { level: 1 });
    heading.textContent = "Introduction au C";
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await userEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!.body as Record<string, unknown>;
    expect(Object.keys(put).sort()).toEqual(["baseVersion", "markdown"]);
    expect(put.baseVersion).toBe(4);
    const markdown = put.markdown as string;
    // The front matter as read; the body as the standard editor writes it
    // (its normalisation is accepted, ADR-057), the picture's relative path kept.
    expect(markdown.startsWith("---\ntitle: Semaine 1\nauthor: Yves\n---\n")).toBe(true);
    expect(markdown).toContain("# Introduction au C");
    expect(markdown).toContain("emphase");
    expect(markdown).toContain("](images/schema.png)");
  });

  it("saves the next time against the version the save answered", async () => {
    // The server's page moves with each save, as the API's does.
    let current = page();
    const { calls } = setup({
      [`GET ${BASE}/pages/${PATH}`]: () => ok(current),
      [`PUT ${BASE}/pages/${PATH}`]: (call) => {
        const saved = written((call.body as { markdown: string }).markdown, current.version + 1);
        current = saved.page!;
        return ok(saved);
      },
    });
    await openEditor();
    await userEvent.type(screen.getByLabelText("Title"), "!");
    await userEvent.click(saveButton());
    expect(await screen.findByText("Page saved.")).toBeInTheDocument();
    await openEditor();
    await userEvent.type(screen.getByLabelText("Title"), "?");
    await userEvent.click(saveButton());
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    const bases = calls.filter((c) => c.method === "PUT").map((c) => (c.body as { baseVersion: number }).baseVersion);
    expect(bases).toEqual([4, 5]);
  });

  it("keeps the draft on a 409, says why, and offers to copy it or reload", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { calls } = setup({
      [`PUT ${BASE}/pages/${PATH}`]: fail(409, { error: "conflict", message: "conflict" }),
    });
    await openEditor();
    const title = screen.getByLabelText("Title");
    await userEvent.type(title, " (draft)");
    await userEvent.click(saveButton());

    expect(await screen.findByText("Someone saved this page since you opened it")).toBeInTheDocument();
    // Nothing lost, nothing merged, no second try against the same blob.
    expect(screen.getByLabelText("Title")).toHaveValue("Semaine 1 (draft)");
    expect(screen.getByRole("textbox", { name: "Page text" })).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Copy my text" }));
    expect(writeText).toHaveBeenCalledWith(MARKDOWN.replace("title: Semaine 1", "title: Semaine 1 (draft)"));

    // Reload asks first, then opens the page as read again.
    await userEvent.click(screen.getByRole("button", { name: "Reload the page…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reload the page and lose your text?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Reload and lose my text" }));
    await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Semaine 1"));
    expect(screen.queryByText("Someone saved this page since you opened it")).toBeNull();
  });

  it("words any other refusal and stays in the editor", async () => {
    setup({ [`PUT ${BASE}/pages/${PATH}`]: fail(409, { error: "read_only", message: "read_only" }) });
    await openEditor();
    await userEvent.type(screen.getByLabelText("Title"), "!");
    await userEvent.click(saveButton());
    expect(await screen.findByText("This journal lives in a GitHub repository: edit it on GitHub.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page text" })).toBeInTheDocument();
  });
});

describe("F-JRN-11: a picture is stored beside the page, with a relative path", () => {
  it("uploads beside the page and inserts images/<name>, never asset:", async () => {
    URL.createObjectURL = () => "blob:local-copy";
    // The six random characters of the name, fixed.
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).set([0xab, 0xcd, 0xef]);
      return array;
    });
    const UPLOAD = `${BASE}/assets/semaine-01/images/capture-ecran-abcdef.png`;
    const { calls, fetchMock } = setup({
      [`POST ${UPLOAD}`]: ok({ path: "semaine-01/images/capture-ecran-abcdef.png", page: null }),
      [`PUT ${BASE}/pages/${PATH}`]: (call) => ok(written((call.body as { markdown: string }).markdown)),
    });
    const surface = await openEditor();
    const input = document.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "Capture écran.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(calls.some((c) => c.url === UPLOAD)).toBe(true));
    const init = fetchMock.mock.calls.find(([url]) => String(url) === UPLOAD)![1] as RequestInit;
    expect(new Headers(init.headers).get("content-type")).toBe("image/png");

    // Drawn from the browser's copy until a saved page references it.
    await waitFor(() => expect(surface.querySelectorAll("img")).toHaveLength(2));
    expect([...surface.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toContain("blob:local-copy");

    await userEvent.click(saveButton());
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!.body as { markdown: string };
    expect(put.markdown).toContain("![Capture écran](images/capture-ecran-abcdef.png)");
    expect(put.markdown).not.toContain("asset:");
  });
});

describe("leaving with unsaved changes", () => {
  it("asks before Cancel throws an edit away, and not when nothing changed", async () => {
    setup();
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Nothing changed: back to reading at once.
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();

    await openEditor();
    await userEvent.type(screen.getByLabelText("Title"), "!");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    // A reload or a closed tab: the browser's own prompt.
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    let dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Semaine 1!");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByRole("button", { name: "Edit" })).toBeInTheDocument();
  });
});

describe("add and delete a page", () => {
  it("adds a page at a .md path, in the folder being read, and opens it in the editor", async () => {
    const added = page({ path: "semaine-01/exercices.md", markdown: "# Exercices\n", title: "Exercices" });
    const { calls } = setup({
      [`POST ${BASE}/pages`]: ok({ path: added.path, page: added }),
      [`GET ${BASE}/pages/semaine-01/exercices.md`]: ok(added),
    });
    await pagesMenu("Add a page");
    const dialog = await screen.findByRole("dialog", { name: "Add a page" });
    const file = within(dialog).getByLabelText("File");
    expect(file).toHaveValue("semaine-01/");
    const submit = within(dialog).getByRole("button", { name: "Add the page" });
    await userEvent.type(file, "exercices");
    expect(submit).toBeDisabled();
    expect(within(dialog).getByText(/A page is a \.md file/)).toBeInTheDocument();
    await userEvent.type(file, ".md");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Exercices");
    await userEvent.click(submit);

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/pages`)).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ path: "semaine-01/exercices.md", title: "Exercices" });
    expect(navigateSpy).toHaveBeenLastCalledWith(
      { view: "classroomJournal", id: "r1", path: "semaine-01/exercices.md" },
      undefined,
    );
    const surface = await screen.findByRole("textbox", { name: "Page text" });
    expect(within(surface).getByRole("heading", { level: 1, name: "Exercices" })).toBeInTheDocument();
  });

  it("refuses a path outside the journal", async () => {
    setup();
    await pagesMenu("Add a page");
    const dialog = await screen.findByRole("dialog", { name: "Add a page" });
    const file = within(dialog).getByLabelText("File");
    await userEvent.clear(file);
    await userEvent.type(file, "../.github/x.md");
    expect(within(dialog).getByRole("button", { name: "Add the page" })).toBeDisabled();
  });

  it("deletes the page being read after a confirmation, and goes home", async () => {
    const { calls } = setup({ [`DELETE ${BASE}/pages/${PATH}`]: noContent() });
    await screen.findByRole("heading", { name: "Introduction" });
    await pagesMenu("Delete this page");
    const dialog = await screen.findByRole("dialog", { name: "Delete “Semaine 1”?" });
    expect(within(dialog).getByText(/semaine-01\/index\.md leaves the journal/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete the page" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({ view: "classroomJournal", id: "r1" }, { replace: true }),
    );
  });
});

describe("the history (ADR-057)", () => {
  const REVISIONS = [
    { id: "0190d3c4-0000-7000-8000-000000000003", path: PATH, author: "Yves Chevallier", createdAt: "2026-09-30T10:00:00.000Z" },
    { id: "0190d3c4-0000-7000-8000-000000000002", path: PATH, author: null, createdAt: "2026-09-20T10:00:00.000Z" },
  ];
  const OLD = { ...REVISIONS[1]!, markdown: "# Introduction\n\nLa première version.\n" };

  it("lists the page's revisions, shows one as rendered or as markdown, and restores it after a confirmation", async () => {
    const { calls } = setup({
      [`GET ${BASE}/revisions/${PATH}`]: ok(REVISIONS),
      [`GET ${BASE}/revision/${REVISIONS[0]!.id}`]: ok({ ...REVISIONS[0]!, markdown: MARKDOWN }),
      [`GET ${BASE}/revision/${OLD.id}`]: ok(OLD),
      [`POST ${BASE}/preview`]: (call) =>
        ok({
          title: "Introduction",
          html: `<p>${(call.body as { markdown: string }).markdown.includes("première") ? "Rendu ancien" : "Rendu actuel"}</p>`,
          toc: [],
          draft: false,
          visibleFrom: null,
          warnings: [],
        }),
      [`POST ${BASE}/restore`]: ok(written(OLD.markdown, 5)),
    });
    await screen.findByRole("heading", { name: "Introduction" });
    await pagesMenu("History");
    const sheet = await screen.findByRole("dialog", { name: "History of Semaine 1" });
    const restore = within(sheet).getByRole("button", { name: "Restore this version" });
    // The newest is the page as it is: nothing to restore.
    expect(await within(sheet).findByText("Rendu actuel")).toBeInTheDocument();
    expect(restore).toBeDisabled();
    expect(within(sheet).getByText("Current")).toBeInTheDocument();
    expect(within(sheet).getByText("Unknown author")).toBeInTheDocument();

    await userEvent.click(within(sheet).getByText("Unknown author"));
    expect(await within(sheet).findByText("Rendu ancien")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("radio", { name: "Markdown" }));
    expect(within(sheet).getByText(/La première version\./)).toBeInTheDocument();

    await userEvent.click(restore);
    const dialog = await screen.findByRole("dialog", { name: "Restore this version?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/restore`)).toBe(true));
    expect(calls.find((c) => c.url === `${BASE}/restore`)!.body).toEqual({ revisionId: OLD.id });
    expect(await screen.findByText("Version restored.")).toBeInTheDocument();
  });

  it("brings a deleted page back from its last revision, and opens it", async () => {
    const GONE = "semaine-01/ancien.md";
    const { calls } = setup({
      [`GET ${BASE}/deleted`]: ok([{ path: GONE, title: "Ancien TD", savedAt: "2026-09-28T10:00:00.000Z" }]),
      [`GET ${BASE}/revisions/${GONE}`]: ok([{ ...REVISIONS[0]!, path: GONE }]),
      [`POST ${BASE}/restore`]: ok({ path: GONE, page: page({ path: GONE, title: "Ancien TD" }) }),
      [`GET ${BASE}/pages/${GONE}`]: ok(page({ path: GONE, title: "Ancien TD" })),
    });
    await pagesMenu("Deleted pages");
    const sheet = await screen.findByRole("dialog", { name: "Deleted pages" });
    await userEvent.click(await within(sheet).findByRole("button", { name: "Restore" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore “Ancien TD”?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/restore`)).toBe(true));
    expect(calls.find((c) => c.url === `${BASE}/restore`)!.body).toEqual({ revisionId: REVISIONS[0]!.id });
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({ view: "classroomJournal", id: "r1", path: GONE }, undefined),
    );
  });
});
