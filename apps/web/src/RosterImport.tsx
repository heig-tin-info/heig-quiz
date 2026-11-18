import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload, UserPlus } from "lucide-react";
import { useRef, useState } from "react";

import type { RosterCandidate, RosterCandidateQuery, RosterLineAdd } from "@quiz/contracts";
import { STUDENT_SEARCH_MIN_LENGTH } from "@quiz/domain";

import { api, ApiError, wordedRefusal } from "./api";
import { HelpIcon } from "./help";
import { useT } from "./i18n";
import { nameOf, PersonPicker, usePersonPick } from "./PersonPicker";
import { Button, cx, ErrorText, Field, Sheet, Textarea } from "./ui";
import { classroomKey, rosterCandidatesKey } from "./queryKeys";

type Cell = string | number | null;

/**
 * First sheet of an .xlsx, legacy .xls or .ods file, as the rows the API
 * takes: strings, numbers and blanks. The reader is loaded only when a
 * spreadsheet is actually dropped, never in the initial bundle; `read`
 * tells the three formats apart by their bytes.
 */
export async function spreadsheetRows(data: ArrayBuffer): Promise<Cell[][]> {
  const { read } = await import("hucre");
  const wb = await read(data, { sheets: [0], readStyles: true });
  const sheet = wb.sheets[0];
  if (!sheet) throw new Error("Empty workbook");
  return sheet.rows.map((row, r) =>
    row.map((v, c): Cell => {
      if (typeof v === "number") {
        // A cell shown as "150 %" holds 1.5, and the roster reads a bare
        // number below 1 as a fraction: send what the teacher sees. (A
        // legacy .xls comes back without its formats, so not there.)
        const fmt = sheet.cells?.get(`${r},${c}`)?.style?.numFmt;
        return fmt?.includes("%") ? Math.round(v * 1e6) / 1e4 : v;
      }
      if (v === null || typeof v === "string") return v;
      // A stray boolean or date cell travels as text.
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    }),
  );
}

/** Dropped file to tabular rows. Excel/ODS via hucre, otherwise text CSV. */
async function fileToPayload(
  file: File,
): Promise<{ csv: string } | { rows: Cell[][] }> {
  if (/\.(xlsx|xls|ods)$/i.test(file.name)) {
    return { rows: await spreadsheetRows(await file.arrayBuffer()) };
  }
  return { csv: await file.text() };
}

/**
 * One student by hand (ADR-133): found by name among the people of the
 * teacher's school, or named by an address. A pick only fills the field,
 * with the address on its label line, so homonyms are told apart; the line
 * is added by the button, never by Enter on the first match. A caller who
 * may not search (no school address, a course seat only) finds nobody and
 * types an address.
 */
function OneStudent({ classroomId }: { classroomId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const who = usePersonPick<RosterCandidate>();
  const [bonus, setBonus] = useState("");
  // Who the last line added was: the field is empty by the time it is said.
  const [added, setAdded] = useState<string | null>(null);
  const timeBonusPercent = Number(bonus) || 0;
  const line: RosterLineAdd | null = who.selected
    ? { email: who.selected.email, picked: true, timeBonusPercent }
    : who.typedEmail !== null
      ? { email: who.typedEmail, picked: false, timeBonusPercent }
      : null;

  const add = useMutation({
    mutationFn: (body: RosterLineAdd) =>
      api(`/app/api/classrooms/${classroomId}/roster/line`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      who.reset();
      setBonus("");
      // The roster, and the search that no longer offers the person.
      return qc.invalidateQueries({ queryKey: classroomKey(classroomId) });
    },
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <PersonPicker<RosterCandidate>
          candidatesKey={rosterCandidatesKey(classroomId)}
          candidatesUrl={(q) =>
            `/app/api/classrooms/${classroomId}/roster/candidates?${new URLSearchParams({ q } satisfies RosterCandidateQuery)}`
          }
          label={t("import.findLabel")}
          idle={t("import.findIdle")}
          minLength={STUDENT_SEARCH_MIN_LENGTH}
          words="studentPicker"
          disabled={add.isPending}
          {...who.picker}
        />
        <Field
          label={t("import.bonus")}
          type="number"
          min={0}
          max={300}
          className="w-28"
          value={bonus}
          onChange={(e) => setBonus(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={line === null}
          loading={add.isPending}
          onClick={() => {
            if (line === null) return;
            setAdded(who.selected ? nameOf(who.selected) : line.email);
            add.mutate(line);
          }}
        >
          <UserPlus /> {t("import.add")}
        </Button>
      </div>
      {add.isError ? (
        <ErrorText small>{wordedRefusal(add.error, { student_not_found: "import.findGone" }, t)}</ErrorText>
      ) : add.isSuccess && added !== null ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="size-4" /> {t("import.lineAdded", { name: added })}
        </p>
      ) : null}
    </div>
  );
}

/** "Add students" sheet: a file drop, one student by hand, or pasted CSV. */
export function RosterImport({ classroomId, onClose }: { classroomId: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const importRoster = useMutation({
    mutationFn: async (payload: { csv: string } | { rows: Cell[][] }) =>
      "csv" in payload
        ? api(`/app/api/classrooms/${classroomId}/roster`, {
            method: "POST",
            csv: payload.csv,
          })
        : api(`/app/api/classrooms/${classroomId}/roster`, {
            method: "POST",
            body: JSON.stringify(payload),
          }),
    onSuccess: () => qc.invalidateQueries({ queryKey: classroomKey(classroomId) }),
  });

  async function handleFile(file: File) {
    setFileName(file.name);
    try {
      importRoster.mutate(await fileToPayload(file));
    } catch {
      setFileName(`${file.name} — ${t("import.unreadable")}`);
    }
  }

  const importErrors =
    importRoster.isError && importRoster.error instanceof ApiError
      ? ((importRoster.error.body as { errors?: { line: number; message: string }[] })
          ?.errors ?? [])
      : [];

  const eyebrow = "text-[11px] font-semibold uppercase tracking-wider text-fg-faint";

  return (
    <Sheet
      title={t("import.title")}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          {t("import.subtitle")}
          <HelpIcon topic="import-roster" />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <span className="min-w-0 flex-1">
            {importRoster.isSuccess ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-success">
                <CheckCircle2 className="size-4" /> {t("import.done")}
              </span>
            ) : importErrors.length > 0 ? (
              // The lines themselves are under the drop zone; the footer says
              // how many there are, so the sheet never fails in silence.
              <ErrorText as="span">
                {importErrors.length === 1
                  ? t("import.rejected.one")
                  : t("import.rejected", { n: importErrors.length })}
              </ErrorText>
            ) : importRoster.isError ? (
              <ErrorText as="span">{t("import.failed")}</ErrorText>
            ) : null}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t("common.done")}
          </Button>
        </>
      }
    >
      <div className="space-y-7">
        <section className="space-y-3">
          <p className={eyebrow}>{t("import.fromFile")}</p>
          <div
            role="button"
            tabIndex={0}
            aria-label={t("import.dropLabel")}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
            className={cx(
              "flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed px-4 py-8 text-center transition-colors",
              dragging ? "border-accent bg-accent-soft" : "border-line-strong hover:border-fg-faint hover:bg-surface-2/60",
            )}
          >
            <FileSpreadsheet className="size-7 text-fg-faint" />
            <p className="text-sm font-semibold">{t("import.drop")}</p>
            <p className="max-w-sm text-xs text-fg-muted">{t("import.dropHint")}</p>
            {fileName ? <p className="text-xs text-fg-muted">{fileName}</p> : null}
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.ods,.csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
          {/* Under the drop zone, where the file was let go: a list of rejected
              lines at the far end of the sheet is out of sight on a phone. */}
          {importErrors.length > 0 ? (
            <ul className="space-y-1 text-sm text-danger">
              {importErrors.map((e, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {t("import.line", { n: e.line, message: e.message })}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="space-y-3">
          <p className={eyebrow}>{t("import.oneStudent")}</p>
          <OneStudent classroomId={classroomId} />
        </section>

        <section className="space-y-3">
          <p className={eyebrow}>{t("import.pasted")}</p>
          <Textarea
            aria-label={t("import.pasted")}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"nom,prenom,email,bonus\nRochat,Léa,lea.rochat@heig-vd.ch,25"}
            className="font-mono text-xs"
          />
          <Button
            variant="secondary"
            onClick={() => importRoster.mutate({ csv })}
            disabled={csv.trim().length === 0}
            loading={importRoster.isPending}
          >
            <Upload /> {t("import.importCsv")}
          </Button>
        </section>

      </div>
    </Sheet>
  );
}
