import { PenLine } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

import { cx, HelpIcon, Tip, type IconType } from "./layers";
import { rovingIndex } from "./menu";

// Surfaces and page structure.

/**
 * A page of one narrow card centered on the screen, with no shell around it:
 * the doors reached from outside the app — a poll's QR code, an assistant's
 * consent, the Teams link and the Teams tab.
 */
export function GateFrame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-115 flex-col justify-center px-4 py-10">{children}</main>
  );
}

export function Card({
  children,
  className = "",
  interactive,
  onClick,
  ...rest
}: React.ComponentProps<"div"> & {
  children: ReactNode;
  className?: string;
  /** Clickable surface: hairline darkens on hover, no movement. */
  interactive?: boolean;
}) {
  return (
    <div
      {...rest}
      onClick={onClick}
      className={cx(
        "rounded-card border border-line bg-surface",
        interactive && "cursor-pointer transition-colors duration-150 hover:border-line-strong hover:bg-surface-2/40",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A note set inside a card: a 12 px uppercase eyebrow naming it ("Explanation",
 * "Comment", "Reference solution") over its body, in a field-radius panel
 * with 12 px of padding and 4 px between the eyebrow and the body.
 *
 * `soft` (a `surface-2` recess) is for what the product says — an
 * explanation, a key; `outlined` (a `line-strong` hairline on `surface`) is
 * for what a person wrote to this reader — a teacher's comment. DESIGN.md ›
 * Components › NotePanel.
 */
export function NotePanel({
  eyebrow,
  tone = "soft",
  children,
}: {
  eyebrow: ReactNode;
  tone?: "soft" | "outlined";
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-field p-3",
        tone === "soft" ? "bg-surface-2" : "border border-line-strong bg-surface",
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">{eyebrow}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** Title row of a page: one h1, an optional line under it, the actions right. */
export function PageHeader({
  eyebrow,
  title,
  description,
  help,
  actions,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Help topic (`src/help/<topic>.md`) opened by a "?" beside the title. */
  help?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 text-[13px] text-fg-muted">{eyebrow}</div> : null}
        <h1 className="flex items-center gap-2 text-[28px] font-bold leading-tight tracking-[-0.02em]">
          <span className="min-w-0">{title}</span>
          {/* `HelpIcon` carries its own `shrink-0` and its own placement on
              the line: a title says WHICH topic, never where the "?" goes. */}
          {help ? <HelpIcon topic={help} coach="page.help" /> : null}
        </h1>
        {description ? <div className="mt-1.5 text-sm text-fg-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * The way back up, in a `PageHeader` eyebrow: the parent's name as a quiet
 * link. The eyebrow already sets the 13 px `fg-muted` text, so the link adds
 * only what a link needs — `fg` and an underline on hover, reached in the
 * 120–150 ms colour transition every hover uses. `tip` explains a name that
 * does not say what it leads to (the results page shows the evaluation's
 * title and leads to its classroom).
 */
export function ParentLink({
  onClick,
  tip,
  children,
}: {
  onClick: () => void;
  tip?: string;
  children: ReactNode;
}) {
  return (
    <Tip label={tip}>
      <button
        type="button"
        onClick={onClick}
        className="transition-colors hover:text-fg hover:underline"
      >
        {children}
      </button>
    </Tip>
  );
}

/**
 * A heading that renames itself where it stands.
 *
 * Renaming used to be a line in an overflow menu that opened a modal holding
 * ONE field — three clicks and a layer for a word. Here the title IS the
 * control: a real `<button>` (so Enter, Space and F2 all reach it, and it has
 * an accessible name that says what pressing it does) which swaps itself for
 * an `<input>` drawn at the heading's own size and weight, so nothing on the
 * line moves. Enter or blur saves, Escape cancels, and a title trimmed to
 * nothing is refused — the old one comes back, because an untitled evaluation
 * is not a thing the product has.
 *
 * The pencil is the discovery: it fades in on hover and on keyboard focus,
 * and it is `aria-hidden` — the button already says "rename" out loud. The
 * button keeps a transparent border so that the swap to the input, which has
 * a real one, does not shift the text by a pixel.
 *
 * It is not a primary action and never takes the accent (DESIGN.md): the
 * primary of the screen it sits on stays what it is.
 *
 * `pending` is the title a save is carrying, shown in place of `value` until
 * the caller's refetch lands: the old title coming back for a frame reads as
 * a failed save. The evaluation, the template, the classroom and the course
 * all rename through this one component.
 */
export function EditableTitle({
  value,
  pending,
  onSave,
  editLabel,
  inputLabel,
  className = "",
}: {
  value: string;
  /** The title a save in flight carries, if any (the mutation's variables). */
  pending?: string | undefined;
  /** Called with the trimmed new title, only when it is non-empty and different. */
  onSave: (next: string) => void;
  /** Accessible name of the button, e.g. `Rename evaluation: Test 0`. */
  editLabel: string;
  /** Accessible name of the input, e.g. `Title`. */
  inputLabel: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Enter and blur both land on `finish`, and Escape unmounts an input whose
  // blur may still be on its way. One latch per edit, so the second call is a
  // no-op instead of a second save.
  const done = useRef(true);

  const open = () => {
    setDraft(value);
    done.current = false;
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft.trim();
    if (save && next !== "" && next !== value) onSave(next);
  };

  const type = "text-[28px] font-bold leading-tight tracking-[-0.02em]";

  if (editing) {
    /*
     * The field grows with what is typed instead of taking the whole line: a
     * `w-full` input pushed the state badge onto a second row the moment the
     * editor opened, which is the jump this component exists to avoid. The
     * mirror span sets the grid column to the text's own width, the input
     * lies on top of it, and `max-w-full` keeps a long title inside the
     * header on a phone.
     */
    return (
      <span className={cx("-mx-1.5 inline-grid max-w-full min-w-0 align-baseline", className)}>
        <span
          aria-hidden
          className={cx(
            "invisible col-start-1 row-start-1 min-w-24 overflow-hidden whitespace-pre px-1.5",
            type,
          )}
        >
          {draft}
        </span>
        <input
          aria-label={inputLabel}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              finish(false);
            }
          }}
          className={cx(
            "col-start-1 row-start-1 w-full min-w-0 rounded-field border border-accent bg-surface px-1.5 text-fg outline-none ring-3 ring-accent/20",
            type,
          )}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={editLabel}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "F2") {
          e.preventDefault();
          open();
        }
      }}
      className={cx(
        // Not a flex row: a long title WRAPS on a phone rather than being cut
        // short, and an inline pencil then trails its last line instead of
        // floating beside the block.
        "group -mx-1.5 max-w-full rounded-field border border-transparent px-1.5 text-left break-words transition-colors hover:border-line hover:bg-surface-2 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent/20",
        type,
        className,
      )}
    >
      {pending ?? value}
      <PenLine
        aria-hidden
        className="ml-2 inline-block size-4 -translate-y-0.5 align-middle text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}

/** Heading of a section inside a page or a card (h2 at 16 px). */
export function SectionHeading({
  icon: Icon,
  title,
  count,
  description,
  help,
  actions,
  className = "",
}: {
  icon?: IconType;
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  help?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? <Icon className="size-4 text-fg-faint" /> : null}
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        {count != null ? <span className="text-sm tabular-nums text-fg-faint">{count}</span> : null}
        {help ? <HelpIcon topic={help} /> : null}
      </div>
      {description ? <p className="basis-full text-sm text-fg-muted sm:basis-auto">{description}</p> : null}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Key figure: a small label over a large tabular number. */
export function Stat({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconType;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        {Icon ? <Icon className="size-3.5 text-fg-faint" /> : null}
        {label}
      </p>
      <p className="mt-1 text-[22px] font-bold leading-none tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1.5 text-xs text-fg-faint">{hint}</p> : null}
    </div>
  );
}

/** Width of the fade drawn over a scrollable edge of a strip. */
const TAB_FADE = "36px";

/**
 * Which edges of a horizontal scroller still hide content. One pixel of
 * tolerance absorbs the fractional scroll positions a zoomed or
 * high-density viewport produces. Pure: this is the part worth testing.
 */
export function scrollEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { left: boolean; right: boolean } {
  return {
    left: scrollLeft > 1,
    right: scrollLeft + clientWidth < scrollWidth - 1,
  };
}

/**
 * Fades whichever edge of a horizontal scroller still hides content, so a
 * strip never simply stops at the screen edge (Tabs, the player's stepper).
 * `shape` is anything that changes when the content does: the edges are
 * measured from the rendered strip, not from a count.
 */
export function useScrollFade(
  strip: RefObject<HTMLElement | null>,
  shape: string,
): CSSProperties | undefined {
  const [edges, setEdges] = useState({ left: false, right: false });
  // Layout effect: measuring after paint would show one unfaded frame.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const update = () =>
      setEdges((prev) => {
        const next = scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
        // Same edges, same object: a fresh one would re-render on every scroll.
        return prev.left === next.left && prev.right === next.right ? prev : next;
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => el.removeEventListener("scroll", update);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [strip, shape]);
  if (!edges.left && !edges.right) return undefined;
  // A mask, not an overlay: it fades whatever the strip holds without laying a
  // canvas-coloured rectangle over it, which would be wrong in dark mode.
  const mask = `linear-gradient(to right, transparent 0, #000 ${edges.left ? TAB_FADE : "0px"}, #000 calc(100% - ${edges.right ? TAB_FADE : "0px"}), transparent 100%)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * Text tabs with an ink underline; counts sit in `fg-faint`.
 * Roving tabindex: only the selected tab is in the Tab order, ArrowLeft and
 * ArrowRight move and select with wrap, Home and End jump to the ends.
 * Give `idPrefix` ONLY when the panels are rendered through `TabPanel` with
 * the same prefix: each tab then carries `id="<prefix>-tab-<value>"` and
 * `aria-controls="<prefix>-panel-<value>"`, and `TabPanel` is what makes those
 * ids resolve. Without panels, leave `idPrefix` out — an `aria-controls`
 * pointing at nothing is worse than no `aria-controls` at all (W2).
 *
 * On a narrow viewport the strip scrolls: the hidden side is faded out so the
 * fourth tab announces itself instead of just ending at the screen edge, and
 * scroll snapping stops a drag between two tabs.
 */
export function Tabs<V extends string>({
  value,
  onChange,
  items,
  className = "",
  idPrefix,
  label,
}: {
  value: V;
  onChange: (v: V) => void;
  /** `coach` names the tab as a coach mark's anchor (`coach/catalog.ts`). */
  items: { value: V; label: string; count?: number; icon?: IconType; coach?: string }[];
  className?: string;
  idPrefix?: string;
  /** Accessible name of the tablist when the surrounding heading is not enough. */
  label?: string;
}) {
  const refs = useRef<Partial<Record<V, HTMLButtonElement | null>>>({});
  const strip = useRef<HTMLDivElement>(null);
  const selected = items.findIndex((it) => it.value === value);
  /**
   * Which tab holds the roving tabindex. A `value` matching no item (a hand
   * edited `?tab=` in the URL) used to leave every tab at `tabIndex={-1}`,
   * which took the whole strip out of the Tab order; the first tab stands in.
   */
  const roving = selected >= 0 ? selected : 0;
  // The fade is measured from the rendered strip, so it has to be recomputed
  // whenever the labels or the counts change, not only their number.
  const mask = useScrollFade(
    strip,
    items.map((it) => `${it.value}\u0000${it.label}\u0000${it.count ?? ""}`).join("|"),
  );
  const onKeyDown = (e: React.KeyboardEvent) => {
    const next = rovingIndex(e.key, roving, items.length);
    if (next === null) return;
    e.preventDefault();
    const target = items[next];
    if (!target) return;
    onChange(target.value);
    refs.current[target.value]?.focus();
  };
  return (
    // The hairline lives on the wrapper, so the mask fades the tabs without
    // eating the border that separates them from the panel below.
    <div className={cx("border-b border-line", className)}>
      <div
        ref={strip}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        // `overflow-y-hidden` on top of the horizontal scroll: the active tab
        // hangs one pixel below the strip (`-mb-px`, so its indicator covers
        // the hairline), and an `overflow-x-auto` strip alone answers that
        // pixel with a vertical scrollbar on hosts that draw them.
        className="flex snap-x snap-proximity gap-1 overflow-x-auto overflow-y-hidden"
        style={mask}
      >
        {items.map((it, i) => {
          const Icon = it.icon;
          const active = it.value === value;
          return (
            <button
              key={it.value}
              ref={(el) => {
                refs.current[it.value] = el;
              }}
              type="button"
              role="tab"
              id={idPrefix ? `${idPrefix}-tab-${it.value}` : undefined}
              // Only the selected tab points at a panel: the consumers render
              // one panel at a time, and `aria-controls` on the other three
              // would name ids no element carries (W2).
              aria-controls={idPrefix && active ? `${idPrefix}-panel-${it.value}` : undefined}
              aria-selected={active}
              data-coach={it.coach}
              tabIndex={i === roving ? 0 : -1}
              onClick={() => onChange(it.value)}
              className={cx(
                "relative -mb-px inline-flex h-10 shrink-0 snap-start items-center gap-1.5 px-3 text-sm font-medium transition-colors",
                active ? "text-fg" : "text-fg-muted hover:text-fg",
                active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fg",
              )}
            >
              {Icon ? <Icon className="size-4" /> : null}
              {it.label}
              {it.count != null ? (
                <span className={cx("text-xs tabular-nums", active ? "text-fg-muted" : "text-fg-faint")}>
                  {it.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The panel a `Tabs` strip points at. It exists because `aria-controls` is a
 * promise: a tab announcing `question-panel-edit` to a document that holds no
 * such element tells a screen reader to go somewhere that is not there (W2).
 *
 * `idPrefix` and `value` are the same two strings the strip was given, so the
 * ids line up by construction. `tabIndex={-1}` makes it a focus target
 * without putting it in the Tab order: a shortcut that switches tabs
 * (`Ctrl+Enter` in the question editor) moves the reader into the panel it
 * just opened, which is the whole point of switching.
 */
export function TabPanel({
  idPrefix,
  value,
  children,
  className = "",
  ref,
}: {
  idPrefix: string;
  value: string;
  children: ReactNode;
  className?: string;
  ref?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={ref}
      id={`${idPrefix}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${idPrefix}-tab-${value}`}
      tabIndex={-1}
      className={cx("focus:outline-none", className)}
    >
      {children}
    </div>
  );
}

/**
 * Makes every `<pre>` rendered inside it reachable with the keyboard (W10).
 *
 * A code block that scrolls sideways and holds nothing focusable is invisible
 * to a keyboard: at 390 px a student cannot read past the fold. The blocks in
 * question are emitted by the question-type packages (`qt-code`'s review and
 * player), which this app hosts rather than owns, so the fix is applied here,
 * on the rendered DOM, instead of being duplicated in every package.
 *
 * A MutationObserver and not a plain effect: the packages load lazily behind
 * a `Suspense` INSIDE this subtree, so the tree fills long after this
 * component's last render and an effect here would have run against an empty
 * div. Anything that scrolls sideways gets the `tabindex` axe asks for; a
 * `<pre>` also gets a named group, because a code block is worth announcing
 * and a table wrapper is not.
 */
export function ScrollableCode({
  label,
  children,
  className = "",
}: {
  /** Accessible name of each block, e.g. `t("markdown.codeBlock")`. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const mark = () => {
      for (const el of Array.from(
        root.querySelectorAll<HTMLElement>("pre, .overflow-x-auto"),
      )) {
        if (el.getAttribute("tabindex") !== null) continue;
        el.setAttribute("tabindex", "0");
        if (el.tagName !== "PRE") continue;
        // `group`, not `region`: see `markdown/render.ts` — two identically
        // named landmarks on one page are worse than none.
        el.setAttribute("role", "group");
        // A block the package already named keeps its name: "Locked —
        // provided code" says more than "Code block" ever will.
        if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", label);
      }
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [label]);
  return (
    <div ref={host} className={className}>
      {children}
    </div>
  );
}
