import { useId, useState, type ReactNode } from "react";

import { useHold } from "../build";
import { useT } from "../i18n";
import { Button, Field, FieldError, fieldErrorProps } from "./controls";
import { fromLocalInput, toLocalInput } from "./dates";
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
  danger,
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
  /** The action destroys or retires something: the submit button is `danger`. */
  danger?: boolean;
  /** What went wrong on submit, shown under the fields (`<FormError>`). */
  error?: ReactNode;
  /** 12 px between the rows instead of 16, for a body that is one row. */
  dense?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  // ADR-110: an open form is work a reload would lose.
  useHold(true);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={onSubmit}
            loading={submitting}
            disabled={!canSubmit}
          >
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

/**
 * A dialog of ONE text field: a name to give or change ("Rename", "New
 * folder"). It owns the field's draft, opens it on `initial` with the text
 * selected (a rename usually replaces the whole name), and submits on Enter
 * as on the button.
 *
 * `valid` is the route's own schema (invariant 7), so a value the server
 * would refuse never leaves the browser.
 * The submit stays disabled while the value is the one it opened on: saving
 * an unchanged name is not an action. `onSubmit` receives the value trimmed;
 * the caller closes the dialog when its write succeeds.
 */
export function TextFieldDialog({
  title,
  label,
  initial,
  submitLabel,
  valid,
  submitting,
  onSubmit,
  onClose,
}: {
  title: string;
  /** The field's label ("Title", "Name"). */
  label: string;
  initial: string;
  /** The verb of the action ("Rename", "Create"), never "OK". */
  submitLabel: string;
  valid: (value: string) => boolean;
  submitting?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const next = value.trim();
  const canSubmit = next !== initial.trim() && valid(value);
  const submit = () => {
    if (canSubmit && !submitting) onSubmit(next);
  };
  return (
    <FormDialog
      title={title}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={submitLabel}
      submitting={submitting}
      canSubmit={canSubmit}
      dense
    >
      <Field
        label={label}
        fullWidth
        autoFocus
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
        }}
      />
    </FormDialog>
  );
}

/**
 * A dialog of ONE instant to choose (a `datetime-local` field in the
 * reader's own time): the live "Extend until a date" (F-LIVE-11) and a
 * contestation window's end (ADR-139). It opens on `initial`, bounds the
 * field with `min` and `max`, and keeps the submit off while `refusal`
 * words the typed instant — said under the field once it changed from what
 * it opened on, so the value it opens on is never a mistake. The server
 * decides again: its refusal is `error`.
 */
export function InstantDialog({
  title,
  submitLabel,
  fieldLabel,
  description,
  initial,
  min,
  max,
  refusal,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  /** The verb of the action ("Extend"). */
  submitLabel: string;
  fieldLabel: string;
  /** Under the label: what stands now ("Current end: …"). */
  description: string;
  /** ISO instants. */
  initial: string;
  min: string;
  max: string;
  /** Why the chosen instant cannot be taken, in the reader's words; null when it can. */
  refusal: (iso: string) => string | null;
  pending: boolean;
  error: ReactNode;
  onSubmit: (iso: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [opened] = useState(() => toLocalInput(initial));
  const [local, setLocal] = useState(opened);
  const chosen = fromLocalInput(local);
  const refused = chosen === null ? null : refusal(chosen);
  const shown = local === opened ? null : refused;
  return (
    <FormDialog
      title={title}
      onClose={onClose}
      submitLabel={submitLabel}
      submitting={pending}
      canSubmit={chosen !== null && refused === null}
      onSubmit={() => chosen !== null && refused === null && onSubmit(chosen)}
      error={error}
    >
      <div className="flex flex-col gap-1">
        <Field
          id={id}
          type="datetime-local"
          label={fieldLabel}
          description={description}
          value={local}
          min={toLocalInput(min)}
          max={toLocalInput(max)}
          required
          onChange={(e) => setLocal(e.target.value)}
          {...fieldErrorProps(id, shown)}
        />
        <FieldError id={id}>{shown}</FieldError>
      </div>
    </FormDialog>
  );
}
