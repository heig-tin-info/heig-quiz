import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cx } from "./layers";
import { Card } from "./page";

/**
 * A folded card (DESIGN.md › Components › Disclosure): a header row that is
 * one button — the title, a line saying what is inside, a chevron — over a
 * body drawn only while it is open. A settings page puts what a teacher
 * rarely touches in one, so the page reads short and the rarely-touched part
 * is still one click away, under a name that says what it holds.
 *
 * Folded by default and not persisted: a disclosure that remembers being
 * open is a disclosure that is always open, and then it is not a disclosure.
 *
 * The button is named by the title (and `aside`) only, the explanation is
 * its description: a screen reader hears "Conditions, 2 set, collapsed", not
 * the whole paragraph as a name. `aside` sits beside the title and stays in
 * view folded — a count of what is set inside, so a folded card never hides
 * that something is.
 *
 * The body is the card's own: `children` are stacked under a hairline,
 * divided by hairlines, with the card's 16 px gutter.
 */
export function Disclosure({
  title,
  desc,
  aside,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? `${id}-body` : undefined}
        aria-labelledby={`${id}-title`}
        aria-describedby={desc ? `${id}-desc` : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/70",
          open ? "rounded-t-card" : "rounded-card",
        )}
      >
        <span className="min-w-0 flex-1">
          <span id={`${id}-title`} className="flex items-center gap-2 text-sm font-medium text-fg">
            {title}
            {/* The space keeps the two words apart in the accessible name; the flex row drops it on screen. */}
            {aside ? <> {aside}</> : null}
          </span>
          {desc ? (
            <span id={`${id}-desc`} className="mt-0.5 block text-[13px] text-fg-muted">
              {desc}
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden
          className={cx("size-4 shrink-0 text-fg-faint transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div id={`${id}-body`} className="divide-y divide-line border-t border-line px-4">
          {children}
        </div>
      ) : null}
    </Card>
  );
}
