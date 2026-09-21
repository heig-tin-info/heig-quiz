import katex from "katex";
import { Keyboard } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useT } from "../i18n";
import { Button, cx, inputClass, Modal, Segmented, Spinner } from "../ui";
import "./formula.css";

/*
 * The one surface a formula is written on (teacher feedback, round 2: "the Σ
 * button asked me for LaTeX in a bar and I had no idea what to type").
 *
 * Two fields, one value. MathLive's `<math-field>` is a visual editor with
 * its own virtual keyboard — a novice builds a fraction by pressing a
 * fraction — and the LaTeX box below is the same formula as source, for the
 * teacher who already knows what they want. Either one edits the other, and
 * the KaTeX preview underneath is what the STUDENT will see, rendered by the
 * very renderer the player uses (`render.ts`).
 *
 * The LaTeX box takes the focus, not the visual field: the teachers of this
 * school write `\sqrt{2}` faster than they can find a square root on a
 * keyboard, and the one who cannot is the one who will look at the palette
 * anyway.
 *
 * MathLive is LAZY (`import("mathlive")` below, ~300 kB of web component): it
 * is the only thing in the editor chunk that a teacher who never writes a
 * formula would pay for, and it loads when this dialog opens, once per
 * session. Its fonts are the KaTeX fonts, under the very same family names,
 * and `katex.css` is already in the page (`main.tsx`) — so
 * `fontsDirectory = null` is not a degradation, it is the same twenty files
 * not fetched twice. `soundsDirectory = null` for the keypress sounds, which
 * nobody asked for.
 */

export interface Formula {
  latex: string;
  /** `$$…$$` on a line of its own, rather than `$…$` in the sentence. */
  display: boolean;
}

/** What MathLive's element exposes of itself, which is all this dialog uses. */
type MathField = HTMLElement & { value: string };

/**
 * MathLive publishes the virtual keyboard on `window`. It is read through a
 * local shape rather than the package's global augmentation: this module is
 * the only one that touches it, and a global `declare` for a lazily loaded
 * dependency is a type the rest of the app would carry for nothing.
 */
type VirtualKeyboard = { show: () => void; hide: () => void };
const virtualKeyboard = (): VirtualKeyboard | undefined =>
  (window as unknown as { mathVirtualKeyboard?: VirtualKeyboard }).mathVirtualKeyboard;

export function FormulaDialog({
  initial,
  /** An inline field (a choice) has nowhere to put a display block. */
  allowDisplay = true,
  onInsert,
  onCancel,
}: {
  initial: Formula;
  allowDisplay?: boolean;
  onInsert: (formula: Formula) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const latexId = useId();
  const visualId = useId();
  const [latex, setLatex] = useState(initial.latex);
  const [display, setDisplay] = useState(allowDisplay && initial.display);
  const [ready, setReady] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<MathField | null>(null);
  /*
   * The value the visual field last agreed on, so the effect that pushes the
   * LaTeX box into it does not fight the keystroke that came out of it: the
   * two are the same string, and writing it back would move MathLive's caret
   * to the end on every character.
   */
  const settled = useRef(initial.latex);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      /*
       * A runtime that cannot carry the web component leaves the LaTeX box and
       * the preview — the whole dialog minus its palette. That is not a
       * hypothetical: outside a browser the package resolves to its
       * server-side build, which exports no `MathfieldElement` at all, and a
       * test that opens this dialog must not fall over it.
       */
      const loaded = await import("mathlive").catch(() => null);
      const MathfieldElement = loaded?.MathfieldElement;
      if (cancelled || MathfieldElement === undefined || !host.current) return;
      MathfieldElement.fontsDirectory = null;
      MathfieldElement.soundsDirectory = null;
      const mf = new MathfieldElement({
        // The keyboard is summoned by the button below, never by the focus:
        // a dialog that grows a keyboard the moment it opens hides its own
        // preview.
        mathVirtualKeyboardPolicy: "manual",
      }) as unknown as MathField;
      mf.setAttribute("id", visualId);
      mf.setAttribute("aria-label", t("md.formula.visual"));
      mf.className = "block w-full";
      mf.value = settled.current;
      mf.addEventListener("input", () => {
        settled.current = mf.value;
        setLatex(mf.value);
      });
      // `appendChild`, never `replaceChildren`: this div is React's, and a
      // React-rendered sibling torn out from under it (the spinner) is a
      // `removeChild` crash on the next commit. The host holds nothing of
      // React's own — the spinner is its sibling, not its child.
      host.current.appendChild(mf);
      field.current = mf;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      field.current = null;
      // A virtual keyboard left showing would outlive the dialog that opened it.
      virtualKeyboard()?.hide();
    };
  }, [t, visualId]);

  /** The LaTeX box edited the formula: carry it into the visual field. */
  useEffect(() => {
    const mf = field.current;
    if (!mf || latex === settled.current) return;
    settled.current = latex;
    mf.value = latex;
  }, [latex]);

  const preview = useMemo(() => {
    if (latex.trim() === "") return null;
    try {
      return katex.renderToString(latex, {
        displayMode: display,
        throwOnError: false,
        output: "htmlAndMathml",
      });
    } catch {
      return null;
    }
  }, [latex, display]);

  const toggleKeyboard = () => {
    const vk = virtualKeyboard();
    if (!vk) return;
    if (keyboard) vk.hide();
    else {
      field.current?.focus();
      vk.show();
    }
    setKeyboard(!keyboard);
  };

  const submit = () => {
    const value = latex.trim();
    if (value === "") return;
    onInsert({ latex: value, display });
  };

  return (
    <Modal
      title={t("md.formula.title")}
      subtitle={t("md.formula.hint")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={latex.trim() === ""}>
            {t("md.formula.insert")}
          </Button>
        </>
      }
    >
      <div className="formula-dialog flex flex-col gap-4">
        {allowDisplay ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] font-medium text-fg">{t("md.formula.placement")}</span>
            <Segmented
              name="formula-placement"
              size="sm"
              value={display ? "display" : "inline"}
              onChange={(v) => setDisplay(v === "display")}
              options={[
                { value: "inline", label: t("md.formula.inline") },
                { value: "display", label: t("md.formula.display") },
              ]}
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={latexId} className="text-[13px] font-medium text-fg">
            {t("md.latex")}
          </label>
          <input
            id={latexId}
            autoFocus
            value={latex}
            spellCheck={false}
            placeholder={t("md.placeholder.math")}
            onChange={(e) => setLatex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              submit();
            }}
            className={cx(inputClass, "h-8.5 w-full font-mono text-[13px]")}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-fg">{t("md.formula.visual")}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!ready}
              aria-pressed={keyboard}
              onClick={toggleKeyboard}
            >
              <Keyboard className="size-3.5" />
              {t("md.formula.keyboard")}
            </Button>
          </div>
          <div className={cx(inputClass, "flex min-h-11 w-full items-center py-1.5")}>
            {ready ? null : <Spinner label={t("md.formula.loading")} className="py-1" />}
            {/* MathLive's own element lives in here, and React puts nothing
                inside: the two must not fight over the same children. */}
            <div ref={host} className="w-full" />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg">{t("md.formula.preview")}</span>
          <div className="md-body flex min-h-14 items-center justify-center overflow-x-auto rounded-field bg-surface-2 px-3 py-2">
            {preview === null ? (
              <span className="text-xs text-fg-faint">{t("md.formula.empty")}</span>
            ) : (
              <span data-testid="formula-preview" dangerouslySetInnerHTML={{ __html: preview }} />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
