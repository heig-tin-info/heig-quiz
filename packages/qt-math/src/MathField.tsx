/**
 * The one-line math field the editor (a key) and the player (the answer)
 * both write in: MathLive's `<math-field>`, rendered as you type, with its
 * virtual keyboard on a touch screen — and, where the web component does
 * not exist (a runtime without a DOM, where the package resolves to its
 * server build), a plain LaTeX input, so the surface is never blank. The
 * value is LaTeX either way: what the field holds is what is stored and
 * what the parser reads (ADR-102).
 *
 * Imperative on purpose, as `apps/web`'s formula dialog is: the element is
 * appended to a host `<div>` React never writes into, and removed on
 * cleanup. The font files are KaTeX's, already on the page, so
 * `fontsDirectory = null` fetches nothing twice. The surfaces that mount
 * this are `React.lazy` already, so MathLive's weight (~300 kB) rides in
 * their chunk and the host's Suspense covers the load.
 */
import * as mathlive from "mathlive";
import { useEffect, useRef } from "react";

import { cx, TextInput } from "@quiz/ui";

/** What MathLive's element exposes of itself, which is all this field uses. */
type Mathfield = HTMLElement & { value: string; readOnly: boolean; menuItems: readonly unknown[] };
/**
 * The constructor, named structurally: under Node's resolution the package
 * types are its server build's, which exports no element — the case the
 * fallback below is for.
 */
type MathfieldConstructor = {
  new (options?: { mathVirtualKeyboardPolicy?: "auto" | "manual" | "sandboxed" }): HTMLElement;
  fontsDirectory: string | null;
  soundsDirectory: string | null;
};
const MathfieldElement = (mathlive as { MathfieldElement?: MathfieldConstructor }).MathfieldElement;

type VirtualKeyboard = { hide: () => void };
const virtualKeyboard = (): VirtualKeyboard | undefined =>
  (globalThis as unknown as { mathVirtualKeyboard?: VirtualKeyboard }).mathVirtualKeyboard;

export function MathField({
  id,
  value,
  onChange,
  locked = false,
  ariaLabel,
  latexLabel,
  className,
}: {
  id: string;
  value: string;
  onChange: (latex: string) => void;
  locked?: boolean | undefined;
  ariaLabel: string;
  /** What the fallback input is called, beside `ariaLabel` ("LaTeX"). */
  latexLabel: string;
  className?: string | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<Mathfield | null>(null);
  /** The value the element last agreed on, so the prop never rewrites the keystroke it came from. */
  const settled = useRef(value);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    if (MathfieldElement === undefined || !host.current) return;
    MathfieldElement.fontsDirectory = null;
    MathfieldElement.soundsDirectory = null;
    const mf = new MathfieldElement({ mathVirtualKeyboardPolicy: "auto" }) as unknown as Mathfield;
    mf.setAttribute("id", id);
    mf.className = "block w-full";
    // The box around it is this component's: no second border, no second
    // focus ring. The keyboard toggle inside the field is MathLive's own.
    mf.style.border = "0";
    mf.style.outline = "none";
    mf.style.background = "transparent";
    mf.value = settled.current;
    mf.addEventListener("input", () => {
      settled.current = mf.value;
      change.current(mf.value);
    });
    host.current.appendChild(mf);
    // Only once mounted: MathLive refuses the setter on a detached element.
    mf.menuItems = [];
    field.current = mf;
    return () => {
      field.current = null;
      mf.remove();
      virtualKeyboard()?.hide();
    };
  }, [id]);

  useEffect(() => {
    field.current?.setAttribute("aria-label", ariaLabel);
  }, [ariaLabel]);

  useEffect(() => {
    const mf = field.current;
    if (!mf || value === settled.current) return;
    settled.current = value;
    mf.value = value;
  }, [value]);

  useEffect(() => {
    if (field.current) field.current.readOnly = locked;
  }, [locked]);

  if (MathfieldElement === undefined) {
    return (
      <TextInput
        id={id}
        aria-label={`${ariaLabel} (${latexLabel})`}
        className={cx("w-full font-mono", className)}
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={locked}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div
      onMouseDown={(event) => {
        const mf = field.current;
        if (mf === null || (event.target instanceof Node && mf.contains(event.target))) return;
        event.preventDefault();
        mf.focus();
      }}
      className={cx(
        "flex min-h-10 min-w-0 cursor-text items-center rounded-control border border-line bg-surface px-3 py-1.5 transition-colors focus-within:border-accent",
        locked && "opacity-60",
        className,
      )}
    >
      <div ref={host} className="w-full" />
    </div>
  );
}
