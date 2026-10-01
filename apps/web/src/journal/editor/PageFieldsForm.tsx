import { useT } from "../../i18n";
import { Field, Switch } from "../../ui";
import type { PageFields } from "./frontMatter";

/*
 * The front matter as fields (F-JRN-08, D25 condition 2), above the text it
 * heads: what the page is called, its date, whether it is a draft, and when
 * students may read it. The values are the YAML scalars themselves — what
 * the inputs show is converted on the way in and out, and a value an input
 * cannot show (a date written as text) gets a text box rather than an empty
 * date picker that would read as "not set".
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** A `datetime-local` value from a front-matter date, "" when unset, null when it is not a date. */
export function toLocalInput(value: string): string | null {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A front-matter date from a `datetime-local` value: the local time with its offset (`…T08:00:00+02:00`). */
export function fromLocalInput(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${local}:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function PageFieldsForm({
  fields,
  onChange,
}: {
  fields: PageFields;
  onChange: (next: PageFields) => void;
}) {
  const t = useT();
  const set = <K extends keyof PageFields>(key: K, value: PageFields[K]) => onChange({ ...fields, [key]: value });
  const visible = toLocalInput(fields.visibleFrom);
  return (
    <fieldset
      aria-label={t("journalEditor.fields")}
      className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
    >
      <Field
        fullWidth
        label={t("journalEditor.title")}
        value={fields.title}
        onChange={(e) => set("title", e.target.value)}
        placeholder={t("journalEditor.titlePlaceholder")}
      />
      <Field
        fullWidth
        label={t("journalEditor.date")}
        type={fields.date === "" || DAY.test(fields.date) ? "date" : "text"}
        value={fields.date}
        onChange={(e) => set("date", e.target.value)}
      />
      <Field
        fullWidth
        label={t("journalEditor.visibleFrom")}
        type={visible === null ? "text" : "datetime-local"}
        value={visible ?? fields.visibleFrom}
        onChange={(e) => set("visibleFrom", visible === null ? e.target.value : fromLocalInput(e.target.value))}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-fg">
          {t("journalEditor.draft")}
        </span>
        <div className="flex h-[34px] items-center gap-2">
          <Switch
            checked={fields.draft}
            onChange={(v) => set("draft", v)}
            label={t("journalEditor.draft")}
          />
          <span aria-hidden className="text-xs text-fg-faint">
            {fields.draft ? t("journalEditor.draftOn") : t("journalEditor.draftOff")}
          </span>
        </div>
      </div>
    </fieldset>
  );
}
