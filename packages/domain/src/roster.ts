/**
 * Roster import (AU-13..16) from tabular data: pasted CSV or a dropped Excel
 * sheet. Identification of the last name / first name / e-mail columns is
 * PERMISSIVE: accents and case ignored, French/English aliases, stray columns
 * tolerated, header not necessarily on the first line, and a fallback that
 * detects the e-mail column by its content when no header is recognized.
 * The import stays atomic: any single error rejects everything.
 */

export interface RosterRow {
  nom: string;
  prenom: string;
  /** Normalized: trimmed + lowercase. */
  email: string;
  /**
   * Accommodation (F-ORG-07): extra time in percent of the nominal
   * duration, from an optional column. 0 when the column is absent or the
   * cell is empty.
   */
  timeBonusPercent: number;
}

export interface RosterError {
  line: number;
  message: string;
}

export type RosterParse =
  | { ok: true; rows: RosterRow[] }
  | { ok: false; errors: RosterError[] };

/** Cell as it comes out of a CSV parser or an Excel sheet. */
export type Cell = string | number | null | undefined;

// Deliberately simple: the strong check is the claim against the e-mail
// verified by the IdP (AU-18); here we only catch obvious typos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercase, no accents or punctuation: "E-Mail" becomes "email". */
function normalizeHeader(cell: Cell): string {
  return String(cell ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const ALIASES = {
  nom: ["nom", "nomdefamille", "lastname", "surname", "familyname"],
  prenom: ["prenom", "firstname", "givenname"],
  email: ["email", "mail", "emailaddress", "adresseemail", "adressemail", "courriel"],
  // Optional accommodation column (F-ORG-07). Written a dozen ways by the
  // schools that hand out the lists, so the aliases are generous; a sheet
  // without it imports exactly as before.
  bonus: [
    "bonus",
    "bonustemps",
    "tempssupplementaire",
    "tempssupp",
    "tempsadditionnel",
    "extratime",
    "timebonus",
    "bonuspercent",
    "bonustempspercent",
    "amenagement",
    "amenagementtemps",
  ],
} as const;

type Columns = { nom: number; prenom: number; email: number; bonus?: number };

const REQUIRED = ["nom", "prenom", "email"] as const;

function matchHeader(row: readonly Cell[]): Partial<Columns> {
  const found: Partial<Columns> = {};
  row.forEach((cell, i) => {
    const h = normalizeHeader(cell);
    for (const key of ["nom", "prenom", "email", "bonus"] as const) {
      if (found[key] === undefined && (ALIASES[key] as readonly string[]).includes(h)) {
        found[key] = i;
      }
    }
  });
  return found;
}

/**
 * Extra-time cell. Accepts `25`, `25%`, `25 %`, `1/3` written as `33`, and a
 * fraction of one (`0.25` means 25 %). Empty or unreadable = no bonus.
 */
export function parseTimeBonus(cell: Cell): number | null {
  const raw = String(cell ?? "").trim().replace("%", "").replace(",", ".").trim();
  if (raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const percent = n > 0 && n < 1 ? n * 100 : n;
  if (percent > 300) return null;
  return Math.round(percent);
}

const HEADER_SCAN_ROWS = 10;

/**
 * Locates the header (the three recognized columns on the same line, within
 * the first rows); failing that, detects the e-mail column by content and
 * takes the first two remaining columns as last name then first name.
 */
function locateColumns(rows: readonly (readonly Cell[])[]): {
  columns: Columns;
  dataStart: number;
} | null {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const found = matchHeader(rows[i] ?? []);
    if (REQUIRED.every((k) => found[k] !== undefined)) {
      return { columns: found as Columns, dataStart: i + 1 };
    }
  }
  // Headerless fallback: the column whose content looks most like e-mails,
  // then the first two remaining columns (order: last name, first name).
  const width = Math.max(0, ...rows.map((r) => r.length));
  let bestCol = -1;
  let bestHits = 0;
  for (let c = 0; c < width; c++) {
    const hits = rows.filter((r) => EMAIL_RE.test(String(r[c] ?? "").trim())).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestCol = c;
    }
  }
  if (bestCol === -1 || bestHits === 0) return null;
  const others = Array.from({ length: width }, (_, c) => c).filter((c) => c !== bestCol);
  const [nom, prenom] = others;
  if (nom === undefined || prenom === undefined) return null;
  return { columns: { nom, prenom, email: bestCol }, dataStart: 0 };
}

function cellText(cell: Cell): string {
  return String(cell ?? "").trim();
}

/** Core of the import: tabular rows (CSV, Excel...) to the roster. */
export function rosterFromRows(input: readonly (readonly Cell[])[]): RosterParse {
  // Reported line numbers are those of the original document (1-based).
  const numbered = input
    .map((cells, i) => ({ line: i + 1, cells }))
    .filter(({ cells }) => cells.some((c) => cellText(c) !== ""));
  if (numbered.length === 0) {
    return { ok: false, errors: [{ line: 1, message: "Empty file" }] };
  }

  const located = locateColumns(numbered.map((r) => r.cells));
  if (!located) {
    return {
      ok: false,
      errors: [
        {
          line: 1,
          message:
            "Could not identify columns: expected a nom / prenom / email header (or a recognizable e-mail column)",
        },
      ],
    };
  }

  const errors: RosterError[] = [];
  const rows: RosterRow[] = [];
  const seen = new Map<string, number>();

  for (const { line, cells } of numbered.slice(located.dataStart)) {
    const nom = cellText(cells[located.columns.nom]);
    const prenom = cellText(cells[located.columns.prenom]);
    const email = cellText(cells[located.columns.email]).toLowerCase();
    const bonusCol = located.columns.bonus;
    const timeBonusPercent = bonusCol === undefined ? 0 : parseTimeBonus(cells[bonusCol]);

    if (!nom || !prenom) {
      errors.push({ line, message: "nom and prenom are required" });
      continue;
    }
    if (!EMAIL_RE.test(email)) {
      errors.push({ line, message: `invalid e-mail: “${email}”` });
      continue;
    }
    const first = seen.get(email);
    if (first !== undefined) {
      errors.push({ line, message: `duplicate “${email}” (already on line ${first})` });
      continue;
    }
    if (timeBonusPercent === null) {
      errors.push({
        line,
        message: `invalid extra time: "${cellText(cells[bonusCol!])}" (expected a percentage)`,
      });
      continue;
    }
    seen.set(email, line);
    rows.push({ nom, prenom, email, timeBonusPercent });
  }

  if (errors.length > 0) return { ok: false, errors };
  if (rows.length === 0) {
    return { ok: false, errors: [{ line: 1, message: "No data rows" }] };
  }
  return { ok: true, rows };
}

function detectSeparator(line: string): "," | ";" | "\t" {
  const counts: ["\t" | ";" | ",", number][] = [
    ["\t", (line.match(/\t/g) ?? []).length],
    [";", (line.match(/;/g) ?? []).length],
    [",", (line.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

/** Text CSV (pasted into the portal): simple split, then the shared rules. */
export function parseRosterCsv(text: string): RosterParse {
  const clean = text.replace(/^﻿/, ""); // BOM
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const sep = detectSeparator(firstLine);
  const rows = clean.split(/\r?\n/).map((l) => l.split(sep));
  return rosterFromRows(rows);
}
