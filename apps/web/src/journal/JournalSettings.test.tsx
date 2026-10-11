import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GithubClassroom, JournalRepository, JournalStaff } from "@quiz/contracts";

import { makeClassroomDetail } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders, type RecordedCall } from "../test/render";
import { JournalSettings } from "./JournalSettings";

/*
 * The Journal section of a classroom's Settings (F-JRN-02 to F-JRN-05,
 * M4-05, ADR-057): the mode first, In Quiz by default (one Create, no
 * GitHub needed) or In a GitHub repository (one line until the classroom
 * is connected; then "Create a journal" with the proposed name, the 409
 * `name_taken` and its suggestion in one click, and "Use a repository",
 * branch and folder behind a disclosure, the refusals worded); once set,
 * a Quiz-mode journal's pages and its removal by the classroom's typed
 * name, or the repository, its sync state, Refresh and "Remove the
 * journal", confirmed. Nothing accented; In Quiz only on a platform
 * without Quiz's App; nothing at all without the journal's routes (404).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const GITHUB = "/app/api/classrooms/r1/github";
const JOURNAL = "/app/api/classrooms/r1/journal";
const INSTALL = "https://github.com/apps/heig-quiz/installations/new?state=r1";

const connected: GithubClassroom = {
  link: {
    org: {
      id: "0190d3c4-0000-7000-8000-00000000a001",
      login: "heig-tin-info",
      avatarUrl: null,
      installed: true,
      status: "active",
      plan: "team",
    },
    linkedAt: "2026-09-01T00:00:00.000Z",
    checks: { allRepositories: true, llmSecret: "present" },
  },
  suggestedOrgId: null,
  installUrl: INSTALL,
};
const plain: GithubClassroom = { link: null, suggestedOrgId: null, installUrl: INSTALL };

const repository = (over: Partial<JournalRepository> = {}): JournalRepository => ({
  fullName: "heig-tin-info/prg1-journal",
  ref: "main",
  rootPath: "",
  htmlUrl: "https://github.com/heig-tin-info/prg1-journal",
  syncStatus: "ok",
  syncError: null,
  lastSyncedAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastCommitSha: "abc",
  ...over,
});

const staff = (repo: JournalRepository | null, over: Partial<JournalStaff> = {}): JournalStaff => ({
  view: "staff",
  mode: repo ? "github" : null,
  repository: repo,
  nav: [],
  homePath: null,
  hiddenPaths: [],
  warningCount: 0,
  pageCount: 0,
  proposedName: repo ? null : "prg1-2026-journal",
  ...over,
});

/** A Quiz-mode journal holding `pageCount` pages. */
const quizJournal = (pageCount: number) => staff(null, { mode: "quiz", pageCount, proposedName: null });

/** Picks "In a GitHub repository" in the mode's segmented control. */
async function chooseGithub(name = "In a GitHub repository") {
  await userEvent.click(await screen.findByRole("radio", { name }));
}

function renderSection() {
  return renderWithProviders(<JournalSettings room={makeClassroomDetail()} />);
}

/** The section, once drawn. */
const section = async () => (await screen.findByRole("heading", { name: "Journal" })).closest("section")!;

/** No button of the section is the accent (F-ORG-13: nothing accented once connected). */
function expectNoAccent(root: HTMLElement) {
  for (const button of within(root).getAllByRole("button")) expect(button.className).not.toMatch(/\bbg-accent\b/);
}

describe("the Journal section — before a journal", () => {
  it("draws nothing on a platform without Quiz's App (the GitHub route 404s)", async () => {
    const { calls } = mockFetch({ [`GET ${GITHUB}`]: fail(404, {}), [`GET ${JOURNAL}`]: fail(404, {}) });
    renderSection();
    await waitFor(() => expect(calls.length).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("heading", { name: "Journal" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("draws nothing when only the journal's route is absent", async () => {
    const { calls } = mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`GET ${JOURNAL}`]: fail(404, {}) });
    renderSection();
    await waitFor(() => expect(calls.length).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("heading", { name: "Journal" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("starts on In Quiz, which needs no GitHub: one Create, posting the mode", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(plain),
      [`GET ${JOURNAL}`]: ok(staff(null)),
      [`POST ${JOURNAL}`]: { status: 201, body: quizJournal(1) },
    });
    renderSection();
    const root = await section();
    expect(within(root).getByRole("radio", { name: "In Quiz" })).toBeChecked();
    expect(within(root).getByText(/Written here, in Quiz's editor/)).toBeVisible();
    expectNoAccent(root);
    await userEvent.click(within(root).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ mode: "quiz" });
    expect(await screen.findByText("Journal created.")).toBeVisible();
  });

  it("says the GitHub mode needs the connection, with no action, until the classroom is connected", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(plain), [`GET ${JOURNAL}`]: ok(staff(null)) });
    renderSection();
    const root = await section();
    await chooseGithub();
    expect(within(root).getByText(/Written in a repository of the classroom's organization/)).toBeVisible();
    expect(within(root).getByText("Needs the GitHub connection")).toBeVisible();
    expect(within(root).getByText(/in the GitHub section above/)).toBeVisible();
    expect(within(root).queryByRole("button", { name: /Create|Choose/ })).toBeNull();
  });

  it("offers In Quiz only on a platform without Quiz's App", async () => {
    mockFetch({ [`GET ${GITHUB}`]: fail(404, {}), [`GET ${JOURNAL}`]: ok(staff(null)) });
    renderSection();
    const root = await section();
    expect(within(root).queryByRole("radiogroup")).toBeNull();
    expect(within(root).getByRole("button", { name: "Create" })).toBeVisible();
  });

  it("says when the journal could not be read, with a retry", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`GET ${JOURNAL}`]: fail(500, { message: "boom" }) });
    renderSection();
    expect(await screen.findByText("Could not load the journal")).toBeVisible();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeVisible();
  });

  it("offers to create or use a repository once connected, neither accented", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`GET ${JOURNAL}`]: ok(staff(null)) });
    renderSection();
    const root = await section();
    await chooseGithub();
    expect(within(root).getByText("Create a journal")).toBeVisible();
    expect(within(root).getByText("Use a repository")).toBeVisible();
    expect(within(root).getByText(/A new private repository in heig-tin-info/)).toBeVisible();
    expectNoAccent(root);
  });
});

describe("the Journal section — Create a journal", () => {
  it("creates under the proposed name, then shows the repository", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(null)),
      [`POST ${JOURNAL}`]: { status: 201, body: staff(repository({ fullName: "heig-tin-info/prg1-2026-journal" })) },
    });
    renderSection();
    await chooseGithub();
    await userEvent.click(await screen.findByRole("button", { name: "Create…" }));
    const dialog = await screen.findByRole("dialog", { name: /Create a journal/ });
    expect(within(dialog).getByLabelText(/Repository name/)).toHaveValue("prg1-2026-journal");
    expect(within(dialog).getByText(/invited to it, with push rights/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create the journal" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ mode: "github", name: "prg1-2026-journal" });
    expect(await screen.findByText(/Journal set: heig-tin-info\/prg1-2026-journal/)).toBeVisible();
  });

  it("refuses a name GitHub would not take, before asking", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`GET ${JOURNAL}`]: ok(staff(null)) });
    renderSection();
    await chooseGithub();
    await userEvent.click(await screen.findByRole("button", { name: "Create…" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText(/Repository name/);
    await userEvent.clear(field);
    await userEvent.type(field, "mon journal");
    expect(within(dialog).getByText(/Letters, digits/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Create the journal" })).toBeDisabled();
  });

  it("offers the free name a taken one gets, and creates it in one click", async () => {
    const posts: unknown[] = [];
    mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(null)),
      [`POST ${JOURNAL}`]: (call: RecordedCall) => {
        posts.push(call.body);
        return posts.length === 1
          ? fail(409, { error: "name_taken", message: "name_taken", suggestion: "prg1-journal-0190d3c4" })
          : { status: 201, body: staff(repository({ fullName: "heig-tin-info/prg1-journal-0190d3c4" })) };
      },
    });
    renderSection();
    await chooseGithub();
    await userEvent.click(await screen.findByRole("button", { name: "Create…" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText(/Repository name/);
    await userEvent.clear(field);
    await userEvent.type(field, "prg1-journal");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create the journal" }));

    expect(await within(dialog).findByText("heig-tin-info/prg1-journal already exists")).toBeVisible();
    expect(within(dialog).getByText(/never takes over an existing repository/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create prg1-journal-0190d3c4" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([{ mode: "github", name: "prg1-journal" }, { mode: "github", name: "prg1-journal-0190d3c4" }]);
  });

});

describe("the Journal section — Use a repository", () => {
  async function openUse() {
    await chooseGithub();
    await userEvent.click(await screen.findByRole("button", { name: "Choose…" }));
    return screen.findByRole("dialog", { name: /Use a repository/ });
  }

  it("uses a repository by its name alone: the default branch, the whole repository", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(null)),
      [`POST ${JOURNAL}/use`]: { status: 201, body: staff(repository()) },
    });
    renderSection();
    const dialog = await openUse();
    // The expert fields stay folded (docs/spec/08).
    expect(within(dialog).queryByLabelText("Branch")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText(/Repository name/), "prg1-journal");
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this repository" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "prg1-journal" });
  });

  it("sends the branch and the folder from the disclosure, the folder's slashes trimmed", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(null)),
      [`POST ${JOURNAL}/use`]: { status: 201, body: staff(repository({ ref: "dev", rootPath: "docs" })) },
    });
    renderSection();
    const dialog = await openUse();
    await userEvent.type(within(dialog).getByLabelText(/Repository name/), "prg1-journal");
    await userEvent.click(within(dialog).getByRole("button", { name: "Branch and folder" }));
    await userEvent.type(within(dialog).getByLabelText("Branch"), "dev");
    await userEvent.type(within(dialog).getByLabelText("Folder"), "/docs/");
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this repository" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "prg1-journal", ref: "dev", rootPath: "docs" });
  });

  it("says when a branch or a folder is not one, before asking", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`GET ${JOURNAL}`]: ok(staff(null)) });
    renderSection();
    const dialog = await openUse();
    await userEvent.type(within(dialog).getByLabelText(/Repository name/), "prg1-journal");
    await userEvent.click(within(dialog).getByRole("button", { name: "Branch and folder" }));
    await userEvent.type(within(dialog).getByLabelText("Branch"), "-x");
    await userEvent.type(within(dialog).getByLabelText("Folder"), "../etc");
    expect(within(dialog).getByText("Not a branch name.")).toBeVisible();
    expect(within(dialog).getByText("Not a folder of the repository.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Use this repository" })).toBeDisabled();
  });

  it("words a refusal from its code, and never the server's own text", async () => {
    let reply = fail(409, { error: "repo_not_found", message: "repo_not_found" });
    mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(null)),
      [`POST ${JOURNAL}/use`]: () => reply,
    });
    renderSection();
    const dialog = await openUse();
    await userEvent.type(within(dialog).getByLabelText(/Repository name/), "nowhere");
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this repository" }));
    expect(await within(dialog).findByText(/No repository by that name in the organization/)).toBeVisible();
    reply = fail(500, { message: "internal detail" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this repository" }));
    expect(await within(dialog).findByText("The server did not answer. Try again in a moment.")).toBeVisible();
    expect(within(dialog).queryByText("internal detail")).toBeNull();
  });

  it("opens the branch and folder on a refusal about them, in French too", async () => {
    mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(null)),
      [`POST ${JOURNAL}/use`]: fail(409, { error: "ref_not_found", message: "ref_not_found" }),
    });
    renderWithProviders(<JournalSettings room={makeClassroomDetail()} />, { locale: "fr" });
    await chooseGithub("Dans un dépôt GitHub");
    await userEvent.click(await screen.findByRole("button", { name: "Choisir…" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Nom du dépôt/), "prg1-journal");
    await userEvent.click(within(dialog).getByRole("button", { name: "Utiliser ce dépôt" }));
    expect(await within(dialog).findByText("Cette branche n'existe pas dans le dépôt.")).toBeVisible();
    expect(within(dialog).getByLabelText("Branche")).toBeVisible();
  });
});

describe("the Journal section — a journal", () => {
  it("shows the repository as a link to GitHub, its branch and folder, and where its copy stands", async () => {
    mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(repository({ ref: "dev", rootPath: "docs" }))),
    });
    renderSection();
    const root = await section();
    const link = within(root).getByRole("link", { name: /heig-tin-info\/prg1-journal/ });
    expect(link).toHaveAttribute("href", "https://github.com/heig-tin-info/prg1-journal");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(root).getByText(/In a GitHub repository · Branch dev, folder docs/)).toBeVisible();
    expect(within(root).getByText(/Synced/)).toBeVisible();
    expect(within(root).getByRole("img", { name: "OK" })).toBeVisible();
    expectNoAccent(root);
  });

  it("says why the last synchronisation failed, as a blocker", async () => {
    mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(repository({ syncStatus: "error", syncError: "forbidden" }))),
    });
    renderSection();
    const root = await section();
    expect(within(root).getByText("The journal could not be read from GitHub")).toBeVisible();
    expect(within(root).getByText(/The Quiz app may not read this repository\. Students still read the last copy\./)).toBeVisible();
    expect(within(root).getByRole("img", { name: "Blocking" })).toBeVisible();
  });

  it("is still shown, so it can be removed, once the classroom lost its link", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(plain), [`GET ${JOURNAL}`]: ok(staff(repository())) });
    renderSection();
    const root = await section();
    expect(within(root).getByRole("button", { name: /Remove…/ })).toBeVisible();
  });

  it("refreshes, and says Refreshing…", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(staff(repository())),
      [`POST ${JOURNAL}/refresh`]: { status: 202 },
    });
    renderSection();
    const root = await section();
    await userEvent.click(within(root).getByRole("button", { name: /Refresh/ }));
    expect(await within(root).findByText("Refreshing…")).toBeVisible();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`${JOURNAL}/refresh`]);
  });

  it("removes the journal after a confirmation that says the repository is kept", async () => {
    let attached = true;
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: () => ok(staff(attached ? repository() : null)),
      [`DELETE ${JOURNAL}`]: () => {
        attached = false;
        return noContent();
      },
    });
    renderSection();
    const root = await section();
    await userEvent.click(within(root).getByRole("button", { name: /Remove…/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove the journal of PRG1-2026?")).toBeVisible();
    expect(within(dialog).getByText(/heig-tin-info\/prg1-journal is kept on GitHub, unchanged/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove the journal" }));

    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText(/Journal removed\. heig-tin-info\/prg1-journal stays on GitHub\./)).toBeVisible();
    // Back to the choice: the classroom may now be disconnected (D28).
    expect(await within(root).findByText("Create a journal")).toBeVisible();
  });

  it("removes nothing when the confirmation is cancelled", async () => {
    const { calls } = mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`GET ${JOURNAL}`]: ok(staff(repository())) });
    renderSection();
    const root = await section();
    await userEvent.click(within(root).getByRole("button", { name: /Remove…/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("the Journal section — a Quiz-mode journal (ADR-057)", () => {
  it("shows its mode and its pages, nothing accented, no Refresh", async () => {
    mockFetch({ [`GET ${GITHUB}`]: ok(connected), [`GET ${JOURNAL}`]: ok(quizJournal(12)) });
    renderSection();
    const root = await section();
    expect(within(root).getByText("In Quiz")).toBeVisible();
    expect(within(root).getByText(/12 pages, written and kept in Quiz/)).toBeVisible();
    expect(within(root).queryByRole("button", { name: /Refresh/ })).toBeNull();
    expectNoAccent(root);
  });

  it("removes a journal holding pages only once the classroom's name is typed, and sends it", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(quizJournal(12)),
      [`DELETE ${JOURNAL}?confirm=PRG1-2026`]: noContent(),
    });
    renderSection();
    const root = await section();
    await userEvent.click(within(root).getByRole("button", { name: /Remove…/ }));
    const dialog = await screen.findByRole("dialog", { name: "Remove the journal of PRG1-2026?" });
    expect(within(dialog).getByText(/Its 12 pages and their history are deleted/)).toBeVisible();
    const confirm = within(dialog).getByRole("button", { name: "Remove the journal" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Type PRG1-2026 to confirm"), "PRG1-202");
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Type PRG1-2026 to confirm"), "6");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe(`${JOURNAL}?confirm=PRG1-2026`);
    expect(await screen.findByText("Journal deleted.")).toBeVisible();
  });

  it("asks for no name when the journal holds no page", async () => {
    const { calls } = mockFetch({
      [`GET ${GITHUB}`]: ok(connected),
      [`GET ${JOURNAL}`]: ok(quizJournal(0)),
      [`DELETE ${JOURNAL}`]: noContent(),
    });
    renderSection();
    const root = await section();
    await userEvent.click(within(root).getByRole("button", { name: /Remove…/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/The journal has no page/)).toBeVisible();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove the journal" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe(JOURNAL);
  });
});
