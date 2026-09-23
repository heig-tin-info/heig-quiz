import { useT } from "../i18n";
import { QuestionTypePicker } from "../pool/QuestionTypePicker";
import { Field } from "../ui";

/**
 * The two fields a new question starts from: its type, as the tile grid, and
 * its internal name. The pool's "New question" dialog passes the types on
 * offer as `types`. (The poll launcher uses the tile grid alone: its question
 * is never saved, so it has no name to ask for.)
 *
 * Fields only, as a fragment laid out by the container's own spacing: the
 * submit button and the failure belong to the container, because the two
 * differ there — a one-line error in the dialog's slot, a titled alert under
 * a hint in the sheet.
 */
export function NewQuestionForm({
  types,
  value,
  onChange,
  name,
  onName,
}: {
  types: readonly string[];
  value: string;
  onChange: (type: string) => void;
  name: string;
  onName: (name: string) => void;
}) {
  const t = useT();
  return (
    <>
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">{t("pool.questionType")}</legend>
        <QuestionTypePicker types={types} value={value} onChange={onChange} />
      </fieldset>
      <Field
        label={t("pool.questionName")}
        hint={t("pool.questionNameHint")}
        fullWidth
        autoFocus
        placeholder={t("pool.questionNamePlaceholder")}
        value={name}
        onChange={(e) => onName(e.target.value)}
      />
    </>
  );
}
