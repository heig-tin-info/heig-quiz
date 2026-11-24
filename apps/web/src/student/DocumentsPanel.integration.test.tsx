import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProvidedDocument } from "@quiz/contracts";

import { useIntegrityJournal } from "../attempt/integrity";
import { loadPdfjs } from "../documents/pdfjs";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { viewport } from "../test/viewport";
import { attemptDocumentRoutes } from "./DocumentsPanel";
import { PlayerTools } from "./PlayerTools";

/*
 * ADR-144 §7, ADR-088, ADR-090: the documents panel as the player mounts it
 * (`PlayerTools`, beside a notepad that blocks its clipboard), with the REAL
 * viewer — pdf.js's real components, its document read in this thread — and
 * the REAL integrity journal's listeners on the page. Two documents mounted.
 */
vi.mock("../documents/pdfjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents/pdfjs")>()),
  loadPdfjs: vi.fn(),
}));

let lib: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let components: typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

/** A one-page PDF of `text` (Helvetica, Latin-1). */
function pdfOf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 20 250 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

beforeAll(async () => {
  lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = lib;
  // @ts-expect-error -- pdf.js ships no types for its worker module.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  components = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
});

const narrow = window.matchMedia;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  viewport(1440);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        canvas: document.createElement("canvas"),
        measureText: (text: string) => ({ width: text.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
        save() {},
        restore() {},
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.mocked(loadPdfjs).mockResolvedValue({
    lib: { ...lib, getDocument: (params: object) => lib.getDocument({ ...params, url: undefined, data: pdfOf("Datasheet") } as never) },
    viewer: components,
  } as never);
});
afterEach(() => {
  vi.stubGlobal("matchMedia", narrow);
  document.getSelection()?.removeAllRanges();
});

// µ (micro sign), Ω (ohm sign) and the ﬁ ligature: what pdf.js's own copy handler would rewrite.
const TEXT = "10 µF ﬁlter capacitor, 47 Ω résistance série";
const ATTEMPT = "a0000000-0000-4000-8000-000000000009";
const LIST: ProvidedDocument[] = [
  { id: "d0000000-0000-4000-8000-000000000011", title: "Datasheet", kind: "pdf" },
  { id: "d0000000-0000-4000-8000-000000000012", title: "Norme", kind: "pdf" },
];

/** The player's tools and an answer field, under the integrity journal. */
function Harness({ report }: { report: (entry: unknown) => void }) {
  useIntegrityJournal(ATTEMPT, report as never, { journaled: true, notify: false });
  return (
    <>
      <textarea aria-label="Answer" />
      <p>Explain what the capacitor filters.</p>
      <PlayerTools
        calculator="none"
        notepad="provided_no_clipboard"
        attemptId={ATTEMPT}
        preview={false}
        navigation="free"
        items={[]}
        documents={{ list: LIST, routes: attemptDocumentRoutes(ATTEMPT) }}
      />
    </>
  );
}

/** A `copy` event as a browser fires it: a clipboard to write, its text read back. */
function copyEvent() {
  const store = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { setData: (type: string, text: string) => store.set(type, text), getData: (type: string) => store.get(type) ?? "" },
  });
  return { event, clipboard: () => store.get("text/plain") ?? "" };
}

function pasteEvent(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  return event;
}

/** pdf.js's own text layer of {@link TEXT}, drawn inside the mounted viewer `title`'s document area. */
async function textLayerIn(title: string) {
  const area = screen.getByRole("region", { name: title });
  const abort = new AbortController();
  const pdfPage = {
    streamTextContent: () => ({
      items: [{ str: TEXT, dir: "ltr", width: TEXT.length * 6, height: 12, transform: [12, 0, 0, 12, 20, 250], fontName: "f1", hasEOL: false }],
      styles: { f1: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } },
      lang: "fr",
    }),
  };
  const view = { scale: 1, rotation: 0, userUnit: 1, width: 300, height: 300, transform: [1, 0, 0, -1, 0, 300], rawDims: { pageWidth: 300, pageHeight: 300, pageX: 0, pageY: 0 } };
  const builder = new components.TextLayerBuilder({ pdfPage: pdfPage as never, abortSignal: abort.signal });
  area.append(builder.div);
  await builder.render({ viewport: view, images: null } as never);
  return builder.div.querySelector("span")!;
}

async function openBoth() {
  mockFetch({
    "GET /app/api/me": ok({ id: "u1", email: "s@x", givenName: "S", familyName: "T", role: "student", session: { kind: "portal" } }),
  });
  const report = vi.fn();
  renderWithProviders(<Harness report={report} />);
  await userEvent.click(await screen.findByRole("button", { name: "Documents" }));
  await userEvent.click(screen.getByRole("tab", { name: "Norme" }));
  await userEvent.click(screen.getByRole("tab", { name: "Datasheet" }));
  // Both viewers mounted, the PDFs read.
  await waitFor(() => expect(screen.getAllByRole("region", { name: /^(Datasheet|Norme)$/ })).toHaveLength(2), { timeout: 5000 });
  await waitFor(() => expect(screen.getByRole("region", { name: "Datasheet" })).toHaveAttribute("aria-busy", "false"), { timeout: 5000 });
  return report;
}

describe("the documents panel in the player's integrity scope (ADR-088, ADR-144 §7)", () => {
  it("lets a copy from a PDF's text layer be pasted into an answer with no incident", async () => {
    const report = await openBoth();
    const span = await textLayerIn("Datasheet");
    document.getSelection()!.selectAllChildren(span);
    const { event, clipboard } = copyEvent();
    act(() => void span.dispatchEvent(event));
    expect(clipboard()).toBe(TEXT);
    act(() => void screen.getByRole("textbox", { name: "Answer" }).dispatchEvent(pasteEvent(clipboard())));
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "paste" }));
    // A text the page never showed still is an incident.
    act(() => void screen.getByRole("textbox", { name: "Answer" }).dispatchEvent(pasteEvent("A paragraph from somewhere else entirely.")));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "paste" }));
  });

  it("leaves Ctrl+A then a copy of the page to the page: no copy-all of pdf.js, with two viewers", async () => {
    await openBoth();
    expect(document.querySelectorAll("#hiddenCopyElement")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.getSelection()!.selectAllChildren(document.body);
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const seen = vi.fn();
    window.addEventListener("copy", seen);
    const { event } = copyEvent();
    screen.getByText("Explain what the capacitor filters.").dispatchEvent(event);
    window.removeEventListener("copy", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps ADR-090 true: a notepad that blocks its clipboard refuses a document's text, and nothing is journaled", async () => {
    const report = await openBoth();
    const span = await textLayerIn("Datasheet");
    document.getSelection()!.selectAllChildren(span);
    const { event, clipboard } = copyEvent();
    act(() => void span.dispatchEvent(event));
    await userEvent.click(screen.getByRole("button", { name: "Notepad" }));
    const page = await screen.findByRole("textbox", { name: /^Page 1/ });
    const paste = pasteEvent(clipboard());
    act(() => void page.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(true);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { getData: () => clipboard() } });
    fireEvent(page, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "paste" }));
  });
});
