/**
 * Monaco under Safe Exam Browser's private clipboard (#1079).
 *
 * SEB on Windows, with the `enablePrivateClipboard` our `.seb` sets
 * (`@quiz/seb`), injects its `Clipboard.js` into every page. It listens to
 * `copy`, `cut` and `paste` on the document in the capture phase, cancels
 * them, and keeps its own clipboard in `SafeExamBrowser.clipboard`
 * (`text`, `ranges`, `id`, `getContentEncoded()`), synced to the host with
 * `CefSharp.PostMessage({ Type: "Clipboard", Id, Content })`. In a textarea:
 *
 * - **copy and cut** take `value.substring(selectionStart, selectionEnd)`.
 *   Monaco's hidden textarea does not mirror the editor's selection: a
 *   backward selection is collapsed there, a long one is trimmed to its two
 *   ends, an empty selection (Monaco copies the line) and the other cursors
 *   of a multi-cursor selection are not there at all;
 * - **paste** writes the text with `setRangeText`. The unreleased master
 *   (June 2026) inserts at the selection and fires an `input` event,
 *   `inputType: "insertFromPaste"`. The released versions (3.10.2, 3.10.3)
 *   fire none, so Monaco never learns of the change and overwrites it, and
 *   they replace as many characters after the caret as they insert.
 *
 * Monaco's own handlers run after SEB's and ignore its cancellation: its
 * copy and cut put the true selection in the event's `clipboardData`, and its
 * paste handlers insert the system clipboard a second time.
 *
 * {@link bridgeSebClipboard} reconciles the two on the element wrapping a
 * Monaco, between SEB (document, capture) and Monaco (its own container, in
 * the capture phase too, for the paste controller):
 *
 * 1. after a copy or cut, SEB's clipboard takes the text Monaco wrote in
 *    `clipboardData`, and is synced to the host as SEB's script does it;
 * 2. a paste SEB handled is stopped before Monaco's handlers. If SEB fired
 *    no `input` event (a released version), the textarea is put back as it
 *    was before SEB's write, the text inserted as master does, and the
 *    `input` event master would have fired is fired.
 *
 * Everything is gated on `SafeExamBrowser.clipboard`, which only SEB's script
 * creates: outside SEB nothing changes. The integrity journal listens on the
 * document, so it still sees every paste.
 */

interface SebClipboard {
  text: string;
  ranges: unknown[];
  id?: unknown;
  getContentEncoded?: () => string;
}

interface SebGlobals {
  SafeExamBrowser?: { clipboard?: SebClipboard };
  CefSharp?: { PostMessage?: (message: unknown) => void };
}

const sebGlobals = () => globalThis as SebGlobals;

/** SEB's private clipboard, when its `Clipboard.js` runs in this page. */
function sebClipboard(): SebClipboard | undefined {
  return sebGlobals().SafeExamBrowser?.clipboard;
}

/**
 * A ref for the element wrapping a Monaco. Returns the cleanup React 19 calls
 * when the element goes.
 */
export function bridgeSebClipboard(node: HTMLElement | null): (() => void) | undefined {
  if (node === null) return undefined;
  // Whether SEB fired its own `input` for the paste being handled.
  let pasteInput = false;
  // The textarea as it was before SEB's script touched it.
  let before: { target: HTMLTextAreaElement; value: string; start: number; end: number } | null =
    null;

  // On the window, in the capture phase: before SEB's listener on the document.
  const onPasteStart = (event: Event) => {
    pasteInput = false;
    const target = event.target;
    before =
      sebClipboard() !== undefined && target instanceof HTMLTextAreaElement && node.contains(target)
        ? { target, value: target.value, start: target.selectionStart, end: target.selectionEnd }
        : null;
  };

  const onInput = (event: Event) => {
    if ((event as InputEvent).inputType === "insertFromPaste") pasteInput = true;
  };

  const onPaste = (event: Event) => {
    const clipboard = sebClipboard();
    if (!event.defaultPrevented || clipboard === undefined) return;
    if (!pasteInput && before !== null && before.target === event.target) {
      // A released SEB: its write is redone as master does it, then notified.
      // (Theirs replaces as many characters after the caret as it inserts.)
      const { target, value, start, end } = before;
      target.value = value;
      target.setRangeText(clipboard.text, start, end, "end");
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    }
    event.stopPropagation();
  };

  const onCopy = (event: Event) => {
    const clipboard = sebClipboard();
    const data = (event as ClipboardEvent).clipboardData;
    if (!event.defaultPrevented || clipboard === undefined || !data) return;
    const text = data.getData("text/plain");
    // Monaco wrote nothing (a plain textarea while it loads): SEB's own copy stands.
    if (text === "") return;
    clipboard.text = text;
    clipboard.ranges = [];
    if (typeof clipboard.getContentEncoded === "function") {
      // SEB's encoder can throw on a very large copy; the page's own paste
      // already has `clipboard.text`, only the sync to other windows is lost.
      try {
        sebGlobals().CefSharp?.PostMessage?.({
          Type: "Clipboard",
          Id: clipboard.id,
          Content: clipboard.getContentEncoded(),
        });
      } catch {
        // Nothing to do: SEB's own copy has the same limit.
      }
    }
  };

  const view = node.ownerDocument.defaultView;
  view?.addEventListener("paste", onPasteStart, true);
  node.addEventListener("input", onInput, true);
  node.addEventListener("paste", onPaste, true);
  // Bubble phase: after Monaco's handler filled `clipboardData`.
  node.addEventListener("copy", onCopy);
  node.addEventListener("cut", onCopy);
  return () => {
    view?.removeEventListener("paste", onPasteStart, true);
    node.removeEventListener("input", onInput, true);
    node.removeEventListener("paste", onPaste, true);
    node.removeEventListener("copy", onCopy);
    node.removeEventListener("cut", onCopy);
  };
}
