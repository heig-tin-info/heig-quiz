import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

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

beforeEach(() => sessionStorage.clear());

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
    await userEvent.type(within(panel).getByRole("textbox"), "What is the Group option for?{Enter}");
    expect(await within(panel).findByText("category")).toBeVisible();
    const sent = calls.find((c) => c.method === "POST");
    expect(sent?.body).toEqual({
      message: "What is the Group option for?",
      context: { route: "/pools/:id", helpTopic: "pool", locale: "en" },
    });
    expect(JSON.stringify(sent?.body)).not.toContain(POOL);
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
      "POST /app/api/assist/ask": ok({ conversationId: NEW, exchange: exchange("e2", "Again?", "Yes.") }),
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
          : ok({ conversationId: NEW, exchange: exchange("e3", "Still there?", "A new one.") }),
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
