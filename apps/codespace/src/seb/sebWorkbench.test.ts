/// <reference lib="dom" />
/**
 * images/c-dev/seb-workbench.js, the script the student image adds to
 * code-server's workbench page (#1149, #1151). The image has no test runner
 * of its own, so its test lives here. Each test gets a fresh jsdom window.
 * SEB's `Clipboard.js` is simulated as SEB Windows 3.10.3 ships it (document
 * listeners in the capture phase that cancel the event; paste through
 * `setRangeText`, the released way), and jsdom lacks `ClipboardEvent` and
 * `DataTransfer`, so the browser's two are stood in for by the smallest
 * classes that carry `clipboardData`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

type DomWindow = Window & typeof globalThis & Record<string, unknown>;

// jsdom ships no types; this is the one constructor the test uses.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string }) => { window: DomWindow };
};

const source = readFileSync(new URL("../../images/c-dev/seb-workbench.js", import.meta.url), "utf8");

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0";
const SEB_UA = `${WINDOWS_UA} SEB/3.10.3`;

class FakeDataTransfer {
  readonly #data = new Map<string, string>();
  setData(type: string, value: string) {
    this.#data.set(type, value);
  }
  getData(type: string) {
    return this.#data.get(type) ?? "";
  }
}

interface ClipboardEventLike extends Event {
  readonly clipboardData: FakeDataTransfer | null;
}

interface SebClipboard {
  id: string;
  text: string;
  ranges: unknown[];
  clear(): void;
  getContentEncoded(): string;
}

type Field = HTMLInputElement | HTMLTextAreaElement;

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

let open: DomWindow | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

/**
 * A fresh page: jsdom's window with the browser's two clipboard classes, a
 * `navigator.clipboard`, the given user agent and battery, SEB's
 * `Clipboard.js` when asked, then the script installed.
 */
function page(options: { seb?: boolean; userAgent?: string; battery?: object; before?: (win: DomWindow) => void } = {}) {
  const win = new JSDOM("<!doctype html><body></body>", { url: "https://workspace.test/" }).window;
  open = win;
  const doc = win.document;
  class ClipboardEvent extends win.Event {
    readonly clipboardData: FakeDataTransfer | null;
    constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer | null } = {}) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  }
  Object.assign(win, { DataTransfer: FakeDataTransfer, ClipboardEvent });
  const os = { readText: vi.fn(async () => "from the OS"), writeText: vi.fn(async (_text: string) => undefined) };
  Object.defineProperty(win.navigator, "clipboard", { value: { ...os }, configurable: true });
  Object.defineProperty(win.navigator, "userAgent", { value: options.userAgent ?? (options.seb ? SEB_UA : WINDOWS_UA) });
  if (options.battery) Object.defineProperty(win.navigator, "getBattery", { value: async () => options.battery });
  const seb = options.seb ? startSeb(win) : undefined;
  options.before?.(win);
  const mod = { exports: {} as { install: (target: Window) => void } };
  new Function("module", source)(mod);
  mod.exports.install(win);

  const clipboardEvent = (type: "copy" | "cut" | "paste", text?: string): ClipboardEventLike => {
    const data = new FakeDataTransfer();
    if (text !== undefined) data.setData("text/plain", text);
    return new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true, composed: true });
  };
  /** A VS Code editor: an element with an EditContext, reading `clipboardData`. */
  const editor = () => {
    const node = doc.createElement("div");
    (node as unknown as { editContext: object }).editContext = {};
    const pasted: ClipboardEventLike[] = [];
    node.addEventListener("paste", (event) => {
      pasted.push(event as ClipboardEventLike);
      event.preventDefault();
    });
    doc.body.append(node);
    return { node, pasted };
  };
  return { win, doc, seb, os, clipboardEvent, editor };
}

/** SEB's Clipboard.js, the parts that matter here, with its two globals. */
function startSeb(win: DomWindow) {
  const posted: unknown[] = [];
  const clipboard: SebClipboard = {
    id: "seb-window-1",
    text: "",
    ranges: [],
    clear() {
      this.text = "";
      this.ranges = [];
    },
    getContentEncoded() {
      return encode(this.text);
    },
  };
  win["SafeExamBrowser"] = { clipboard };
  win["CefSharp"] = { PostMessage: (message: unknown) => posted.push(message) };
  // SEB tests `e.target.contentEditable && e.target.setRangeText`; jsdom has no
  // `contentEditable`, a browser's is always a non-empty string.
  const isField = (target: EventTarget | null): target is Field =>
    typeof (target as Field | null)?.setRangeText === "function";
  const copy = (cut: boolean) => (event: Event) => {
    clipboard.clear();
    const target = event.target;
    if (isField(target)) {
      clipboard.text = target.value.substring(target.selectionStart ?? 0, target.selectionEnd ?? 0);
      if (cut) target.setRangeText("", target.selectionStart ?? 0, target.selectionEnd ?? 0, "select");
    } else {
      clipboard.text = String(win.getSelection() ?? "");
    }
    posted.push({ Type: "Clipboard", Id: clipboard.id, Content: clipboard.getContentEncoded() });
    event.preventDefault();
  };
  const paste = vi.fn((event: Event) => {
    const target = event.target;
    if (isField(target)) {
      // The released versions: over as many characters after the caret as inserted.
      target.setRangeText("", target.selectionStart ?? 0, target.selectionEnd ?? 0, "select");
      const at = target.selectionStart ?? 0;
      target.setRangeText(clipboard.text, at, at + clipboard.text.length, "end");
    }
    event.preventDefault();
  });
  win.document.addEventListener("copy", copy(false), true);
  win.document.addEventListener("cut", copy(true), true);
  win.document.addEventListener("paste", paste, true);
  return { clipboard, posted, paste };
}

const CODE = 'printf("%d\\n", n);';

describe("paste under SEB", () => {
  it("re-dispatches the paste on an editor with SEB's text in clipboardData, once", () => {
    const { seb, clipboardEvent, editor } = page({ seb: true });
    seb!.clipboard.text = CODE;
    const { node, pasted } = editor();
    const original = clipboardEvent("paste");
    node.dispatchEvent(original);
    expect(original.defaultPrevented).toBe(true);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).not.toBe(original);
    expect(pasted[0]?.clipboardData?.getData("text/plain")).toBe(CODE);
    // SEB never saw the original. Its document listener cannot be skipped by
    // the re-dispatched event and cancels it, which the editor ignores.
    expect(seb?.paste.mock.calls.map(([event]) => event)).toEqual([pasted[0]]);
  });

  it("re-dispatches the paste on the terminal's textarea", () => {
    const { doc, seb, clipboardEvent } = page({ seb: true });
    seb!.clipboard.text = CODE;
    const term = doc.createElement("div");
    term.className = "xterm";
    const helper = doc.createElement("textarea");
    term.append(helper);
    doc.body.append(term);
    const read: string[] = [];
    // xterm's handler: it sends `clipboardData`'s text to the shell, then
    // empties its textarea (where SEB's listener also wrote the text).
    helper.addEventListener("paste", (event) => {
      read.push((event as ClipboardEventLike).clipboardData?.getData("text/plain") ?? "");
      helper.value = "";
    });
    const original = clipboardEvent("paste");
    helper.dispatchEvent(original);
    expect(read).toEqual([CODE]);
    expect(helper.value).toBe("");
    expect(seb?.paste.mock.calls.map(([event]) => event)).not.toContain(original);
  });

  it("inserts into a text field at the selection, without eating what follows, and fires input", () => {
    const { doc, seb, clipboardEvent } = page({ seb: true });
    const input = doc.createElement("input");
    input.value = "find: ab|cd";
    doc.body.append(input);
    input.setSelectionRange(8, 8);
    const inputs: string[] = [];
    input.addEventListener("input", (event) => inputs.push((event as InputEvent).inputType));
    seb!.clipboard.text = "XY";
    input.dispatchEvent(clipboardEvent("paste"));
    expect(input.value).toBe("find: abXY|cd");
    expect(input.selectionStart).toBe(10);
    expect(inputs).toEqual(["insertFromPaste"]);
    expect(seb?.paste).not.toHaveBeenCalled();
  });

  it("leaves a read-only field untouched", () => {
    const { doc, clipboardEvent } = page({ seb: true });
    const area = doc.createElement("textarea");
    area.value = "keep";
    area.readOnly = true;
    doc.body.append(area);
    area.dispatchEvent(clipboardEvent("paste"));
    expect(area.value).toBe("keep");
  });

  it("leaves anything else to SEB", () => {
    const { doc, seb, clipboardEvent } = page({ seb: true });
    const div = doc.createElement("div");
    div.setAttribute("contenteditable", "true");
    doc.body.append(div);
    div.dispatchEvent(clipboardEvent("paste"));
    expect(seb?.paste).toHaveBeenCalledTimes(1);
  });
});

describe("copy and cut under SEB", () => {
  it("takes the editor's copy into SEB's clipboard and posts it to the host", () => {
    const { seb, clipboardEvent, editor } = page({ seb: true });
    const { node } = editor();
    node.addEventListener("copy", (event) => {
      (event as ClipboardEventLike).clipboardData?.setData("text/plain", "int main(void)");
      event.preventDefault();
    });
    node.dispatchEvent(clipboardEvent("copy"));
    expect(seb?.clipboard.text).toBe("int main(void)");
    expect(seb?.clipboard.ranges).toEqual([]);
    expect(seb?.posted.at(-1)).toEqual({ Type: "Clipboard", Id: "seb-window-1", Content: encode("int main(void)") });
  });

  it("keeps SEB's own copy of a text field, and announces its cut", () => {
    const { doc, seb, clipboardEvent } = page({ seb: true });
    const area = doc.createElement("textarea");
    area.value = "hello world";
    doc.body.append(area);
    area.setSelectionRange(0, 5);
    const inputs: string[] = [];
    area.addEventListener("input", (event) => inputs.push((event as InputEvent).inputType));
    area.dispatchEvent(clipboardEvent("cut"));
    expect(seb?.clipboard.text).toBe("hello");
    expect(area.value).toBe(" world");
    expect(inputs).toEqual(["deleteByCut"]);
  });

  it("serves navigator.clipboard from SEB's clipboard", async () => {
    const { win, seb, os } = page({ seb: true });
    seb!.clipboard.text = "from SEB";
    await expect(win.navigator.clipboard.readText()).resolves.toBe("from SEB");
    await win.navigator.clipboard.writeText("copied in the terminal");
    expect(seb?.clipboard.text).toBe("copied in the terminal");
    expect(seb?.posted.at(-1)).toEqual({ Type: "Clipboard", Id: "seb-window-1", Content: encode("copied in the terminal") });
    expect(os.readText).not.toHaveBeenCalled();
    expect(os.writeText).not.toHaveBeenCalled();
  });
});

describe("outside SEB", () => {
  it("lets every event through as it is", () => {
    const { doc, clipboardEvent, editor } = page();
    const { node, pasted } = editor();
    const original = clipboardEvent("paste", "from the browser");
    node.dispatchEvent(original);
    expect(pasted).toEqual([original]);
    const input = doc.createElement("input");
    doc.body.append(input);
    input.dispatchEvent(clipboardEvent("paste", "x"));
    expect(input.value).toBe("");
  });

  it("delegates navigator.clipboard to the browser", async () => {
    const { win, os } = page();
    await expect(win.navigator.clipboard.readText()).resolves.toBe("from the OS");
    await win.navigator.clipboard.writeText("t");
    expect(os.writeText).toHaveBeenCalledWith("t");
  });

  it("shows no battery", async () => {
    const getBattery = vi.fn();
    const { doc } = page({ before: (win) => Object.defineProperty(win.navigator, "getBattery", { value: getBattery }) });
    await nextTask();
    expect(doc.getElementById("heig-seb-battery")).toBeNull();
    expect(getBattery).not.toHaveBeenCalled();
  });
});

describe("battery under SEB", () => {
  function fakeBattery(init: { level: number; charging: boolean; chargingTime: number; dischargingTime: number }) {
    return Object.assign(new EventTarget(), init);
  }

  const statusBar = (win: DomWindow) => {
    const bar = win.document.createElement("div");
    bar.id = "workbench.parts.statusbar";
    win.document.body.append(bar);
    return bar;
  };

  it("shows the charge in the status bar, and the time and remaining time on a click", async () => {
    const battery = fakeBattery({ level: 0.85, charging: false, chargingTime: Infinity, dischargingTime: 7500 });
    let bar: HTMLElement | undefined;
    const { doc } = page({ seb: true, battery, before: (win) => (bar = statusBar(win)) });
    await nextTask();
    const button = doc.getElementById("heig-seb-battery");
    expect(button?.parentElement).toBe(bar);
    expect(button?.textContent).toBe("\u{1F50B} 85%");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    button?.click();
    expect(button?.textContent).toMatch(/^\u{1F50B} 85% · \d\d:\d\d · 2 h 05 min left$/u);
    battery.charging = true;
    battery.chargingTime = 1200;
    battery.dispatchEvent(new Event("chargingchange"));
    expect(button?.textContent).toMatch(/^\u{1F50B} 85% \u26A1 · \d\d:\d\d · full in 20 min$/u);
    button?.click();
    expect(button?.getAttribute("aria-expanded")).toBe("false");
  });

  it("moves into the status bar once the workbench has built it", async () => {
    const battery = fakeBattery({ level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity });
    const { win, doc } = page({ seb: true, battery });
    await nextTask();
    expect(doc.getElementById("heig-seb-battery")?.parentElement).toBe(doc.body);
    const bar = statusBar(win);
    await vi.waitFor(() => expect(doc.getElementById("heig-seb-battery")?.parentElement).toBe(bar), { timeout: 2000 });
    expect(doc.getElementById("heig-seb-battery")?.textContent).toBe("\u{1F50B} 100% \u26A1");
  });

  it("speaks French when the workspace does, and warns when low", async () => {
    const battery = fakeBattery({ level: 0.15, charging: false, chargingTime: Infinity, dischargingTime: 1500 });
    const { doc } = page({ seb: true, battery, before: (win) => (win["_VSCODE_NLS_LANGUAGE"] = "fr") });
    await nextTask();
    const button = doc.getElementById("heig-seb-battery");
    expect(button?.dataset["level"]).toBe("warning");
    button?.click();
    expect(button?.textContent).toMatch(/^\u{1F50B} 15\u00a0% · \d\d:\d\d · 25 min restantes$/u);
    expect(button?.getAttribute("aria-label")).toBe("Batterie 15\u00a0%");
  });

  it("speaks German when the workspace does, English for a language it lacks", async () => {
    const battery = fakeBattery({ level: 0.15, charging: false, chargingTime: Infinity, dischargingTime: 1500 });
    const { doc } = page({ seb: true, battery, before: (win) => (win["_VSCODE_NLS_LANGUAGE"] = "de-ch") });
    await nextTask();
    const button = doc.getElementById("heig-seb-battery");
    button?.click();
    expect(button?.textContent).toMatch(/^\u{1F50B} 15\u00a0% \u00b7 \d\d:\d\d \u00b7 noch 25 min$/u);
    expect(button?.getAttribute("aria-label")).toBe("Akku 15\u00a0%");

    const other = page({ seb: true, battery, before: (win) => (win["_VSCODE_NLS_LANGUAGE"] = "it") });
    await nextTask();
    expect(other.doc.getElementById("heig-seb-battery")?.getAttribute("aria-label")).toBe("Battery 15%");
  });
});
