import { useState, type ReactNode } from "react";

import { useT } from "../i18n";
import { Button, Sheet } from "../ui";

/**
 * The frame the two grading corrections share (`OverrideSheet`, F-GRADE-05;
 * `RegradeSheet`, F-GRADE-06): a sheet whose body is one form, Cancel and
 * the action in the footer, and a mandatory field checked on the client.
 *
 * The check is quiet until the first submit: `touched` turns on then, and
 * from there the body marks what is wrong (`aria-invalid` and a line under
 * the field). A submit while `invalid` stops here and sends nothing, so each
 * caller keeps its own guard and only says what "invalid" means. Enter in a
 * field submits through the same path as the footer button.
 */
export function ValidatedSheet({
  title,
  subtitle,
  onClose,
  submitLabel,
  submitting,
  invalid,
  onSubmit,
  error,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  submitLabel: string;
  submitting: boolean;
  /** True while the form must not be sent. */
  invalid: boolean;
  onSubmit: () => void;
  /** The failed write, after the fields (`<FormError title=…>`). */
  error: ReactNode;
  /** The fields, told whether a submit was attempted. */
  children: (touched: boolean) => ReactNode;
}) {
  const t = useT();
  const [touched, setTouched] = useState(false);

  const submit = () => {
    setTouched(true);
    if (invalid) return;
    onSubmit();
  };

  return (
    <Sheet
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {children(touched)}
        {error}
      </form>
    </Sheet>
  );
}
