/**
 * seb-workbench.js — Safe Exam Browser support inside the workspace's VS Code
 * page (#1149 copy and paste, #1151 battery).
 *
 * Loaded by code-server's workbench page: the Containerfile (step 2c) copies
 * this file beside `workbench.js` and adds a classic `<script src>` to
 * `workbench.html`, before `</head>`, so it runs before the workbench. Same
 * origin, so the page's CSP (`script-src 'self' …`) allows it. The extension
 * host cannot do any of this: it runs on the server, never in the page.
 *
 * What SEB does (SEB Windows 3.10.x, `Clipboard.js`, injected into every
 * frame when the clipboard is isolated, the default of our `.seb`): it
 * listens to `copy`, `cut` and `paste` on the document in the capture phase,
 * cancels them, keeps its own clipboard in `SafeExamBrowser.clipboard`
 * (`text`, `ranges`, `id`, `getContentEncoded()`), synced to the host with
 * `CefSharp.PostMessage({ Type: "Clipboard", Id, Content })`, and empties the
 * Windows clipboard every 50 ms. Its paste writes with `setRangeText` into
 * whatever has one (a textarea, a text input), without an `input` event and,
 * in the released versions, over as many characters after the caret as it
 * inserts; anything else gets the text only if it is contenteditable.
 *
 * What breaks in VS Code: its editors use EditContext (a `div` that is no
 * textarea), and read the pasted text from the event's `clipboardData`, which
 * SEB leaves empty: nothing is pasted. Its terminal and its context menus
 * read and write through `navigator.clipboard`, that is the emptied Windows
 * clipboard. Its find, quick open and other inputs get SEB's text but no
 * `input` event, so the search does not run.
 *
 * What this file does, only while `SafeExamBrowser.clipboard` exists — read
 * at each event, never cached, since SEB injects its scripts after the page
 * loads. Outside SEB every handler returns at once and nothing changes:
 *
 * 1. paste (window, capture phase, so before SEB's listener on the document):
 *    - into an editor (an element with an EditContext) or the terminal (an
 *      element inside `.xterm`, whose paste handler reads `clipboardData`):
 *      the event is stopped and a new `paste` event, carrying SEB's text in
 *      its `clipboardData`, is dispatched on the same target; the editor or
 *      the terminal pastes it. Our own event is recognised and let through.
 *      SEB's document listener sees that second event too (nothing can skip
 *      it) and cancels it, which neither component looks at: SEB writes
 *      nothing into the EditContext `div` (no `setRangeText`, no
 *      contenteditable around it), and the terminal empties its textarea
 *      after reading `clipboardData`;
 *    - into a text field (textarea, text input): the event is stopped, SEB's
 *      text is inserted at the selection and an `input` event is fired, as
 *      SEB's unreleased master does it;
 *    - anything else (a contenteditable): SEB's own handling stands.
 * 2. copy and cut (window, bubble phase, after the editor or the terminal
 *    filled `clipboardData`): that text becomes SEB's clipboard and is posted
 *    to the host, as SEB's script does. A cut in a text field, where SEB
 *    deleted the selection itself, is announced with an `input` event.
 * 3. `navigator.clipboard.readText` and `writeText` read and write SEB's
 *    clipboard (the terminal's Ctrl+V and copy, the context menus' Paste).
 *
 * Battery (#1151), only inside SEB (its user agent carries `SEB/<version>`,
 * the rule of apps/web's `inSebBrowser`) and when the browser has
 * `navigator.getBattery`: SEB hides Windows' taskbar, so a laptop's charge is
 * out of sight during an exam. A small button in the middle of the status
 * bar (`#workbench.parts.statusbar`, the part's id; the page's body when it
 * is missing) shows the charge and whether it charges; a click shows or hides
 * the local time and the remaining time.
 *
 * Plain JavaScript, no dependency, no build step. Tested by
 * `src/seb/sebWorkbench.test.ts`, which loads this file with a `module`
 * object: the file then exports `install` instead of running it.
 */
"use strict";

(function () {
  /** Refresh of the clock and of the remaining time. */
  const TICK_MS = 30_000;

  /**
   * The workspace UI's language, French when it starts with "fr", as the
   * status bar extension does. French is not reached today: the image ships
   * no language pack, so VS Code's language is always "en" (extension.js).
   */
  const STRINGS = {
    en: {
      percent: (n) => `${n}%`,
      charging: "charging",
      full: (d) => `full in ${d}`,
      left: (d) => `${d} left`,
      label: (n, charging) => `Battery ${n}%${charging ? ", charging" : ""}`,
      tooltip: "Battery. Click to show or hide the time.",
    },
    fr: {
      percent: (n) => `${n} %`,
      charging: "en charge",
      full: (d) => `pleine dans ${d}`,
      left: (d) => `${d} restantes`,
      label: (n, charging) => `Batterie ${n} %${charging ? ", en charge" : ""}`,
      tooltip: "Batterie. Cliquez pour afficher ou masquer l'heure.",
    },
  };

  function install(win) {
    const sebClipboard = () => win.SafeExamBrowser?.clipboard;
    // The paste events this file dispatches, let through untouched.
    const ours = new WeakSet();

    /**
     * SEB's clipboard takes `text`, and the host is told, as SEB's script does.
     * The same sync as Quiz's own Monaco bridge (packages/qt-code/src/sebClipboard.ts):
     * keep both in step; no build is shared between the image and the packages.
     */
    function toSeb(clipboard, text) {
      clipboard.text = text;
      clipboard.ranges = [];
      if (typeof clipboard.getContentEncoded !== "function") return;
      // SEB's encoder can throw on a very large text; its own copy has the same limit.
      try {
        win.CefSharp?.PostMessage?.({ Type: "Clipboard", Id: clipboard.id, Content: clipboard.getContentEncoded() });
      } catch {
        // Nothing to do: the page's own paste already has the text.
      }
    }

    /** A textarea or text input, whose selection `setRangeText` can replace. */
    function isTextField(el) {
      return (
        (el instanceof win.HTMLTextAreaElement || el instanceof win.HTMLInputElement) &&
        typeof el.selectionStart === "number"
      );
    }

    /** Who should receive a paste: the component's own handler, the field, or SEB. */
    function pasteRoute(el) {
      if (el.editContext || el.closest(".xterm")) return "component";
      if (isTextField(el)) return "field";
      return "seb";
    }

    win.addEventListener(
      "paste",
      (event) => {
        const clipboard = sebClipboard();
        const target = event.target;
        if (!clipboard || ours.has(event) || !(target instanceof win.Element)) return;
        const route = pasteRoute(target);
        if (route === "seb") return;
        event.stopImmediatePropagation();
        event.preventDefault();
        const text = String(clipboard.text ?? "");
        if (route === "field") {
          if (target.readOnly || target.disabled) return;
          target.setRangeText(text, target.selectionStart, target.selectionEnd, "end");
          target.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
          return;
        }
        const data = new win.DataTransfer();
        data.setData("text/plain", text);
        const paste = new win.ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        ours.add(paste);
        target.dispatchEvent(paste);
      },
      true,
    );

    // Same sync as qt-code's `onCopy` (packages/qt-code/src/sebClipboard.ts); keep in step.
    const onCopy = (event) => {
      const clipboard = sebClipboard();
      if (!clipboard || !event.defaultPrevented) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text !== "") {
        toSeb(clipboard, text);
      } else if (event.type === "cut" && isTextField(event.target)) {
        // SEB copied and deleted the selection itself; the field's owner is told.
        event.target.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "deleteByCut" }));
      }
    };
    win.addEventListener("copy", onCopy);
    win.addEventListener("cut", onCopy);

    const api = win.navigator.clipboard;
    if (api) {
      const readText = api.readText;
      const writeText = api.writeText;
      api.readText = function () {
        const clipboard = sebClipboard();
        return clipboard ? Promise.resolve(String(clipboard.text ?? "")) : readText.apply(api, arguments);
      };
      api.writeText = function (text) {
        const clipboard = sebClipboard();
        if (!clipboard) return writeText.apply(api, arguments);
        toSeb(clipboard, String(text));
        return Promise.resolve();
      };
    }

    if (/\bSEB\b/.test(win.navigator.userAgent)) showBattery(win);
  }

  function duration(seconds) {
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  }

  /** The battery button. */
  function showBattery(win) {
    if (typeof win.navigator.getBattery !== "function") return;
    const doc = win.document;

    win.navigator
      .getBattery()
      .then((battery) => {
        let expanded = false;
        const button = doc.createElement("button");
        button.type = "button";
        button.id = "heig-seb-battery";
        // Never takes the focus from the editor or the terminal.
        button.tabIndex = -1;
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          expanded = !expanded;
          render();
        });
        button.style.cssText = [
          "position:fixed",
          "bottom:0",
          "left:50%",
          "transform:translateX(-50%)",
          "z-index:10",
          "height:22px",
          "line-height:22px",
          "margin:0",
          "padding:0 8px",
          "border:0",
          "border-radius:0",
          "font:inherit",
          "font-size:12px",
          "white-space:nowrap",
          "cursor:pointer",
        ].join(";");

        function render() {
          const language = String(win._VSCODE_NLS_LANGUAGE || "en").toLowerCase();
          const t = language.startsWith("fr") ? STRINGS.fr : STRINGS.en;
          const pct = Math.round(battery.level * 100);
          const level = battery.charging ? "ok" : pct <= 10 ? "error" : pct <= 20 ? "warning" : "ok";
          let text = `\u{1F50B} ${t.percent(pct)}${battery.charging ? " ⚡" : ""}`;
          if (expanded) {
            const time = new Date().toLocaleTimeString(language.startsWith("fr") ? "fr-CH" : "en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            });
            const rest = battery.charging
              ? Number.isFinite(battery.chargingTime) && battery.chargingTime > 0
                ? t.full(duration(battery.chargingTime))
                : t.charging
              : Number.isFinite(battery.dischargingTime)
                ? t.left(duration(battery.dischargingTime))
                : "";
            text += ` · ${time}${rest ? ` · ${rest}` : ""}`;
          }
          button.textContent = text;
          button.title = t.tooltip;
          button.setAttribute("aria-label", t.label(pct, battery.charging));
          button.setAttribute("aria-expanded", String(expanded));
          button.dataset.level = level;
          button.style.color =
            level === "ok"
              ? "var(--vscode-statusBar-foreground, inherit)"
              : `var(--vscode-statusBarItem-${level}Foreground, #fff)`;
          button.style.background =
            level === "ok"
              ? "transparent"
              : `var(--vscode-statusBarItem-${level}Background, ${level === "error" ? "#c72e0f" : "#b27c00"})`;
          // The status bar holds the theme's colours.
          const parent = doc.getElementById("workbench.parts.statusbar") ?? doc.body;
          if (parent && button.parentElement !== parent) parent.appendChild(button);
        }

        render();
        // The workbench builds its status bar after this script runs: a few
        // early renders move the button into it without waiting for the tick.
        for (const ms of [500, 2000, 5000]) win.setTimeout(render, ms);
        for (const type of ["levelchange", "chargingchange", "chargingtimechange", "dischargingtimechange"]) {
          battery.addEventListener(type, render);
        }
        win.setInterval(render, TICK_MS);
      })
      .catch(() => {
        // No battery information: no button.
      });
  }

  if (typeof module === "object" && module !== null) {
    module.exports = { install };
  } else {
    install(window);
  }
})();
