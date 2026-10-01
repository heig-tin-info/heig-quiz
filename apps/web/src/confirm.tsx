import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import { useT } from "./i18n";
import { Button, Field, Modal } from "./ui";

/**
 * Styled replacement for `window.confirm`: `const ok = await confirm({...})`.
 * One dialog at a time, resolved false on Escape or the X. The buttons say
 * "Cancel" / "Confirm" in the reader's language unless the caller names them.
 */
export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the confirm button turns red, never primary-styled. */
  danger?: boolean;
  /**
   * Focus Cancel instead of Confirm when the dialog opens: for an
   * IRREVERSIBLE step reached by a shortcut (the player's "Validate and
   * continue" on Ctrl+Enter), a habitual Enter must not confirm it.
   */
  focusCancel?: boolean;
  /**
   * The name the user must type before the confirm button wakes up: for a
   * deletion that destroys the only copy of something (a classroom, a
   * Quiz-mode journal and its pages, F-JRN-04). Compared trimmed, as the API
   * compares the `?confirm=` it is then sent.
   */
  typeToConfirm?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [pending, setPending] = useState<{
    options: ConfirmOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [typed, setTyped] = useState("");
  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // Every question starts with nothing typed, the one it replaces included.
        setTyped("");
        setPending((previous) => {
          // One dialog at a time: a second confirm() replaces the first, so
          // settle the one leaving the screen instead of leaving its caller
          // waiting on a promise nothing will ever resolve.
          previous?.resolve(false);
          return { options, resolve };
        });
      }),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const mustType = pending?.options.typeToConfirm;
  const blocked = mustType !== undefined && typed.trim() !== mustType.trim();
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <Modal
          size="sm"
          title={pending.options.title}
          onClose={() => settle(false)}
          footer={
            <>
              <Button
                variant="ghost"
                autoFocus={pending.options.focusCancel === true}
                onClick={() => settle(false)}
              >
                {pending.options.cancelLabel ?? t("common.cancel")}
              </Button>
              <Button
                variant={pending.options.danger ? "danger" : "primary"}
                autoFocus={pending.options.focusCancel !== true && mustType === undefined}
                disabled={blocked}
                onClick={() => settle(true)}
              >
                {pending.options.confirmLabel ?? t("common.confirm")}
              </Button>
            </>
          }
        >
          {pending.options.message ? (
            <div className="text-sm text-fg-muted">{pending.options.message}</div>
          ) : null}
          {mustType !== undefined ? (
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!blocked) settle(true);
              }}
            >
              <Field
                fullWidth
                autoFocus
                autoComplete="off"
                spellCheck={false}
                label={t("confirm.typeName", { name: mustType })}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </form>
          ) : null}
        </Modal>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
