import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Eye } from "lucide-react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Draft } from "../question/useQuestionDraft";
import { useScreenCommands, type ScreenCommand } from "../screenCommands";
import { makeMe } from "../test/fixtures";
import { mockFetch, noContent, ok, renderWithProviders, fail } from "../test/render";
import { AssistDock } from "./AssistDock";
import { editorSlot, useAssistEditor } from "./editor";

const CID = "6f0c3a8e-2b1d-4c5e-9f7a-1b2c3d4e5f60";
const Q = "0b6f6a52-6c7e-4a0d-9e8e-3a3f1e2b4c5d";
const W = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const at = new Date().toISOString();
const AVAILABLE = { "GET /app/api/assist/availability": ok({ available: true, stub: false }) };
const BASE = { config: { prompt: "quelle valeur ?", choices: [{ text: "4", correct: true }] }, explanation: "" };
const EDIT = {
  kind: "edit_question",
  questionId: Q,
  base: BASE,
  config: { prompt: "Quelle valeur ?", choices: [{ text: "4", correct: true }] },
  explanation: "",
  fields: [{ path: "prompt", label: "statement", n: null, before: "quelle valeur ?", after: "Quelle valeur ?" }],
};
const replying = (actions: unknown[]) =>
  ok({ conversationId: CID, exchange: { id: "e1", question: "?", answer: "Voici ma proposition.", createdAt: at }, actions });

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** A question editor reduced to its draft, registered in the assistant's slot as `QuestionEditor` does. */
function Editor({ flush, edits }: { flush: () => Promise<boolean>; edits: { count: number } }) {
  const [draft, setDraft] = useState<Draft | null>({ ...BASE, variables: null });
  const set = (next: Draft) => {
    edits.count += 1;
    setDraft(next);
  };
  useAssistEditor(editorSlot({ questionId: Q, draft, readOnly: false, setDraft: set, flush }));
  return (
    <>
      <p data-testid="prompt">{(draft?.config as { prompt: string }).prompt}</p>
      <button type="button" onClick={() => set({ ...draft!, config: { ...(draft!.config as object), prompt: "typed" } })}>
        type
      </button>
    </>
  );
}

function Commands({ commands }: { commands: ScreenCommand[] }) {
  useScreenCommands(commands);
  return null;
}

async function ask(question: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Ask the help assistant" }));
  const panel = screen.getByRole("dialog", { name: "Help assistant" });
  await userEvent.type(within(panel).getByRole("textbox"), `${question}{Enter}`);
  await within(panel).findByText("Voici ma proposition.");
  return panel;
}

describe("an editor proposal (ADR-080 P3, decisions 1–2)", () => {
  it("flushes the autosave, sends the draft, shows the diff, and applies it as ONE edit with an Undo", async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push("flush");
      return true;
    });
    const edits = { count: 0 };
    const { calls } = mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": (call) => {
        order.push("ask");
        expect((call.body as { editor: unknown }).editor).toEqual({ questionId: Q, ...BASE });
        return replying([EDIT]);
      },
    });
    renderWithProviders(
      <>
        <Editor flush={flush} edits={edits} />
        <AssistDock me={makeMe()} route={{ view: "question", id: Q }} teacherUi />
      </>,
    );
    const panel = await ask("Reformule l'énoncé");
    expect(order).toEqual(["flush", "ask"]);
    const card = within(panel).getByRole("region", { name: "Proposed edit of the draft" });
    expect(within(card).getByText("Statement")).toBeVisible();
    expect(within(card).getByText("quelle valeur ?")).toBeVisible();
    expect(within(card).getByText("Quelle valeur ?")).toBeVisible();
    // Nothing changes before Apply.
    expect(screen.getByTestId("prompt")).toHaveTextContent("quelle valeur ?");
    await userEvent.click(within(card).getByRole("button", { name: "Apply to the draft" }));
    expect(screen.getByTestId("prompt")).toHaveTextContent("Quelle valeur ?");
    expect(edits.count).toBe(1);
    expect(within(card).getByText("Applied to the draft: it is saved, not published.")).toBeVisible();
    await userEvent.click(within(card).getByRole("button", { name: "Undo" }));
    expect(screen.getByTestId("prompt")).toHaveTextContent("quelle valeur ?");
    expect(edits.count).toBe(2);
    // No write left the browser: the autosave of the real editor stores the draft.
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual(["/app/api/assist/ask"]);
  });

  it("drops a proposal whose base the draft no longer is", async () => {
    const edits = { count: 0 };
    mockFetch({ ...AVAILABLE, "POST /app/api/assist/ask": replying([EDIT]) });
    renderWithProviders(
      <>
        <Editor flush={() => Promise.resolve(true)} edits={edits} />
        <AssistDock me={makeMe()} route={{ view: "question", id: Q }} teacherUi />
      </>,
    );
    const panel = await ask("Reformule");
    await userEvent.click(screen.getByRole("button", { name: "type" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Apply to the draft" }));
    expect(await within(panel).findByText(/no longer applies/)).toBeVisible();
    expect(screen.getByTestId("prompt")).toHaveTextContent("typed");
    expect(edits.count).toBe(1);
  });

  it("sends no draft from another screen", async () => {
    const { calls } = mockFetch({ ...AVAILABLE, "POST /app/api/assist/ask": replying([]) });
    renderWithProviders(
      <>
        <Editor flush={() => Promise.resolve(true)} edits={{ count: 0 }} />
        <AssistDock me={makeMe()} route={{ view: "pool", id: Q }} teacherUi />
      </>,
    );
    await ask("Hello");
    expect(calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("editor");
  });
});

describe("a prepared write (ADR-080 P3, decision 7)", () => {
  const WRITE = {
    kind: "pending_write",
    id: W,
    tool: "link_pool_to_course",
    lines: [
      { field: "course", values: ["Programmation 1"] },
      { field: "pool", values: ["Sandbox"] },
      { field: "access", values: ["Ada Lovelace", "Alan Turing"] },
    ],
    expiresAt: at,
  };

  it("shows the server's card and runs only on Confirm, then links to the result", async () => {
    const { calls } = mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([WRITE]),
      [`POST /app/api/assist/writes/${W}/confirm`]: ok({ path: `/courses/${Q}/pools` }),
    });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi navigate={vi.fn()} />);
    const panel = await ask("Lie la banque");
    const card = within(panel).getByRole("region", { name: "Link a pool to a course" });
    expect(within(card).getByText("Gains access")).toBeVisible();
    expect(within(card).getByText("Alan Turing")).toBeVisible();
    expect(within(card).getByText("The course's whole staff becomes contributor of this pool.")).toBeVisible();
    expect(within(card).getByText("Nothing is written until you confirm.")).toBeVisible();
    expect(calls.some((c) => c.url.includes("/writes/"))).toBe(false);
    await userEvent.click(within(card).getByRole("button", { name: "Confirm" }));
    expect(await within(card).findByText("Done.")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Open it" })).toBeVisible();
    expect(calls.find((c) => c.url.endsWith("/confirm"))?.body).toEqual({ conversationId: CID });
  });

  it("cancels: forgotten on the server, nothing run", async () => {
    const { calls } = mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([WRITE]),
      [`POST /app/api/assist/writes/${W}/cancel`]: noContent(),
    });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    const panel = await ask("Lie la banque");
    await userEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(await within(panel).findByText("Cancelled: nothing was done.")).toBeVisible();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/cancel"))).toBe(true));
    expect(calls.some((c) => c.url.endsWith("/confirm"))).toBe(false);
  });

  it("says when the write expired or was already used", async () => {
    mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([WRITE]),
      [`POST /app/api/assist/writes/${W}/confirm`]: fail(404, { error: "write_not_found" }),
    });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    const panel = await ask("Lie la banque");
    await userEvent.click(within(panel).getByRole("button", { name: "Confirm" }));
    expect(await within(panel).findByText("This proposal expired or was already used: ask again.")).toBeVisible();
  });

  it("words a refused write in the UI language, never the route's text", async () => {
    mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([WRITE]),
      [`POST /app/api/assist/writes/${W}/confirm`]: fail(422, { error: "write_failed", reason: "refused" }),
    });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    const panel = await ask("Lie la banque");
    await userEvent.click(within(panel).getByRole("button", { name: "Confirm" }));
    expect(await within(panel).findByText("Not done: the platform refused it (your role does not allow it).")).toBeVisible();
  });
});

describe("a write command of the screen (ADR-080 P3, decision 5)", () => {
  it("never runs before Confirm, nor after Cancel; runs once on Confirm while the screen still offers it", async () => {
    const publish = vi.fn();
    const commands: ScreenCommand[] = [
      { id: "question:publish", label: "Publish this question", icon: Eye, group: "action", effect: "write", run: publish },
    ];
    mockFetch({
      ...AVAILABLE,
      "POST /app/api/assist/ask": replying([
        { kind: "confirm_command", id: "question:publish", label: "Publish this question" },
        { kind: "confirm_command", id: "question:publish", label: "Publish this question" },
      ]),
    });
    renderWithProviders(
      <>
        <Commands commands={commands} />
        <AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />
      </>,
    );
    const panel = await ask("Publie-la");
    const cards = within(panel).getAllByRole("region", { name: "Run this command?" });
    expect(publish).not.toHaveBeenCalled();
    await userEvent.click(within(cards[0]!).getByRole("button", { name: "Cancel" }));
    expect(publish).not.toHaveBeenCalled();
    expect(within(cards[0]!).getByText("Cancelled: nothing was done.")).toBeVisible();
    await userEvent.click(within(cards[1]!).getByRole("button", { name: "Confirm" }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(within(cards[1]!).getByText("Done: Publish this question")).toBeVisible();
  });

  it("says so, and runs nothing, when the screen no longer offers the command", async () => {
    mockFetch({ ...AVAILABLE, "POST /app/api/assist/ask": replying([{ kind: "confirm_command", id: "live:close", label: "Close" }]) });
    renderWithProviders(<AssistDock me={makeMe()} route={{ view: "home" }} teacherUi />);
    const panel = await ask("Ferme");
    await userEvent.click(within(panel).getByRole("button", { name: "Confirm" }));
    expect(within(panel).getByText("This command is no longer available here.")).toBeVisible();
  });
});
