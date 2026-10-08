import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Eye } from "lucide-react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLeaveGuard, useRoute } from "../router";
import { useScreenCommands, type ScreenCommand } from "../screenCommands";
import { makeMe } from "../test/fixtures";
import { fail, mockFetch, noContent, ok, renderWithProviders } from "../test/render";
import { PageHeader } from "../ui";
import { AssistDock } from "./AssistDock";

const CID = "6f0c3a8e-2b1d-4c5e-9f7a-1b2c3d4e5f60";
const NEW = "7a1d4b9f-3c2e-4d6f-8a0b-2c3d4e5f6071";
const POOL = "0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d";
const at = new Date().toISOString();
const exchange = (id: string, question: string, answer: string) => ({ id, question, answer, createdAt: at });
const AVAILABLE = { "GET /app/api/assist/availability": ok({ available: true, stub: false }) };
const OPEN = { name: "Ask the help assistant" };

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("the assistant's button (ADR-080 §3)", () => {
  it("is on a teacher screen when the assistant answers, in the neutral ink", async () => {
    mockFetch(AVAILABLE);
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "pool", id: POOL }} teacherUi />);
    const button = await screen.findByRole("button", OPEN);
    expect(button.className).not.toContain("accent");
  });

  it("is absent when no model nor stub answers", async () => {
    const { calls } = mockFetch({ "GET /app/api/assist/availability": ok({ available: false, stub: false }) });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByRole("button", OPEN)).toBeNull();
  });

  it("is absent, and asks nothing, in the student view, under impersonation and on a projection", () => {
    const { calls } = mockFetch(AVAILABLE);
    const session = { kind: "impersonation", evaluationId: null, projectId: null, readOnly: true, superPowersUntil: null, superPowersAvailable: false } as const;
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi={false} />);
    renderWithProviders(<AssistDock me={makeMe({ session })} route={{ view: "home" }} teacherUi />);
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "poll", id: POOL }} teacherUi />);
    renderWithProviders(<AssistDock me={makeMe({ role: "student" })} route={{ view: "home" }} teacherUi />);
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("button", OPEN)).toBeNull();
  });
});

describe("the chat", () => {
  it("sends the route pattern, the help topic of the page's help button and the language, and shows the answer", async () => {
    const { calls } = mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": ok({
        conversationId: CID,
        exchange: exchange("e1", "What is the Group option for?", "It groups the rows by **category**."),
        actions: [],
      }),
    });
    renderWithProviders(
      <>
        <PageHeader title="Pool" help="pool" />
        <AssistDock me={makeMe()} route={{ view: "pool", id: POOL }} teacherUi />
      </>,
    );
    await userEvent.click(await screen.findByRole("button", OPEN));
    const panel = screen.getByRole("dialog", { name: "Help assistant" });
    expect(within(panel).getByText(/kept 30 days/)).toBeVisible();
    // The notice of ADR-080 P2, item 4: what is read and who reads it.
    expect(within(panel).getByText(/students' names and results included, and sends it to Anthropic/)).toBeVisible();
    await userEvent.type(within(panel).getByRole("textbox"), "What is the Group option for?{Enter}");
    expect(await within(panel).findByText("category")).toBeVisible();
    const sent = calls.find((c) => c.method === "POST");
    expect(sent?.body).toEqual({
      message: "What is the Group option for?",
      // The pattern carries no id; the pool's id rides as an entity of the closed list (ADR-080 P2).
      context: { route: "/pools/:id", helpTopic: "pool", locale: "en", entities: { pool: POOL } },
    });
    expect(sessionStorage.getItem("quiz-assist-conversation")).toBe(CID);
  });

  it("says why it could not answer, and Escape closes it back to the button", async () => {
    mockFetch({ ...AVAILABLE, "POST /app/api/assist/ask": fail(429, { error: "llm_budget_exhausted" }) });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    const button = await screen.findByRole("button", OPEN);
    await userEvent.click(button);
    await userEvent.type(screen.getByRole("textbox"), "Hello{Enter}");
    expect(await screen.findByText("Today's AI spending cap is reached. Try again tomorrow.")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("forgets a conversation that is gone, and the next question starts a new one", async () => {
    sessionStorage.setItem("quiz-assist-conversation", CID);
    const { calls } = mockFetch({
      ...AVAILABLE,
      [`GET /app/api/assist/conversations/${CID}`]: fail(404, { error: "not_found" }),
      "POST /app/api/assist/ask": ok({ conversationId: NEW, exchange: exchange("e2", "Again?", "Yes."), actions: [] }),
    });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    await userEvent.click(await screen.findByRole("button", OPEN));
    await waitFor(() => expect(sessionStorage.getItem("quiz-assist-conversation")).toBeNull());
    await userEvent.type(screen.getByRole("textbox"), "Again?{Enter}");
    expect(await screen.findByText("Yes.")).toBeVisible();
    expect((calls.find((c) => c.method === "POST")?.body as { conversationId?: string }).conversationId).toBeUndefined();
  });

  it("asks again in a new conversation when the one it named was purged meanwhile", async () => {
    sessionStorage.setItem("quiz-assist-conversation", CID);
    const { calls } = mockFetch({
      ...AVAILABLE,
      [`GET /app/api/assist/conversations/${CID}`]: ok({ id: CID, createdAt: at, updatedAt: at, exchanges: [] }),
      "POST /app/api/assist/ask": (call) =>
        (call.body as { conversationId?: string }).conversationId
          ? fail(404, { error: "conversation_not_found" })
          : ok({ conversationId: NEW, exchange: exchange("e3", "Still there?", "A new one."), actions: [] }),
    });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    await userEvent.click(await screen.findByRole("button", OPEN));
    await userEvent.type(screen.getByRole("textbox"), "Still there?{Enter}");
    expect(await screen.findByText("A new one.")).toBeVisible();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(sessionStorage.getItem("quiz-assist-conversation")).toBe(NEW);
  });

  it("lists the past conversations and deletes one after a confirmation", async () => {
    sessionStorage.setItem("quiz-assist-conversation", CID);
    const { calls } = mockFetch({
      ...AVAILABLE,
      [`GET /app/api/assist/conversations/${CID}`]: ok({
        id: CID,
        createdAt: at,
        updatedAt: at,
        exchanges: [exchange("e1", "Old question", "Old answer")],
      }),
      "GET /app/api/assist/conversations": ok([{ id: CID, createdAt: at, updatedAt: at, preview: "Old question" }]),
      [`DELETE /app/api/assist/conversations/${CID}`]: noContent(),
    });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    await userEvent.click(await screen.findByRole("button", OPEN));
    expect(await screen.findByText("Old answer")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Past conversations" }));
    expect(await screen.findByText("Old question")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this conversation?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(sessionStorage.getItem("quiz-assist-conversation")).toBeNull());
  });
});

/** The dock on the app's own router, as `App.tsx` mounts it, beside the screen `children`. */
function WithRouter({ children }: { children?: ReactNode }) {
  const [route, navigate] = useRoute();
  return (
    <>
      {children}
      <span data-testid="view">{route.view}</span>
      <AssistDock me={makeMe()} route={route} teacherUi navigate={navigate} />
    </>
  );
}

function Commands({ commands }: { commands: ScreenCommand[] }) {
  useScreenCommands(commands);
  return null;
}

function Dirty({ ask }: { ask: () => Promise<boolean> }) {
  useLeaveGuard(true, ask);
  return null;
}

/** The model's answer, with its UI actions (ADR-080 P2b). */
const replying = (actions: unknown[]) =>
  ok({ conversationId: CID, exchange: exchange("e9", "Montre-moi Sandbox", "C'est ouvert."), actions });
const OPEN_POOL = { kind: "open_screen", screen: "pool", ids: { id: POOL }, params: { q: "tag:printf" } };

async function askInDock(question: string) {
  await userEvent.click(await screen.findByRole("button", OPEN));
  const panel = screen.getByRole("dialog", { name: "Help assistant" });
  await userEvent.type(within(panel).getByRole("textbox"), `${question}{Enter}`);
  await within(panel).findByText("C'est ouvert.");
  return panel;
}

describe("the assistant drives the interface (ADR-080 P2b)", () => {
  it("opens the screen the answer names, searched, says so, and stays open across the navigation", async () => {
    mockFetch({ ...AVAILABLE, "POST /app/api/assist/ask": replying([OPEN_POOL]) });
    renderWithProviders(<WithRouter />);
    const panel = await askInDock("Montre-moi les printf de Sandbox");
    await waitFor(() => expect(window.location.pathname).toBe(`/pools/${POOL}`));
    expect(new URLSearchParams(window.location.search).get("q")).toBe("tag:printf");
    expect(screen.getByTestId("view")).toHaveTextContent("pool");
    expect(await within(panel).findByText("Opened: Question pool")).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Help assistant" })).toBe(panel);
  });

  it("opens a classroom on its tab", async () => {
    mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([{ kind: "open_screen", screen: "classroom", ids: { id: POOL }, params: { tab: "roster" } }]),
    });
    renderWithProviders(<WithRouter />);
    await askInDock("The roster");
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(`/classrooms/${POOL}?tab=roster`));
  });

  it("does nothing but say so for a screen off the catalogue, ids that are not a segment, or an unknown param", async () => {
    mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([
        { kind: "open_screen", screen: "attempt", ids: { evaluationId: POOL }, params: {} },
        { kind: "open_screen", screen: "pool", ids: { id: "../admin" }, params: {} },
        { kind: "open_screen", screen: "pool", ids: { id: POOL }, params: { evil: "1" } },
        { kind: "open_screen", screen: "constructor", ids: {}, params: {} },
      ]),
    });
    renderWithProviders(<WithRouter />);
    const panel = await askInDock("Open it");
    expect(await within(panel).findAllByText("Could not open this screen.")).toHaveLength(4);
    expect(window.location.pathname).toBe("/");
  });

  it("runs an effect-free command of the screen, re-checked when it runs; never one that writes", async () => {
    const tryIt = vi.fn();
    const publish = vi.fn();
    const commands: ScreenCommand[] = [
      { id: "question:try", label: "Try it", icon: Eye, group: "action", effect: "none", run: tryIt },
      { id: "question:publish", label: "Publish this question", icon: Eye, group: "action", effect: "write", run: publish },
    ];
    const { calls } = mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([
        { kind: "run_command", id: "question:try" },
        { kind: "run_command", id: "question:publish" },
        { kind: "run_command", id: "question:gone" },
      ]),
    });
    renderWithProviders(
      <WithRouter>
        <Commands commands={commands} />
      </WithRouter>,
    );
    const panel = await askInDock("Try it");
    expect(await within(panel).findByText("Done: Try it")).toBeVisible();
    expect(tryIt).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(within(panel).getAllByText("This command is no longer available here.")).toHaveLength(2);
    // The screen's commands ride with the question, each with its effect; the server offers the `none` ones.
    expect((calls.find((c) => c.method === "POST")?.body as { context: { commands: unknown } }).context.commands).toEqual([
      { id: "question:try", label: "Try it", effect: "none" },
      { id: "question:publish", label: "Publish this question", effect: "write" },
    ]);
  });

  it("offers a command that needs a real gesture (a new tab) as a button, run on the teacher's click", async () => {
    const preview = vi.fn();
    const commands: ScreenCommand[] = [
      { id: "question:preview", label: "Preview", icon: Eye, group: "action", effect: "none", gesture: true, run: preview },
    ];
    mockFetch({ ...AVAILABLE, "POST /app/api/assist/ask": replying([{ kind: "run_command", id: "question:preview" }]) });
    renderWithProviders(
      <WithRouter>
        <Commands commands={commands} />
      </WithRouter>,
    );
    const panel = await askInDock("Preview it");
    const button = await within(panel).findByRole("button", { name: "Preview" });
    expect(preview).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("asks before leaving unsaved work, and stays when the teacher says no", async () => {
    const ask = vi.fn(() => Promise.resolve(false));
    mockFetch({ ...AVAILABLE, "POST /app/api/assist/ask": replying([OPEN_POOL]) });
    renderWithProviders(
      <WithRouter>
        <Dirty ask={ask} />
      </WithRouter>,
    );
    const panel = await askInDock("Montre-moi Sandbox");
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(await within(panel).findByText("Stayed on this screen.")).toBeVisible();
    expect(within(panel).queryByText(/^Opened/)).toBeNull();
    expect(window.location.pathname).toBe("/");
  });
});
