# ADR-049 — The classroom journal: GitHub holds the content, Postgres holds a read model

## Status

Superseded by / folded into [ADR-057](ADR-057-journal-two-modes.md) on 2026-10-09.
Imported from heig-classroom (its ADR-015) on 2026-09-30 with a port
addendum, then amended by ADR-057 (two modes). Its rules still in force now
live in ADR-057: one journal per classroom, rendering once on the server
with raw HTML escaped, the one renderer in `packages/docrender`, assets,
access and the student's exit, and the defects J1–J7 in
[§7, both modes](ADR-057-journal-two-modes.md#7-the-rules-kept-from-adr-049-folded-2026-10-09);
the repository as the content, no clone, no adoption and Quiz's own App
in §7, GitHub mode. Body point 5 (browser writes into GitHub) and
addendum points 2 and 7 are replaced by ADR-057 §1–§2. Each former point
is mapped in ADR-057's
[correspondence table](ADR-057-journal-two-modes.md#correspondence-with-adr-049).
The full former text is in the git history of this file.
