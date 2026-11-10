import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bridgeSebClipboard } from "./sebClipboard.js";

/**
 * A wrapper holding a textarea (Monaco's hidden one) and, between them,
 * Monaco's own node, whose capture listeners must never see a paste SEB
 * handled.
 */
let wrapper: HTMLDivElement;
let monacoNode: HTMLDivElement;
let textarea: HTMLTextAreaElement;
let release: (() => void) | undefined;
/** What reached Monaco's node and the `input` events the textarea received. */
let reachedMonaco: string[];
let inputs: string[];

interface Seb {
  clipboard: { id: string; text: string; ranges: unknown[]; getContentEncoded: () => string };
}
const posted: unknown[] = [];

/** SEB's `Clipboard.js`, reduced to what matters here, on the document in the capture phase. */
const sebListeners: Array<[string, (e: Event) => void]> = [];
function installSeb(version: "released" | "master") {
  const clipboard = {
    id: "page",
    text: "",
    ranges: [] as unknown[],
    getContentEncoded() {
      return btoa(this.text);
    },
  };
  (globalThis as { SafeExamBrowser?: Seb }).SafeExamBrowser = { clipboard };
  (globalThis as { CefSharp?: unknown }).CefSharp = { PostMessage: (m: unknown) => posted.push(m) };
  const on = (type: string, handler: (e: Event) => void) => {
    sebListeners.push([type, handler]);
    document.addEventListener(type, handler, true);
  };
  const copySelection = (e: Event) => {
    const t = e.target as HTMLTextAreaElement;
    clipboard.text = t.value.substring(t.selectionStart, t.selectionEnd);
    e.preventDefault();
  };
  on("copy", copySelection);
  on("cut", copySelection);
  on("paste", (e) => {
    const t = e.target as HTMLTextAreaElement;
    if (version === "released") {
      // 3.10.3: replaces as many characters after the caret as it inserts, no event.
      t.setRangeText("", t.selectionStart, t.selectionEnd, "select");
      t.setRangeText(clipboard.text, t.selectionStart, t.selectionStart + clipboard.text.length, "end");
    } else {
      t.setRangeText(clipboard.text, t.selectionStart, t.selectionEnd, "end");
      t.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    }
    e.preventDefault();
  });
}

function paste() {
  textarea.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
}

/** A copy whose `clipboardData` Monaco's handler (on the textarea) fills. */
function copy(type: "copy" | "cut", monacoText: string) {
  let data = "";
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { setData: (_: string, v: string) => (data = v), getData: () => data },
  });
  textarea.addEventListener(type, (e) => (e as ClipboardEvent).clipboardData!.setData("text/plain", monacoText), {
    once: true,
  });
  textarea.dispatchEvent(event);
}

beforeEach(() => {
  wrapper = document.createElement("div");
  monacoNode = document.createElement("div");
  textarea = document.createElement("textarea");
  monacoNode.append(textarea);
  wrapper.append(monacoNode);
  document.body.append(wrapper);
  reachedMonaco = [];
  inputs = [];
  posted.length = 0;
  monacoNode.addEventListener("paste", () => reachedMonaco.push("paste"), true);
  textarea.addEventListener("input", (e) => inputs.push((e as InputEvent).inputType));
  release = bridgeSebClipboard(wrapper);
});

afterEach(() => {
  release?.();
  wrapper.remove();
  for (const [type, handler] of sebListeners.splice(0)) document.removeEventListener(type, handler, true);
  delete (globalThis as { SafeExamBrowser?: unknown }).SafeExamBrowser;
  delete (globalThis as { CefSharp?: unknown }).CefSharp;
});

/** The textarea holds "abcdef", the caret after "abc". */
function caretInMiddle() {
  textarea.value = "abcdef";
  textarea.setSelectionRange(3, 3);
}

describe("bridgeSebClipboard: paste", () => {
  it("a released SEB: redoes the write at the caret and fires one input event", () => {
    installSeb("released");
    (globalThis as { SafeExamBrowser?: Seb }).SafeExamBrowser!.clipboard.text = "XY";
    caretInMiddle();
    paste();
    expect(textarea.value).toBe("abcXYdef");
    expect(textarea.selectionStart).toBe(5);
    expect(inputs).toEqual(["insertFromPaste"]);
    expect(reachedMonaco).toEqual([]);
  });

  it("SEB master: keeps its write and its input event, adds none", () => {
    installSeb("master");
    (globalThis as { SafeExamBrowser?: Seb }).SafeExamBrowser!.clipboard.text = "XY";
    caretInMiddle();
    paste();
    expect(textarea.value).toBe("abcXYdef");
    expect(inputs).toEqual(["insertFromPaste"]);
    expect(reachedMonaco).toEqual([]);
  });

  it("outside SEB: touches nothing, Monaco gets the paste", () => {
    caretInMiddle();
    paste();
    expect(textarea.value).toBe("abcdef");
    expect(inputs).toEqual([]);
    expect(reachedMonaco).toEqual(["paste"]);
  });

  it("removes its listeners on cleanup", () => {
    release?.();
    release = undefined;
    installSeb("released");
    caretInMiddle();
    paste();
    expect(reachedMonaco).toEqual(["paste"]);
  });
});

describe("bridgeSebClipboard: copy and cut", () => {
  it.each(["copy", "cut"] as const)("%s: SEB's clipboard takes Monaco's text and is synced", (type) => {
    installSeb("released");
    // A backward selection Monaco's textarea does not mirror: SEB alone would copy "".
    textarea.value = "hello";
    textarea.setSelectionRange(2, 2);
    copy(type, "hello(1);");
    const { clipboard } = (globalThis as { SafeExamBrowser?: Seb }).SafeExamBrowser!;
    expect(clipboard.text).toBe("hello(1);");
    expect(clipboard.ranges).toEqual([]);
    expect(posted).toEqual([{ Type: "Clipboard", Id: "page", Content: btoa("hello(1);") }]);
  });

  it("keeps SEB's own copy when Monaco wrote nothing", () => {
    installSeb("released");
    textarea.value = "hello";
    textarea.setSelectionRange(0, 4);
    copy("copy", "");
    expect((globalThis as { SafeExamBrowser?: Seb }).SafeExamBrowser!.clipboard.text).toBe("hell");
    expect(posted).toEqual([]);
  });

  it("outside SEB: posts nothing", () => {
    const post = vi.fn();
    (globalThis as { CefSharp?: unknown }).CefSharp = { PostMessage: post };
    copy("copy", "x");
    expect(post).not.toHaveBeenCalled();
  });
});
