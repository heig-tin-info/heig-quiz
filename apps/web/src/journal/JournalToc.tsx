import type { JournalTocEntry } from "@quiz/contracts";

import { useT } from "../i18n";
import { cx } from "../ui";

/**
 * The table of contents of a page: its `h2` and `h3`, as in-page anchors.
 * The `h1` is the page's own title, already the first thing on it, and
 * deeper levels turn a table of contents into a second copy of the page.
 * The text is PLAIN TEXT from the contract, rendered as React text.
 * Nothing when the page has fewer than two such headings: one entry is not
 * a table of anything.
 */
export function JournalToc({ toc }: { toc: JournalTocEntry[] }) {
  const t = useT();
  const entries = toc.filter((e) => e.depth === 2 || e.depth === 3);
  if (entries.length < 2) return null;
  return (
    <nav aria-label={t("journal.toc")}>
      <p className="mb-2 px-2.5 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        {t("journal.toc")}
      </p>
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
