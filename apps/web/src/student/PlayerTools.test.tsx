import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { Me } from "@quiz/contracts";
import type { CalculatorMode, NavigationMode, NotepadMode } from "@quiz/domain";

import { MAX_PAGES, MAX_PAGE_LENGTH, notepadKey } from "../notepad/store";
import { meKey } from "../queryKeys";
import { makeMe } from "../test/fixtures";
import { fail, makeQueryClient, mockFetch, renderWithProviders } from "../test/render";
import { PlayerTools } from "./PlayerTools";

/*
 * The tools on the player (ADR-069, ADR-090): the calculator and the
 * notepad, one panel at a time, and the notepad's pages, storage, flush at a
 * checkpoint and blocked clipboard.
 */
const ATTEMPT = "att-np";
type Items = { milestone: boolean; markedDone: boolean }[];
const ITEMS: Items = [
  { milestone: false, markedDone: false },
  { milestone: true, markedDone: false },
  { milestone: false, markedDone: false },
];

function setup({
  calculator = "none",
  notepad = "provided",
  preview = false,
  navigation = "milestones",
  items = ITEMS,
  me = makeMe({ role: "student", session: { kind: "portal" } as Me["session"] }),
  attemptId = ATTEMPT,
}: {
  calculator?: CalculatorMode;
  notepad?: NotepadMode;
  preview?: boolean;
  navigation?: NavigationMode;
  items?: Items;
  /** `error`: `/me` failed. */
  me?: Me | "error";
  /** Another attempt: an ended one stays ended for the module's life. */
  attemptId?: string;
} = {}) {
  const user = userEvent.setup();
  const queryClient = makeQueryClient();
  if (me === "error") mockFetch({ "GET /app/api/me": fail(500, { error: "boom" }) });
  else queryClient.setQueryData(meKey, me);
  const tools = (list: Items) => (
    <PlayerTools
      calculator={calculator}
      notepad={notepad}
      attemptId={attemptId}
      preview={preview}
      navigation={navigation}
      items={list}
    />
  );
  const view = renderWithProviders(tools(items), { queryClient });
  return { user, rerender: (list: Items) => view.rerender(tools(list)) };
}

const stored = () => JSON.parse(localStorage.getItem(notepadKey(ATTEMPT)) ?? "null") as {
  pages: string[];
  page: number;
  checkpoint: number;
} | null;
// `hidden`: the panel is mounted while closed (`keepMounted`).
const page = () => screen.getByRole("textbox", { name: /^Page \d+ of \d+$/, hidden: true });
const openNotepad = async (user: ReturnType<typeof userEvent.setup>) =>
  // `find`: the notepad mounts once `/me` has settled.
  user.click(await screen.findByRole("button", { name: "Notepad" }));

describe("the dock group", () => {
  it("stacks both buttons and opens one panel at a time, each keeping its state", async () => {
    const { user } = setup({ calculator: "standard" });
    const notepadButton = screen.getByRole("button", { name: "Notepad" });
    expect(notepadButton.closest("[data-tool-dock]")).toHaveAttribute("data-tool-dock-slot", "1");
    expect(screen.getByRole("button", { name: "Calculator" }).closest("[data-tool-dock]")).toHaveAttribute(
      "data-tool-dock-slot",
      "0",
    );

    await openNotepad(user);
    expect(page()).toHaveFocus();
    await user.type(page(), "kept");
    await user.click(screen.getByRole("button", { name: "Calculator" }));
    expect(screen.getByRole("dialog", { name: "Calculator" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Notepad" }));
    expect(screen.getByRole("dialog", { name: "Notepad" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Calculator" })).toBeNull();
    expect(page()).toHaveValue("kept");
  });

  it("sits alone at the bottom without a calculator, and closes on Escape", async () => {
    const { user } = setup();
    expect(screen.getByRole("button", { name: "Notepad" }).closest("[data-tool-dock]")).toHaveAttribute(
      "data-tool-dock-slot",
      "0",
    );
    await openNotepad(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Notepad" })).toBeNull();
    expect(screen.getByRole("button", { name: "Notepad" })).toHaveFocus();
  });
});

describe("the notepad's pages", () => {
  it("adds, walks and counts pages, each holding its own text", async () => {
    const { user } = setup();
    await openNotepad(user);
    expect(page()).toHaveAttribute("maxLength", String(MAX_PAGE_LENGTH));
    await user.type(page(), "one");
    await user.click(screen.getByRole("button", { name: "New page" }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(page()).toHaveValue("");
    await user.type(page(), "two");
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(page()).toHaveValue("one");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(page()).toHaveValue("two");
    expect(stored()).toMatchObject({ pages: ["one", "two"], page: 1, checkpoint: -1 });
  });

  it("deletes a page without asking, and Undo puts it back", async () => {
    const { user } = setup();
    await openNotepad(user);
    await user.type(page(), "one");
    await user.click(screen.getByRole("button", { name: "New page" }));
    await user.type(page(), "two");
    await user.click(screen.getByRole("button", { name: "Delete page" }));
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    expect(page()).toHaveValue("one");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(page()).toHaveValue("two");
  });

  it("always keeps one page: deleting the last leaves it empty", async () => {
    const { user } = setup();
    await openNotepad(user);
    await user.type(page(), "only");
    await user.click(screen.getByRole("button", { name: "Delete page" }));
    expect(page()).toHaveValue("");
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(page()).toHaveValue("only");
  });

  it(`stops at ${MAX_PAGES} pages`, async () => {
    const { user } = setup();
    await openNotepad(user);
    for (let i = 1; i < MAX_PAGES; i++) await user.click(screen.getByRole("button", { name: "New page" }));
    expect(screen.getByText(`Page ${MAX_PAGES} of ${MAX_PAGES}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${MAX_PAGES} pages at most` })).toBeDisabled();
  });
});

describe("where the notes are kept", () => {
  it("finds the stored notes again on load", () => {
    localStorage.setItem(
      notepadKey(ATTEMPT),
      JSON.stringify({ pages: ["a", "b"], page: 1, checkpoint: -1, savedAt: Date.now() }),
    );
    setup();
    expect(page()).toHaveValue("b");
  });

  it("keeps the teacher's preview in memory only", async () => {
    const { user } = setup({ preview: true });
    await openNotepad(user);
    await user.type(page(), "draft");
    expect(page()).toHaveValue("draft");
    expect(localStorage.getItem(notepadKey(ATTEMPT))).toBeNull();
  });

  it("keeps an impersonation session in memory only (ADR-034)", async () => {
    const { user } = setup({ me: makeMe({ role: "student", session: { kind: "impersonation" } as Me["session"] }) });
    await openNotepad(user);
    await user.type(page(), "draft");
    expect(localStorage.getItem(notepadKey(ATTEMPT))).toBeNull();
  });

  it("never falls back to persisting when /me fails", async () => {
    const { user } = setup({ me: "error" });
    await openNotepad(user);
    await user.type(page(), "draft");
    expect(page()).toHaveValue("draft");
    expect(localStorage.getItem(notepadKey(ATTEMPT))).toBeNull();
  });

  it("does not write back the notes another tab removed at the attempt's end", async () => {
    const key = notepadKey("att-ended-elsewhere");
    const { user } = setup({ attemptId: "att-ended-elsewhere" });
    await openNotepad(user);
    await user.type(page(), "a");
    expect(localStorage.getItem(key)).not.toBeNull();
    localStorage.removeItem(key);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: null }));
    });
    await user.type(page(), "late");
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("follows another tab of the same attempt", async () => {
    setup();
    const next = JSON.stringify({ pages: ["from the other tab"], page: 0, checkpoint: -1, savedAt: Date.now() });
    localStorage.setItem(notepadKey(ATTEMPT), next);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: notepadKey(ATTEMPT), newValue: next }));
    });
    expect(page()).toHaveValue("from the other tab");
  });
});

describe("the flush at a checkpoint", () => {
  it("empties the notepad when the student crosses a checkpoint", async () => {
    const { user, rerender } = setup();
    await openNotepad(user);
    await user.type(page(), "before");
    await user.click(screen.getByRole("button", { name: "New page" }));
    rerender([ITEMS[0]!, { milestone: true, markedDone: true }, ITEMS[2]!]);
    expect(page()).toHaveValue("");
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
    expect(stored()).toMatchObject({ pages: [""], checkpoint: 1 });
  });

  it("drops notes stored under an earlier checkpoint on load", () => {
    localStorage.setItem(
      notepadKey(ATTEMPT),
      JSON.stringify({ pages: ["stale"], page: 0, checkpoint: -1, savedAt: Date.now() }),
    );
    setup({ items: [ITEMS[0]!, { milestone: true, markedDone: true }] });
    expect(page()).toHaveValue("");
  });

  it("never flushes outside checkpoint navigation", async () => {
    const { user, rerender } = setup({ navigation: "forward_only" });
    await openNotepad(user);
    await user.type(page(), "kept");
    rerender(ITEMS.map((item) => ({ ...item, markedDone: true })));
    expect(page()).toHaveValue("kept");
  });
});

describe("the clipboard", () => {
  const events = ["copy", "cut", "paste", "dragStart", "drop"] as const;

  it("is blocked in the notepad when the evaluation says so", async () => {
    const { user } = setup({ notepad: "provided_no_clipboard" });
    await openNotepad(user);
    expect(screen.getByText("No copy-paste")).toBeInTheDocument();
    for (const name of events) expect(fireEvent[name](page())).toBe(false);
    for (const inputType of [
      "insertFromPaste",
      "insertFromPasteAsQuotation",
      "insertFromDrop",
      "insertFromYank",
      "deleteByCut",
      "deleteByDrag",
    ]) {
      const event = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
      page().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    const typing = new InputEvent("beforeinput", { inputType: "insertText", bubbles: true, cancelable: true });
    page().dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
  });

  it("is free otherwise", async () => {
    const { user } = setup();
    await openNotepad(user);
    for (const name of events) expect(fireEvent[name](page())).toBe(true);
    const paste = new InputEvent("beforeinput", { inputType: "insertFromPaste", bubbles: true, cancelable: true });
    page().dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
  });
});
