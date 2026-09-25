import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload, UserPlus } from "lucide-react";
import { useRef, useState } from "react";

import { api, ApiError } from "./api";
import { HelpIcon } from "./help";
import { useT } from "./i18n";
import { Button, cx, Field, Sheet, Textarea } from "./ui";
import { classroomKey } from "./queryKeys";

type Cell = string | number | null;

/** Dropped file to tabular rows. Excel/ODS via hucre, otherwise text CSV. */
async function fileToPayload(
  file: File,
): Promise<{ csv: string } | { rows: Cell[][] }> {
  if (/\.(xlsx|xls|ods)$/i.test(file.name)) {
    // Load the spreadsheet reader only when a spreadsheet is actually
    // dropped, never in the initial bundle. `read` tells .xlsx, legacy .xls
    // and .ods apart by their bytes.
    const { read } = await import("hucre");
    const wb = await read(await file.arrayBuffer(), { sheets: [0] });
    const sheet = wb.sheets[0];
    if (!sheet) throw new Error("Empty workbook");
    // The API takes strings, numbers and blanks; a stray boolean or date
    // cell travels as text.
    const rows = sheet.rows.map((row) =>
      row.map((v): Cell =>
        v === null || typeof v === "string" || typeof v === "number"
          ? v
          : v instanceof Date
            ? v.toISOString().slice(0, 10)
            : String(v),
      ),
    );
    return { rows };
  }
  return { csv: await file.text() };
}

/** "Add students" sheet: a file drop, one student by hand, or pasted CSV. */
export function RosterImport({ classroomId, onClose }: { classroomId: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [manual, setManual] = useState({ nom: "", prenom: "", email: "", bonus: "" });
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
              <span className="text-sm text-danger">
                {importErrors.length === 1
                  ? t("import.rejected.one")
                  : t("import.rejected", { n: importErrors.length })}
              </span>
            ) : importRoster.isError ? (
              <span className="text-sm text-danger">{t("import.failed")}</span>
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
          <form
            className="grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              // The header row names the columns the parser looks for, extra
              // time included: one code path for a pasted sheet and for the
              // single student typed here.
              importRoster.mutate({
                rows: [
                  ["lastname", "firstname", "email", "bonus"],
                  [manual.nom, manual.prenom, manual.email, manual.bonus || "0"],
                ],
              });
              setManual({ nom: "", prenom: "", email: "", bonus: "" });
            }}
          >
            <Field
              label={t("roster.col.lastName")}
              required
              fullWidth
              value={manual.nom}
              onChange={(e) => setManual({ ...manual, nom: e.target.value })}
            />
            <Field
              label={t("roster.col.firstName")}
              required
              fullWidth
              value={manual.prenom}
              onChange={(e) => setManual({ ...manual, prenom: e.target.value })}
            />
            <div className="col-span-2 flex items-end gap-3">
              <Field
                label={t("roster.col.email")}
                required
                type="email"
                fullWidth
                placeholder="prenom.nom@heig-vd.ch"
                value={manual.email}
                onChange={(e) => setManual({ ...manual, email: e.target.value })}
              />
              <Field
                label={t("import.bonus")}
                type="number"
                min={0}
                max={300}
                className="w-28"
                value={manual.bonus}
                onChange={(e) => setManual({ ...manual, bonus: e.target.value })}
              />
              <Button type="submit" variant="secondary" loading={importRoster.isPending}>
                <UserPlus /> {t("import.add")}
              </Button>
            </div>
          </form>
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
