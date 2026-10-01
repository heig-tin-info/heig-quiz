import type { JournalTocEntry } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx } from "../ui";

/**
 * The entries of a page's table of contents: its `h2` and `h3`. The `h1` is
 * the page's own title, already the first thing on it, and deeper levels
 * turn a table of contents into a second copy of the page. None when the
 * page has fewer than two: one entry is not a table of anything.
 */
export function tocEntries(toc: JournalTocEntry[]): JournalTocEntry[] {
  const entries = toc.filter((e) => e.depth === 2 || e.depth === 3);
  return entries.length < 2 ? [] : entries;
}

/**
 * The table of contents of a page (`tocEntries`), as in-page anchors. The
 * text is PLAIN TEXT from the contract, rendered as React text.
 */
export function JournalToc({ entries, titled = true }: { entries: JournalTocEntry[]; titled?: boolean }) {
  const t = useT();
  return (
    <nav aria-label={t("journal.toc")}>
      {titled ? (
        <p className="mb-2 px-2.5 text-xs font-semibold uppercase tracking-wide text-fg-faint">{t("journal.toc")}</p>
      ) : null}
      <ul className="space-y-0.5">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${encodeURIComponent(entry.id)}`}
              className={cx(
                "block truncate rounded-field px-2.5 py-1 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg",
                entry.depth === 3 && "pl-5",
              )}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
