/**
 * The way back up, as a trail (`Courses › Classroom › Project`), in a
 * `PageHeader` eyebrow. Ancestors are real links (a long press or a modified
 * click opens the address) that the app routes itself on a plain click; the
 * last item is the page, `aria-current="page"`. The separator is decoration.
 * From `sm` up the trail keeps one line: ancestors shrink and truncate, the
 * current page keeps the most room. Below `sm` it is just the way back, one
 * link to the immediate parent (`‹ Parent`, named by `backLabel`): a full
 * trail is unreadable at 390 px, and the page's own heading sits right
 * below. A `location` trail (a path navigated inside a page, the pool's
 * concept map) has no heading below it: its current item is
 * `aria-current="location"` and stays beside the way back on a phone.
 * Imports the base layer and `controls`.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { cx } from "@quiz/ui";
import { isPlainClick } from "./controls";

export interface BreadcrumbItem {
  label: string;
  /** The ancestor's real address; absent on the last item. */
  href?: string;
  onNavigate?: () => void;
}

export function Breadcrumb({
  label,
  backLabel,
  items,
  current = "page",
}: {
  label: string;
  /** The accessible name of the phone's back link, from the parent's name ("Back to PRG1"). */
  backLabel: (parent: string) => string;
  items: readonly BreadcrumbItem[];
  /** What the last item is: the page (the default), or a location within it, kept visible on a phone. */
  current?: "page" | "location";
}) {
  const parent = items.length > 1 ? items[items.length - 2] : undefined;
  const compact = parent?.href !== undefined;
  // On a phone: the way back alone, or with the current location beside it.
  const phoneHides = compact ? "max-sm:hidden" : undefined;
  const keepsLast = current === "location";
  return (
    <nav aria-label={label} className={keepsLast ? "flex min-w-0 items-center gap-2" : undefined}>
      {compact ? (
        <a
          href={parent.href}
          aria-label={backLabel(parent.label)}
          className="flex min-w-0 shrink-[3] items-center gap-1 transition-colors hover:text-fg hover:underline sm:hidden"
          onClick={(e) => {
            if (!parent.onNavigate || !isPlainClick(e)) return;
            e.preventDefault();
            parent.onNavigate();
          }}
        >
          <ChevronLeft aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
          <span className="truncate">{parent.label}</span>
        </a>
      ) : null}
      <ol className={cx("flex min-w-0 items-center gap-1.5", !keepsLast && phoneHides)}>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={i}>
              {i > 0 ? (
                <li aria-hidden className={cx("flex shrink-0", keepsLast && phoneHides)}>
                  <ChevronRight className="size-3.5 text-fg-faint" />
                </li>
              ) : null}
              <li className={last ? "min-w-0 shrink" : cx("min-w-0 shrink-[3]", keepsLast && phoneHides)}>
                {last || item.href === undefined ? (
                  <span aria-current={last ? current : undefined} className={last ? "block truncate text-fg" : "block truncate"}>
                    {item.label}
                  </span>
                ) : (
                  <a
                    href={item.href}
                    className="block truncate transition-colors hover:text-fg hover:underline"
                    onClick={(e) => {
                      if (!item.onNavigate || !isPlainClick(e)) return;
                      e.preventDefault();
                      item.onNavigate();
                    }}
                  >
                    {item.label}
                  </a>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
