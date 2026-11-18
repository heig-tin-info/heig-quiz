// @vitest-environment jsdom
/// <reference lib="dom" />
/**
 * images/c-dev/seb-workbench.js, the script the student image adds to
 * code-server's workbench page (#1149, #1151). SEB's `Clipboard.js` is
 * simulated as SEB Windows 3.10.3 ships it (document listeners in the capture
 * phase that cancel the event; paste through `setRangeText`, the released
 * way), and jsdom lacks `ClipboardEvent` and `DataTransfer`, so the browser's
 * two are stood in for by the smallest classes that carry `clipboardData`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A path, not a URL: under jsdom `URL` is jsdom's, which `readFileSync` refuses.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../images/c-dev/seb-workbench.js"), "utf8");

/** The script, loaded with a `module`: it exports `install` instead of running. */
function load(): { install: (win: Window) => () => void } {
  const mod = { exports: {} as { install: (win: Window) => () => void } };
  new Function("module", source)(mod);
  return mod.exports;
}

class FakeDataTransfer {
  readonly #data = new Map<string, string>();
  setData(type: string, value: string) {
    this.#data.set(type, value);
  }
  getData(type: string) {
    return this.#data.get(type) ?? "";
  }
}

class FakeClipboardEvent extends Event {
  readonly clipboardData: FakeDataTransfer | null;
  constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer | null } = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}

type Field = HTMLInputElement | HTMLTextAreaElement;

interface SebClipboard {
  id: string;
  text: string;
  ranges: unknown[];
  clear(): void;
  getContentEncoded(): string;
}

const globals = window as unknown as Record<string, unknown>;
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** SEB's Clipboard.js, the parts that matter here. */
function startSeb() {
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
  globals["SafeExamBrowser"] = { clipboard };
  globals["CefSharp"] = { PostMessage: (message: unknown) => posted.push(message) };
  // SEB tests `e.target.contentEditable && e.target.setRangeText`; jsdom has no
  // `contentEditable`, a browser's is always a non-empty string.
  const isField = (target: EventTarget | null): target is Field =>
    typeof (target as Field | null)?.setRangeText === "function";
  const post = () => posted.push({ Type: "Clipboard", Id: clipboard.id, Content: clipboard.getContentEncoded() });
  const copy = (cut: boolean) => (event: Event) => {
    clipboard.clear();
    const target = event.target;
    if (isField(target)) {
      clipboard.text = target.value.substring(target.selectionStart ?? 0, target.selectionEnd ?? 0);
      if (cut) target.setRangeText("", target.selectionStart ?? 0, target.selectionEnd ?? 0, "select");
    } else {
      clipboard.text = String(window.getSelection() ?? "");
    }
    post();
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
  const onCopy = copy(false);
  const onCut = copy(true);
  document.addEventListener("copy", onCopy, true);
  document.addEventListener("cut", onCut, true);
  document.addEventListener("paste", paste, true);
  return {
    clipboard,
    posted,
    paste,
    stop() {
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
      document.removeEventListener("paste", paste, true);
    },
  };
}

function clipboardEvent(type: "copy" | "cut" | "paste", text?: string) {
  const data = new FakeDataTransfer();
  if (text !== undefined) data.setData("text/plain", text);
  return new FakeClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true, composed: true });
}

/** A VS Code editor: an element with an EditContext, reading `clipboardData`. */
function editor() {
  const node = document.createElement("div");
  (node as unknown as { editContext: object }).editContext = {};
  const pasted: Event[] = [];
  node.addEventListener("paste", (event) => {
    pasted.push(event);
    event.preventDefault();
  });
  document.body.append(node);
  return { node, pasted };
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

let uninstall: (() => void) | undefined;
let seb: ReturnType<typeof startSeb> | undefined;
const osReadText = vi.fn(async () => "from the OS");
const osWriteText = vi.fn(async (_text: string) => undefined);

beforeEach(() => {
  Object.assign(globals, { DataTransfer: FakeDataTransfer, ClipboardEvent: FakeClipboardEvent });
  Object.defineProperty(navigator, "clipboard", {
    value: { readText: osReadText, writeText: osWriteText },
    configurable: true,
  });
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  seb?.stop();
  seb = undefined;
  for (const key of ["SafeExamBrowser", "CefSharp", "_VSCODE_NLS_LANGUAGE"]) delete globals[key];
  delete (navigator as unknown as Record<string, unknown>)["getBattery"];
  document.body.replaceChildren();
  osReadText.mockClear();
  osWriteText.mockClear();
});

describe("paste under SEB", () => {
  beforeEach(() => {
    seb = startSeb();
    seb.clipboard.text = "printf(\"%d\\n\", n);";
    uninstall = load().install(window);
  });

  it("re-dispatches the paste on an editor with SEB's text in clipboardData, once", () => {
    const { node, pasted } = editor();
    const original = clipboardEvent("paste");
    node.dispatchEvent(original);
    expect(original.defaultPrevented).toBe(true);
    expect(pasted).toHaveLength(1);
    expect(pasted[0]).not.toBe(original);
    expect((pasted[0] as FakeClipboardEvent).clipboardData?.getData("text/plain")).toBe("printf(\"%d\\n\", n);");
    // SEB never saw the original. Its document listener cannot be skipped by
    // the re-dispatched event and cancels it, which the editor ignores.
    expect(seb?.paste.mock.calls.map(([event]) => event)).toEqual([pasted[0]]);
  });

  it("re-dispatches the paste on the terminal's textarea", () => {
    const term = document.createElement("div");
    term.className = "xterm";
    const helper = document.createElement("textarea");
    term.append(helper);
    document.body.append(term);
    const read: string[] = [];
    // xterm's handler: it sends `clipboardData`'s text to the shell, then
    // empties its textarea (where SEB's listener also wrote the text).
    helper.addEventListener("paste", (event) => {
      read.push((event as FakeClipboardEvent).clipboardData?.getData("text/plain") ?? "");
      helper.value = "";
    });
    const original = clipboardEvent("paste");
    helper.dispatchEvent(original);
    expect(read).toEqual(["printf(\"%d\\n\", n);"]);
    expect(helper.value).toBe("");
    expect(seb?.paste.mock.calls.map(([event]) => event)).not.toContain(original);
  });

  it("inserts into a text field at the selection, without eating what follows, and fires input", () => {
    const input = document.createElement("input");
    input.value = "find: ab|cd";
    document.body.append(input);
    input.setSelectionRange(8, 8);
    const inputs: InputEvent[] = [];
    input.addEventListener("input", (event) => inputs.push(event as InputEvent));
    seb!.clipboard.text = "XY";
    input.dispatchEvent(clipboardEvent("paste"));
    expect(input.value).toBe("find: abXY|cd");
    expect(input.selectionStart).toBe(10);
    expect(inputs.map((event) => event.inputType)).toEqual(["insertFromPaste"]);
    expect(seb?.paste).not.toHaveBeenCalled();
  });

  it("leaves a read-only field untouched", () => {
    const area = document.createElement("textarea");
    area.value = "keep";
    area.readOnly = true;
    document.body.append(area);
    area.dispatchEvent(clipboardEvent("paste"));
    expect(area.value).toBe("keep");
  });

  it("leaves anything else to SEB", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.append(div);
    div.dispatchEvent(clipboardEvent("paste"));
    expect(seb?.paste).toHaveBeenCalledTimes(1);
  });
});

describe("copy and cut under SEB", () => {
  beforeEach(() => {
    seb = startSeb();
    uninstall = load().install(window);
  });

  it("takes the editor's copy into SEB's clipboard and posts it to the host", () => {
    const { node } = editor();
    node.addEventListener("copy", (event) => {
      (event as FakeClipboardEvent).clipboardData?.setData("text/plain", "int main(void)");
      event.preventDefault();
    });
    node.dispatchEvent(clipboardEvent("copy"));
    expect(seb?.clipboard.text).toBe("int main(void)");
    expect(seb?.clipboard.ranges).toEqual([]);
    expect(seb?.posted.at(-1)).toEqual({ Type: "Clipboard", Id: "seb-window-1", Content: encode("int main(void)") });
  });

  it("keeps SEB's own copy of a text field, and announces its cut", () => {
    const area = document.createElement("textarea");
    area.value = "hello world";
    document.body.append(area);
    area.setSelectionRange(0, 5);
    const inputs: string[] = [];
    area.addEventListener("input", (event) => inputs.push((event as InputEvent).inputType));
    area.dispatchEvent(clipboardEvent("cut"));
    expect(seb?.clipboard.text).toBe("hello");
    expect(area.value).toBe(" world");
    expect(inputs).toEqual(["deleteByCut"]);
  });

  it("serves navigator.clipboard from SEB's clipboard", async () => {
    seb!.clipboard.text = "from SEB";
    await expect(navigator.clipboard.readText()).resolves.toBe("from SEB");
    await navigator.clipboard.writeText("copied in the terminal");
    expect(seb?.clipboard.text).toBe("copied in the terminal");
    expect(seb?.posted.at(-1)).toEqual({ Type: "Clipboard", Id: "seb-window-1", Content: encode("copied in the terminal") });
    expect(osReadText).not.toHaveBeenCalled();
    expect(osWriteText).not.toHaveBeenCalled();
  });
});

describe("outside SEB", () => {
  beforeEach(() => {
    uninstall = load().install(window);
  });

  it("lets every event through as it is", () => {
    const { node, pasted } = editor();
    const original = clipboardEvent("paste", "from the browser");
    node.dispatchEvent(original);
    expect(pasted).toEqual([original]);
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(clipboardEvent("paste", "x"));
    expect(input.value).toBe("");
  });

  it("delegates navigator.clipboard to the browser", async () => {
    await expect(navigator.clipboard.readText()).resolves.toBe("from the OS");
    await navigator.clipboard.writeText("t");
    expect(osWriteText).toHaveBeenCalledWith("t");
  });

  it("shows no battery", async () => {
    Object.defineProperty(navigator, "getBattery", { value: vi.fn(), configurable: true });
    await nextTask();
    expect(document.getElementById("heig-seb-battery")).toBeNull();
    expect((navigator as unknown as { getBattery: () => unknown }).getBattery).not.toHaveBeenCalled();
  });
});

describe("battery under SEB", () => {
  function fakeBattery(init: { level: number; charging: boolean; chargingTime: number; dischargingTime: number }) {
    return Object.assign(new EventTarget(), init);
  }

  function statusBar() {
    const bar = document.createElement("div");
    bar.id = "workbench.parts.statusbar";
    document.body.append(bar);
    return bar;
  }

  it("shows the charge in the status bar, and the time and remaining time on a click", async () => {
    const bar = statusBar();
    const battery = fakeBattery({ level: 0.85, charging: false, chargingTime: Infinity, dischargingTime: 7500 });
    Object.defineProperty(navigator, "getBattery", { value: async () => battery, configurable: true });
    seb = startSeb();
    uninstall = load().install(window);
    await nextTask();
    const button = document.getElementById("heig-seb-battery");
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

  it("speaks French when the workspace does, and warns when low", async () => {
    globals["_VSCODE_NLS_LANGUAGE"] = "fr";
    const battery = fakeBattery({ level: 0.15, charging: false, chargingTime: Infinity, dischargingTime: 1500 });
    Object.defineProperty(navigator, "getBattery", { value: async () => battery, configurable: true });
    seb = startSeb();
    uninstall = load().install(window);
    await nextTask();
    const button = document.getElementById("heig-seb-battery");
    expect(button?.parentElement).toBe(document.body);
    expect(button?.dataset["level"]).toBe("warning");
    button?.click();
    expect(button?.textContent).toMatch(/^\u{1F50B} 15\u00a0% · \d\d:\d\d · 25 min restantes$/u);
    expect(button?.getAttribute("aria-label")).toBe("Batterie 15\u00a0%");
  });

  it("waits for SEB's object, which SEB adds after the page loads", async () => {
    const battery = fakeBattery({ level: 1, charging: true, chargingTime: 0, dischargingTime: Infinity });
    Object.defineProperty(navigator, "getBattery", { value: async () => battery, configurable: true });
    uninstall = load().install(window);
    await nextTask();
    expect(document.getElementById("heig-seb-battery")).toBeNull();
    globals["SafeExamBrowser"] = {};
    await vi.waitFor(() => expect(document.getElementById("heig-seb-battery")?.textContent).toBe("\u{1F50B} 100% \u26A1"));
  });

  it("removes the button when uninstalled", async () => {
    const battery = fakeBattery({ level: 0.5, charging: false, chargingTime: Infinity, dischargingTime: Infinity });
    Object.defineProperty(navigator, "getBattery", { value: async () => battery, configurable: true });
    seb = startSeb();
    uninstall = load().install(window);
    await nextTask();
    expect(document.getElementById("heig-seb-battery")).not.toBeNull();
    uninstall();
    uninstall = undefined;
    expect(document.getElementById("heig-seb-battery")).toBeNull();
  });
});
