import type { ComponentProps } from "react";

import { Button } from "./controls";
import { Tip } from "./layers";

/**
 * A screen's primary action that cannot be taken yet: it stays in place,
 * disabled, and its tooltip says why (`disabledReason`) — a button that
 * vanished would move the row under the pointer. The wrapper takes the
 * focus a disabled button cannot, so a keyboard reaches the reason too.
 * Without a reason, the plain `Button`.
 */
export function HeldButton({ disabledReason, children, ...props }: ComponentProps<typeof Button> & { disabledReason?: string | null }) {
  if (!disabledReason) return <Button {...props}>{children}</Button>;
  return (
    <Tip label={disabledReason}>
      <span tabIndex={0} className="rounded-full">
        <Button {...props} disabled>
          {children}
        </Button>
      </span>
    </Tip>
  );
}
