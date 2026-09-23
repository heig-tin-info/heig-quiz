import type { ReactNode } from "react";

import { useT } from "../i18n";
import { Button } from "./controls";
import { Modal } from "./layers";

/**
 * The short form in a dialog: a title, one to three fields, Cancel and the
 * one action that names what it does ("Create course", "Save").
 *
 * It owns the footer every such dialog used to write out by hand — Cancel
 * always reads `common.cancel`, the submit button carries the pending spinner
 * and is disabled until `canSubmit` — and it places the `error` slot after
 * the fields, where the reader's eye is when the click fails.
 *
 * It is NOT the way a longer form gets a dialog: DESIGN.md › Sheet/Dialog
 * sends everything past three fields to a `Sheet`, and this component has no
 * `size` on purpose. A fourth field is the sign to move the form, not to
 * widen the dialog.
 */
export function FormDialog({
  title,
  onClose,
  onSubmit,
  submitLabel,
  submitting,
  canSubmit = true,
  error,
  dense,
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  /** The verb of the action ("Create", "Save"), never "OK". */
  submitLabel: string;
  /** The mutation is in flight: spinner, and the button is disabled. */
  submitting?: boolean;
  /** False while a required field is empty. */
  canSubmit?: boolean;
  /** What went wrong on submit, shown under the fields (`<FormError>`). */
  error?: ReactNode;
  /** 12 px between the rows instead of 16, for a body that is one row. */
  dense?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} loading={submitting} disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className={dense ? "space-y-3" : "space-y-4"}>
        {children}
        {error}
      </div>
    </Modal>
  );
}
