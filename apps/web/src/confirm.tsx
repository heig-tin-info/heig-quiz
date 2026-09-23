import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import { useT } from "./i18n";
import { Button, Modal } from "./ui";

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
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [pending, setPending] = useState<{
    options: ConfirmOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) =>
        setPending((previous) => {
          // One dialog at a time: a second confirm() replaces the first, so
          // settle the one leaving the screen instead of leaving its caller
          // waiting on a promise nothing will ever resolve.
          previous?.resolve(false);
          return { options, resolve };
        }),
      ),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
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
              <Button variant="ghost" onClick={() => settle(false)}>
                {pending.options.cancelLabel ?? t("common.cancel")}
              </Button>
              <Button
                variant={pending.options.danger ? "danger" : "primary"}
                autoFocus
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
        </Modal>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
