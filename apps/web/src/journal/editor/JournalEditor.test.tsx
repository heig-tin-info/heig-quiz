import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JournalFileWritten, JournalPageStaff, JournalStaff } from "@quiz/contracts";

import type { Route } from "../../router";
import { fail, mockFetch, noContent, ok, renderWithProviders, type RouteHandler } from "../../test/render";
import { JournalReader } from "../JournalReader";

/*
 * The journal's editor in the reader (F-JRN-10, F-JRN-11, D25): Edit in the
 * staff bar, the front matter as fields, Save against the blob it opened
 * (and nothing sent while nothing changed), a 409 that keeps the draft, a
 * picture written into the repository with a relative path, add and delete
 * a page, and leaving with unsaved changes.
 */

// ProseMirror asks jsdom for rectangles it does not lay out (markdown/RichText.test.tsx).
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
document.elementFromPoint ??= () => null;

const BASE = "/app/api/classrooms/r1/journal";
const PATH = "semaine-01/index.md";
const SHA = "a".repeat(40);
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

const journal = (editable = true): JournalStaff => ({
  view: "staff",
  repository: {
    fullName: "heig-tin-info/prg1-journal",
    ref: "main",
    rootPath: "",
    htmlUrl: "https://github.com/heig-tin-info/prg1-journal",
    syncStatus: "ok",
    syncError: null,
    lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
    lastCommitSha: "c".repeat(40),
    editable,
  },
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
  blobSha: SHA,
  warnings: [],
  ...over,
});

const written = (markdown: string): JournalFileWritten => ({
  path: PATH,
  blobSha: "b".repeat(40),
  commitSha: "d".repeat(40),
  page: page({ markdown, blobSha: "b".repeat(40), html: "<p>Saved.</p>" }),
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

function setup(routes: Record<string, RouteHandler> = {}, editable = true) {
  const fetch = mockFetch({
    [`GET ${BASE}`]: ok(journal(editable)),
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

  it("waits for a copy that may be written over", async () => {
    setup({}, false);
    expect(await screen.findByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add a page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete this page" })).toBeDisabled();
  });
});

describe("D25 (5): a page that was not edited is never written", () => {
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

describe("D25 (2): the front matter as fields", () => {
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
    await userEvent.type(screen.getByLabelText(/Describe the change/), "Rename week 1");
    await userEvent.click(saveButton());

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({
      markdown: MARKDOWN.replace("title: Semaine 1", 'title: "Semaine 1: les bases"').replace(
        "author: Yves\n",
        "author: Yves\ndraft: true\n",
      ),
      baseSha: SHA,
      message: "Rename week 1",
    });
    // Saved: back to reading.
    expect(await screen.findByText("Page saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Page text" })).toBeNull();
  });
});

describe("the save flow", () => {
  it("sends the body as typed, with front matter and every untouched block as read", async () => {
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
    const put = calls.find((c) => c.method === "PUT")!.body as { markdown: string; message?: string };
    expect(put.markdown).toBe(MARKDOWN.replace("# Introduction", "# Introduction au C"));
    expect(put.message).toBeUndefined();
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

    expect(await screen.findByText("This page changed on GitHub since you opened it")).toBeInTheDocument();
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
    expect(screen.queryByText("This page changed on GitHub since you opened it")).toBeNull();
  });

  it("words any other refusal and stays in the editor", async () => {
    setup({ [`PUT ${BASE}/pages/${PATH}`]: fail(503, { error: "github_unavailable", message: "x" }) });
    await openEditor();
    await userEvent.type(screen.getByLabelText("Title"), "!");
    await userEvent.click(saveButton());
    expect(await screen.findByText("GitHub did not answer. Try again in a few minutes.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page text" })).toBeInTheDocument();
  });
});

describe("D25 (3): a picture goes into the repository, with a relative path", () => {
  it("uploads beside the page and inserts images/<name>, never asset:", async () => {
    URL.createObjectURL = () => "blob:local-copy";
    // The six random characters of the name, fixed.
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T) => {
      (array as unknown as Uint8Array).set([0xab, 0xcd, 0xef]);
      return array;
    });
    const UPLOAD = `${BASE}/assets/semaine-01/images/capture-ecran-abcdef.png`;
    const { calls, fetchMock } = setup({
      [`POST ${UPLOAD}`]: ok({ path: "semaine-01/images/capture-ecran-abcdef.png", blobSha: SHA, commitSha: SHA, page: null }),
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
      [`POST ${BASE}/pages`]: ok({ path: added.path, blobSha: "e".repeat(40), commitSha: "f".repeat(40), page: added }),
      [`GET ${BASE}/pages/semaine-01/exercices.md`]: ok(added),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Add a page" }));
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
    await userEvent.click(await screen.findByRole("button", { name: "Add a page" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a page" });
    const file = within(dialog).getByLabelText("File");
    await userEvent.clear(file);
    await userEvent.type(file, "../.github/x.md");
    expect(within(dialog).getByRole("button", { name: "Add the page" })).toBeDisabled();
  });

  it("deletes the page being read after a confirmation, and goes home", async () => {
    const { calls } = setup({ [`DELETE ${BASE}/pages/${PATH}`]: noContent() });
    await userEvent.click(await screen.findByRole("button", { name: "Delete this page" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Semaine 1”?" });
    expect(within(dialog).getByText(/semaine-01\/index\.md is deleted from the repository/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete the page" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({ view: "classroomJournal", id: "r1" }, { replace: true }),
    );
  });
});
