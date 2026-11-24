import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { DocumentViewer, type DocumentViewerHandle } from "./DocumentViewer";
import { loadPdfjs } from "./pdfjs";

/*
 * pdf.js itself is not run here (no canvas, no worker in jsdom): `loadPdfjs`
 * hands the viewer a fake of the four components it drives, which records
 * how they were built and what they were asked. The real library runs in
 * the browser check of the harness.
 */
vi.mock("./pdfjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pdfjs")>()),
  loadPdfjs: vi.fn(),
}));

const FIND = { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 };

type Listener = (data: never) => void;

class FakeEventBus {
  listeners = new Map<string, Set<Listener>>();
  dispatched: [string, Record<string, unknown>][] = [];
  on(name: string, fn: Listener, opts?: { signal?: AbortSignal }) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
    opts?.signal?.addEventListener("abort", () => set.delete(fn));
  }
  dispatch(name: string, data: Record<string, unknown> = {}) {
    this.dispatched.push([name, data]);
    for (const fn of this.listeners.get(name) ?? []) fn(data as never);
  }
}

let fake: ReturnType<typeof makeFake>;

function makeFake(numPages = 3) {
  const state = {
    bus: null as FakeEventBus | null,
    viewerOptions: null as Record<string, unknown> | null,
    linkOptions: null as Record<string, unknown> | null,
    linkService: null as { externalLinkEnabled: boolean; goToDestination: ReturnType<typeof vi.fn> } | null,
    viewer: null as FakeViewer | null,
    getDocument: vi.fn(),
  };
  const doc = {
    numPages,
    getOutline: async () => [
      { title: "Introduction", dest: "intro", items: [{ title: "Pins", dest: [{ num: 9, gen: 0 }, { name: "XYZ" }], items: [] }] },
      { title: "Limits", dest: "limits", items: [] },
    ],
    getDestination: async (name: string) => [{ num: name === "intro" ? 1 : 3, gen: 0 }],
    getPageIndex: async (ref: { num: number }) => (ref.num === 9 ? 1 : ref.num - 1),
  };
  class FakeViewer {
    pagesCount = 0;
    currentScale = 1;
    #page = 1;
    scales: string[] = [];
    scrollPageIntoView = vi.fn();
    constructor(options: Record<string, unknown>) {
      state.viewerOptions = options;
      state.viewer = this;
    }
    get enableScripting() {
      return Boolean(state.viewerOptions?.["scriptingManager"]);
    }
    setDocument(d: typeof doc | null) {
      if (!d) return;
      this.pagesCount = d.numPages;
      queueMicrotask(() => state.bus!.dispatch("pagesinit"));
    }
    set currentScaleValue(value: string) {
      this.scales.push(value);
      this.currentScale = value === "page-width" ? 1.37 : Number(value);
      state.bus!.dispatch("scalechanging", { scale: this.currentScale });
    }
    get currentPageNumber() {
      return this.#page;
    }
    set currentPageNumber(page: number) {
      this.#page = page;
      state.bus!.dispatch("pagechanging", { pageNumber: page });
    }
    previousPage() {
      this.currentPageNumber = Math.max(1, this.#page - 1);
    }
    nextPage() {
      this.currentPageNumber = Math.min(this.pagesCount, this.#page + 1);
    }
  }
  const components = {
    EventBus: class extends FakeEventBus {
      constructor() {
        super();
        state.bus = this;
      }
    },
    PDFLinkService: class {
      externalLinkEnabled = true;
      goToDestination = vi.fn();
      constructor(options: Record<string, unknown>) {
        state.linkOptions = options;
        state.linkService = this;
      }
      setViewer() {}
      setDocument() {}
    },
    PDFFindController: class {
      _scrollMatches = false;
      scrollMatchIntoView() {}
    },
    PDFViewer: FakeViewer,
    FindState: FIND,
  };
  state.getDocument.mockImplementation(() => ({ promise: Promise.resolve(doc), destroy: vi.fn(async () => {}) }));
  const lib = {
    getDocument: state.getDocument,
    AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 },
    AnnotationEditorType: { DISABLE: -1, NONE: 0 },
  };
  vi.mocked(loadPdfjs).mockResolvedValue({ lib, viewer: components } as never);
  return state;
}

beforeEach(() => {
  fake = makeFake();
});

afterEach(() => {
  vi.mocked(loadPdfjs).mockReset();
});

const pdf = { kind: "pdf" as const, url: "/files/datasheet.pdf" };
const region = () => screen.getByRole("region", { name: "Datasheet" });
const searchBox = () => screen.getByRole("searchbox", { name: "Search the document" });
const pageField = () => screen.getByRole("textbox", { name: "Page" });
/** The last `find` asked of pdf.js. */
const lastFind = () => [...fake.bus!.dispatched].reverse().find(([name]) => name === "find")?.[1];

async function renderPdf(props: Partial<Parameters<typeof DocumentViewer>[0]> = {}) {
  const view = renderWithProviders(<DocumentViewer source={pdf} title="Datasheet" {...props} />);
  await waitFor(() => expect(pageField()).toHaveValue("1"));
  return view;
}

describe("the PDF viewer", () => {
  it("says it is loading, then shows the page and the zoom", async () => {
    let resolve!: (doc: unknown) => void;
    fake.getDocument.mockImplementation(() => ({ promise: new Promise((r) => (resolve = r)), destroy: vi.fn() }));
    renderWithProviders(<DocumentViewer source={pdf} title="Datasheet" />);
    expect(await screen.findByRole("status", { name: "Loading the document" })).toBeInTheDocument();
    expect(region()).toHaveAttribute("aria-busy", "true");
    await act(async () =>
      resolve({ numPages: 3, getOutline: async () => null, getDestination: async () => null, getPageIndex: async () => 0 }),
    );
    await waitFor(() => expect(pageField()).toHaveValue("1"));
    expect(screen.queryByRole("status", { name: "Loading the document" })).not.toBeInTheDocument();
    expect(screen.getByText("/ 3")).toBeInTheDocument();
    expect(screen.getByText("137%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit to width" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the document by ranges from our origin, with scripting, forms, editing and external links off", async () => {
    await renderPdf();
    expect(fake.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/files/datasheet.pdf",
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 1048576,
        enableXfa: false,
        withCredentials: false,
        cMapUrl: "/pdfjs/cmaps/",
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
      }),
    );
    expect(fake.viewerOptions).toMatchObject({ annotationMode: 1, annotationEditorMode: -1, enableAutoLinking: false });
    expect(fake.viewerOptions).not.toHaveProperty("scriptingManager");
    expect(fake.viewer!.enableScripting).toBe(false);
    expect(fake.linkService!.externalLinkEnabled).toBe(false);
    expect(fake.linkOptions).toMatchObject({ ignoreDestinationZoom: true });
  });

  it("says when the document cannot be loaded, and tries again", async () => {
    fake.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("403")), destroy: vi.fn() }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderWithProviders(<DocumentViewer source={pdf} title="Datasheet" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This document could not be loaded.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pageField()).toHaveValue("1"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fake.getDocument).toHaveBeenCalledTimes(2);
  });

  it("moves page by page, and to the page typed (clamped)", async () => {
    const user = userEvent.setup();
    await renderPdf();
    const previous = screen.getByRole("button", { name: "Previous page" });
    const next = screen.getByRole("button", { name: "Next page" });
    expect(previous).toBeDisabled();
    await user.click(next);
    await waitFor(() => expect(pageField()).toHaveValue("2"));
    await user.clear(pageField());
    await user.type(pageField(), "9{Enter}");
    await waitFor(() => expect(fake.viewer!.currentPageNumber).toBe(3));
    expect(next).toBeDisabled();
    // Escape puts the current page back and the focus on the document.
    await user.type(pageField(), "x{Escape}");
    expect(pageField()).toHaveValue("3");
    expect(region()).toHaveFocus();
  });

  it("zooms by steps and back to the width", async () => {
    const user = userEvent.setup();
    await renderPdf();
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(fake.viewer!.scales.at(-1)).toBe("1.5");
    await waitFor(() => expect(screen.getByText("150%")).toBeInTheDocument());
    const fit = screen.getByRole("button", { name: "Fit to width" });
    expect(fit).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(fake.viewer!.scales.at(-1)).toBe("1.25");
    await user.click(fit);
    expect(fake.viewer!.scales.at(-1)).toBe("page-width");
    await waitFor(() => expect(fit).toHaveAttribute("aria-pressed", "true"));
  });

  it("searches as the reader types, counts, and steps with Enter and Shift+Enter", async () => {
    const user = userEvent.setup();
    await renderPdf();
    await user.type(searchBox(), "gain");
    expect(lastFind()).toMatchObject({ type: "", query: "gain", highlightAll: true, caseSensitive: false, matchDiacritics: false });
    act(() => fake.bus!.dispatch("updatefindmatchescount", { matchesCount: { current: 2, total: 5 } }));
    await waitFor(() => expect(screen.getByText("2 / 5")).toBeInTheDocument());
    await user.keyboard("{Enter}");
    expect(lastFind()).toMatchObject({ type: "again", findPrevious: false });
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(lastFind()).toMatchObject({ type: "again", findPrevious: true });
    await user.click(screen.getByRole("button", { name: "Previous result" }));
    expect(lastFind()).toMatchObject({ type: "again", findPrevious: true });
    act(() => fake.bus!.dispatch("updatefindcontrolstate", { state: FIND.NOT_FOUND, matchesCount: { current: 0, total: 0 } }));
    await waitFor(() => expect(screen.getByText("No results")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Next result" })).toBeDisabled();
    await user.clear(searchBox());
    expect(fake.bus!.dispatched.at(-1)?.[0]).toBe("findbarclose");
  });

  it("takes Ctrl+F inside it, and hands the focus back on Escape", async () => {
    const user = userEvent.setup();
    const onSearchEscape = vi.fn();
    await renderPdf({ onSearchEscape });
    region().focus();
    await user.keyboard("{Control>}f{/Control}");
    expect(searchBox()).toHaveFocus();
    await user.type(searchBox(), "noise");
    await user.keyboard("{Escape}");
    expect(region()).toHaveFocus();
    expect(onSearchEscape).toHaveBeenCalledTimes(1);
    // The query stays.
    expect(searchBox()).toHaveValue("noise");
  });

  it("opens its outline, two levels deep, and goes to an entry", async () => {
    const user = userEvent.setup();
    await renderPdf();
    const toggle = screen.getByRole("button", { name: "Outline" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "Outline" });
    expect(toggle).toHaveAttribute("aria-controls", nav.id);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pins" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Introduction" })).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByRole("button", { name: "Pins" }));
    expect(fake.linkService!.goToDestination).toHaveBeenCalledWith([{ num: 9, gen: 0 }, { name: "XYZ" }]);
    act(() => fake.viewer!.nextPage());
    await waitFor(() => expect(screen.getByRole("button", { name: "Pins" })).toHaveAttribute("aria-current", "true"));
  });

  it("reports its state, and starts again from a kept one", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    await renderPdf({ onStateChange });
    await user.click(screen.getByRole("button", { name: "Outline" }));
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "pdf", outline: true })));
    // The viewer records positions pdf.js reports once the kept one is back.
    act(() => fake.bus!.dispatch("updateviewarea", { location: { pageNumber: 2, top: 300, left: 10 } }));
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ location: { pageNumber: 2, top: 300, left: 10 } })),
    );
  });

  it("puts a kept state back: position, zoom, query and outline", async () => {
    const ref = createRef<DocumentViewerHandle>();
    const kept = { kind: "pdf", location: { pageNumber: 2, top: 412, left: 24 }, scale: 2, query: "offset", outline: true };
    await renderPdf({ initialState: JSON.parse(JSON.stringify(kept)), ref });
    expect(fake.viewer!.scales[0]).toBe("2");
    expect(fake.viewer!.scrollPageIntoView).toHaveBeenCalledWith({
      pageNumber: 2,
      destArray: [null, { name: "XYZ" }, 24, 412, null],
      allowNegativeOffset: true,
    });
    expect(searchBox()).toHaveValue("offset");
    expect(lastFind()).toMatchObject({ query: "offset" });
    expect(screen.getByRole("button", { name: "Outline" })).toHaveAttribute("aria-expanded", "true");
    expect(ref.current!.state()).toEqual(kept);
  });

  it("hides in place when inactive", async () => {
    const { container, rerender } = await renderPdf();
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toHaveAttribute("inert");
    rerender(<DocumentViewer source={pdf} title="Datasheet" active={false} />);
    expect(root).toHaveAttribute("inert");
    expect(root).toHaveClass("invisible");
  });

  it("names its pages in the interface language", async () => {
    renderWithProviders(<DocumentViewer source={pdf} title="Fiche" />, { locale: "fr" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Page" })).toHaveValue("1"));
    const l10n = fake.viewerOptions!["l10n"] as { translate: (el: HTMLElement) => Promise<void> };
    const page = document.createElement("div");
    page.setAttribute("data-l10n-id", "pdfjs-page-landmark");
    page.setAttribute("data-l10n-args", '{"page":4}');
    await l10n.translate(page);
    expect(page).toHaveAttribute("aria-label", "Page 4");
    expect(screen.getByRole("button", { name: "Ajuster à la largeur" })).toBeInTheDocument();
  });
});

const markdown = {
  kind: "markdown" as const,
  html: [
    '<h1 id="title">Cheat sheet</h1>',
    '<p>The gain and the <a href="https://example.com/x">site</a>, <a href="#limits">limits</a>.</p>',
    '<h2 id="basics">Basics</h2><p>Gain of a follower.</p>',
    '<h3 id="follower">Follower</h3><p>No gain here.</p>',
    '<h2 id="limits">Limits</h2><p>The end.</p>',
  ].join(""),
  toc: [
    { id: "title", depth: 1, text: "Cheat sheet" },
    { id: "basics", depth: 2, text: "Basics" },
    { id: "follower", depth: 3, text: "Follower" },
    { id: "limits", depth: 2, text: "Limits" },
  ],
};

describe("the Markdown viewer", () => {
  beforeEach(() => {
    // jsdom lays nothing out; a range has no box of its own there.
    Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
  });

  it("shows the server's HTML in the journal's long-form type, without a page control", async () => {
    renderWithProviders(<DocumentViewer source={markdown} title="Cheat sheet" />);
    const area = screen.getByRole("region", { name: "Cheat sheet" });
    await waitFor(() => expect(area.querySelector("article.md-body.md-doc")).not.toBeNull());
    expect(area.querySelector("h2#basics")).toHaveTextContent("Basics");
    expect(screen.queryByRole("textbox", { name: "Page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fit to width" })).not.toBeInTheDocument();
  });

  it("changes the text size", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DocumentViewer source={markdown} title="Cheat sheet" />);
    await waitFor(() => expect(screen.getByText("100%")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    expect(await screen.findByText("115%")).toBeInTheDocument();
    expect(document.querySelector<HTMLElement>("article")!.style.getPropertyValue("--doc-zoom")).toBe("1.15");
    await user.click(screen.getByRole("button", { name: "Smaller text" }));
    await user.click(screen.getByRole("button", { name: "Smaller text" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Smaller text" })).toBeDisabled());
    expect(screen.getByText("85%")).toBeInTheDocument();
  });

  it("searches without accents or case, marks the matches and steps through them", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DocumentViewer source={markdown} title="Cheat sheet" />);
    await user.type(searchBox(), "GAIN");
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
    // jsdom has no Custom Highlight API: the `<mark>` fallback.
    expect(document.querySelectorAll("article mark.doc-match")).toHaveLength(3);
    await user.keyboard("{Enter}");
    expect(await screen.findByText("2 / 3")).toBeInTheDocument();
    await user.keyboard("{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}");
    expect(await screen.findByText("3 / 3")).toBeInTheDocument();
    expect(document.querySelector("article mark.doc-current")).toHaveTextContent("gain");
    await user.clear(searchBox());
    await user.type(searchBox(), "zzz");
    await waitFor(() => expect(screen.getByText("No results")).toBeInTheDocument());
    expect(document.querySelectorAll("article mark")).toHaveLength(0);
  });

  it("builds its outline from the table of contents, and goes to a heading", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DocumentViewer source={markdown} title="Cheat sheet" initialState={{ kind: "markdown", outline: true }} />);
    const nav = screen.getByRole("navigation", { name: "Outline" });
    await waitFor(() => expect(nav.querySelectorAll("button")).toHaveLength(3));
    // The lone h1 is the document's title, not an entry.
    expect(screen.queryByRole("button", { name: "Cheat sheet" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Limits" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Limits" })).toHaveAttribute("aria-current", "true"));
  });

  it("keeps every link inside the document", async () => {
    renderWithProviders(<DocumentViewer source={markdown} title="Cheat sheet" />);
    await waitFor(() => expect(document.querySelector("article a")).not.toBeNull());
    const [external, anchor] = [...document.querySelectorAll("article a")];
    // `fireEvent` returns false when the default was prevented.
    expect(fireEvent.click(external!)).toBe(false);
    expect(fireEvent.click(anchor!)).toBe(false);
    expect(window.location.hash).toBe("");
  });

  it("starts a new source from its own state", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(<DocumentViewer source={markdown} title="Cheat sheet" />);
    await user.type(searchBox(), "gain");
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
    const other = { kind: "markdown" as const, html: "<p>Another text.</p>", toc: [] };
    rerender(<DocumentViewer source={other} title="Other" />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Other" })).toHaveTextContent("Another text."));
    expect(searchBox()).toHaveValue("");
    expect(document.querySelectorAll("article")).toHaveLength(1);
  });

  it("reports its state with the text size and the query", async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    renderWithProviders(<DocumentViewer source={markdown} title="Cheat sheet" onStateChange={onStateChange} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Larger text" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    await user.type(searchBox(), "gain");
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "markdown", zoom: 1.15, query: "gain" })),
    );
  });
});
