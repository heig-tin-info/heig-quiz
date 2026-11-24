import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProvidedDocument } from "@quiz/contracts";

import type { DocumentViewerProps } from "../documents/DocumentViewer";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { viewport } from "../test/viewport";
import {
  attemptDocumentRoutes,
  courseDocumentRoutes,
  DocumentsPanel,
  PANEL_MIN,
  type PlayerDocuments,
} from "./DocumentsPanel";
import { documentsKey, endDocumentStates, loadPanel, purgeAllDocumentStates } from "./documentsStore";

/*
 * ADR-144 §7: the player's documents panel, the viewer mocked — what it was
 * given, its handle, the reading state it reports and a load that fails.
 */

const viewers = vi.hoisted(() => ({
  props: new Map<string, DocumentViewerProps>(),
  focusSearch: vi.fn(),
  focusDocument: vi.fn(),
}));

vi.mock("../documents/DocumentViewer", () => ({
  DocumentViewer: (props: DocumentViewerProps) => {
    viewers.props.set(props.title, props);
    useImperativeHandle(props.ref, () => ({
      focusSearch: viewers.focusSearch,
      focusDocument: viewers.focusDocument,
      state: () => ({ kind: "pdf", location: null, scale: "page-width", query: "", outline: false }),
    }));
    return (
      <div data-testid={`viewer:${props.title}`} data-active={String(props.active !== false)}>
        {props.source.kind === "pdf" ? props.source.url : props.source.html}
      </div>
    );
  },
}));

const ATTEMPT = "a0000000-0000-4000-8000-000000000001";
const PDF: ProvidedDocument = { id: "d0000000-0000-4000-8000-000000000001", title: "Datasheet", kind: "pdf" };
const MD: ProvidedDocument = { id: "d0000000-0000-4000-8000-000000000002", title: "Formulaire", kind: "markdown" };
const narrow = window.matchMedia;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  viewport(width);
}

const docs = (over: Partial<PlayerDocuments> = {}): PlayerDocuments => ({
  list: [PDF, MD],
  routes: attemptDocumentRoutes(ATTEMPT),
  ...over,
});

function world(extra: Record<string, ReturnType<typeof ok>> = {}) {
  return mockFetch({
    "GET /app/api/me": ok({ id: "u1", email: "s@x", givenName: "S", familyName: "T", role: "student", session: { kind: "portal" } }),
    [`GET /app/api/attempts/${ATTEMPT}/documents/${MD.id}/html`]: ok({ html: "<p>MD</p>", toc: [] }),
    ...extra,
  });
}

function renderPanel(props: Partial<Parameters<typeof DocumentsPanel>[0]> = {}) {
  return renderWithProviders(
    <DocumentsPanel attemptId={ATTEMPT} documents={docs()} persist hidden={false} slot={0} offset="0px" {...props} />,
  );
}

const openPanel = async () => userEvent.click(screen.getByRole("button", { name: "Documents" }));
const panel = () => screen.getByRole("region", { name: "Documents" });

beforeEach(() => {
  viewers.props.clear();
  viewers.focusSearch.mockClear();
  setWidth(1440);
});
afterEach(() => {
  vi.stubGlobal("matchMedia", narrow);
  document.documentElement.style.removeProperty("--tool-dock-inset");
  document.documentElement.style.removeProperty("--tool-dock-inset");
});

describe("the documents panel (ADR-144 §7)", () => {
  it("offers its button only while the attempt may read: a list, no pause", () => {
    world();
    const { rerender } = renderPanel({ documents: docs({ list: [] }) });
    expect(screen.queryByRole("button", { name: "Documents" })).toBeNull();
    rerender(<DocumentsPanel attemptId={ATTEMPT} documents={docs()} persist hidden slot={0} offset="0px" />);
    expect(screen.queryByRole("button", { name: "Documents" })).toBeNull();
    rerender(<DocumentsPanel attemptId={ATTEMPT} documents={docs()} persist hidden={false} slot={2} offset="0px" />);
    const button = screen.getByRole("button", { name: "Documents" });
    expect(button.closest("[data-tool-dock-slot]")).toHaveAttribute("data-tool-dock-slot", "2");
  });

  it("opens beside the questions, reads the attempt's routes, switches tabs and closes back to its button", async () => {
    world();
    renderPanel();
    await openPanel();
    expect(panel()).toHaveAttribute("data-docs-split");
    expect(document.documentElement.style.getPropertyValue("--tool-dock-inset")).toBe(`${Math.round(1440 * 0.46)}px`);
    expect(screen.getByTestId("viewer:Datasheet")).toHaveTextContent(`/app/api/attempts/${ATTEMPT}/documents/${PDF.id}/file`);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Datasheet", "Formulaire"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.click(tabs[1]!);
    expect(await screen.findByTestId("viewer:Formulaire")).toHaveTextContent("<p>MD</p>");
    // The first stays mounted, hidden in place.
    expect(screen.getByTestId("viewer:Datasheet")).toHaveAttribute("data-active", "false");
    tabs[1]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(panel()).getByRole("button", { name: "Close the documents" }));
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
    expect(screen.queryByTestId("viewer:Datasheet")).toBeNull();
    expect(screen.getByRole("button", { name: "Documents" })).toHaveFocus();
    expect(document.documentElement.style.getPropertyValue("--tool-dock-inset")).toBe("");
  });

  it("moves its separator with the keyboard and a double click, within its bounds", async () => {
    world();
    renderPanel();
    await openPanel();
    const separator = screen.getByRole("separator", { name: "Width of the documents" });
    const now = () => Number(separator.getAttribute("aria-valuenow"));
    const start = now();
    separator.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(now()).toBe(start + 16);
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(now()).toBe(start + 16 - 64);
    await userEvent.keyboard("{Home}");
    expect(now()).toBe(1440 - 420);
    await userEvent.keyboard("{End}");
    expect(now()).toBe(PANEL_MIN);
    fireEvent.doubleClick(separator);
    expect(now()).toBe(Math.round(1440 * 0.46));
  });

  it("goes full screen on the same viewer, with one way back, and Escape leaves it", async () => {
    world();
    renderPanel();
    await openPanel();
    const viewer = screen.getByTestId("viewer:Datasheet");
    await userEvent.click(within(panel()).getByRole("button", { name: "Full screen" }));
    const dialog = screen.getByRole("dialog", { name: "Documents" });
    expect(within(dialog).getByRole("button", { name: "Back to the questions" })).toBeInTheDocument();
    expect(screen.getByTestId("viewer:Datasheet")).toBe(viewer);
    expect(screen.queryByRole("separator")).toBeNull();
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panel()).toHaveAttribute("data-docs-split");
    // A key the viewer took (its search) never reaches the panel.
    await userEvent.click(within(panel()).getByRole("button", { name: "Full screen" }));
    const prevented = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    prevented.preventDefault();
    act(() => void screen.getByTestId("viewer:Datasheet").dispatchEvent(prevented));
    expect(screen.getByRole("dialog", { name: "Documents" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to the questions" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("takes Ctrl+F and ⌘+F to the search of the document on screen while it is open", async () => {
    world();
    renderPanel();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(viewers.focusSearch).not.toHaveBeenCalled();
    await openPanel();
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "F", metaKey: true });
    expect(viewers.focusSearch).toHaveBeenCalledTimes(2);
  });

  it("is an overlay under 900 px, which Escape puts away", async () => {
    setWidth(600);
    world();
    renderPanel();
    await openPanel();
    expect(panel()).not.toHaveAttribute("data-docs-split");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--tool-dock-inset")).toBe("");
    fireEvent.keyDown(screen.getByTestId("viewer:Datasheet"), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Documents" })).toBeNull();
  });

  it("keeps each document's state and the panel's per attempt, and gives it back after a remount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      world();
      const first = renderPanel();
      await openPanel();
      const state = { kind: "pdf", location: { pageNumber: 3, top: 10, left: 0 }, scale: 1.5, query: "Ω", outline: true };
      act(() => viewers.props.get("Datasheet")!.onStateChange!(state as never));
      await act(async () => void vi.advanceTimersByTime(300));
      const stored = JSON.parse(sessionStorage.getItem(documentsKey(ATTEMPT))!);
      expect(stored).toMatchObject({ open: true, active: null, docs: { [PDF.id]: state } });
      first.unmount();
      viewers.props.clear();
      renderPanel();
      // Open again on reload, the viewer given what it reported.
      expect(await screen.findByTestId("viewer:Datasheet")).toBeInTheDocument();
      expect(viewers.props.get("Datasheet")!.initialState).toEqual(state);
      // Gone with the attempt, and at sign-out.
      endDocumentStates(ATTEMPT);
      expect(sessionStorage.getItem(documentsKey(ATTEMPT))).toBeNull();
      sessionStorage.setItem(documentsKey("other"), "{}");
      sessionStorage.setItem("unrelated", "1");
      purgeAllDocumentStates();
      expect(sessionStorage.getItem(documentsKey("other"))).toBeNull();
      expect(sessionStorage.getItem("unrelated")).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps it in memory only where it must not persist (the preview, an impersonation)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      world();
      renderPanel({ attemptId: "b0000000-0000-4000-8000-000000000002", documents: docs(), persist: false });
      await openPanel();
      await act(async () => void vi.advanceTimersByTime(300));
      expect(sessionStorage.getItem(documentsKey("b0000000-0000-4000-8000-000000000002"))).toBeNull();
      expect(loadPanel("b0000000-0000-4000-8000-000000000002", false).open).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a document a route answers 404 for, asks the attempt view again, and follows the list it gets", async () => {
    const onGone = vi.fn();
    world();
    const { rerender } = renderPanel({ documents: docs({ onGone }) });
    await openPanel();
    act(() => viewers.props.get("Datasheet")!.onLoadError!({ name: "ResponseException", status: 404 }));
    expect(onGone).toHaveBeenCalledTimes(1);
    // The document's own tab says so; its viewer and its bytes are gone, the other document is still there.
    expect(screen.getByText("This document is not available.")).toBeInTheDocument();
    expect(screen.queryByTestId("viewer:Datasheet")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Formulaire" }));
    expect(await screen.findByTestId("viewer:Formulaire")).toBeInTheDocument();
    // Another failure is the viewer's to retry.
    act(() => viewers.props.get("Formulaire")!.onLoadError?.(new Error("network")));
    expect(screen.getByTestId("viewer:Formulaire")).toBeInTheDocument();
    // The list read again no longer holds it: its tab goes; an empty one hides the panel.
    const panelProps = { attemptId: ATTEMPT, persist: true, hidden: false, slot: 0, offset: "0px" };
    rerender(<DocumentsPanel {...panelProps} documents={docs({ onGone, list: [MD] })} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Formulaire"]);
    rerender(<DocumentsPanel {...panelProps} documents={docs({ onGone, list: [] })} />);
    expect(screen.queryByRole("button", { name: "Documents" })).toBeNull();
  });

  it("keeps the panel and the other documents when the list still holds the missing one (a missing file)", async () => {
    const onGone = vi.fn();
    world();
    const { rerender } = renderPanel({ documents: docs({ onGone }) });
    await openPanel();
    act(() => viewers.props.get("Datasheet")!.onLoadError!({ name: "ResponseException", status: 404 }));
    rerender(
      <DocumentsPanel attemptId={ATTEMPT} documents={docs({ onGone, list: [PDF, MD] })} persist hidden={false} slot={0} offset="0px" />,
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByText("This document is not available.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Formulaire" }));
    expect(await screen.findByTestId("viewer:Formulaire")).toHaveTextContent("<p>MD</p>");
  });

  it("marks a Markdown document's 404 too", async () => {
    const onGone = vi.fn();
    mockFetch({
      [`GET /app/api/attempts/${ATTEMPT}/documents/${MD.id}/html`]: fail(404, { error: "not_found" }),
    });
    renderPanel({ documents: docs({ onGone, list: [MD] }) });
    await openPanel();
    await waitFor(() => expect(onGone).toHaveBeenCalled());
    expect(await screen.findByText("This document is not available.")).toBeInTheDocument();
  });

  it("reads the course's staff routes in the teacher's stateless preview", async () => {
    mockFetch({ [`GET /app/api/courses/c1/documents/${MD.id}/html`]: ok({ html: "<p>STAFF</p>", toc: [] }) });
    renderPanel({ documents: docs({ routes: courseDocumentRoutes("c1") }), persist: false });
    await openPanel();
    expect(screen.getByTestId("viewer:Datasheet")).toHaveTextContent(`/app/api/courses/c1/documents/${PDF.id}/file`);
    await userEvent.click(screen.getAllByRole("tab")[1]!);
    expect(await screen.findByTestId("viewer:Formulaire")).toHaveTextContent("<p>STAFF</p>");
  });
});
