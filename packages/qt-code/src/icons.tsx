/**
 * The few icons of the program surfaces, on `@quiz/ui`'s `StrokeIcon`. The
 * paths are lucide's own (ISC), so the icons match the app's. Sized by the
 * button (`[&_svg]:size-*`).
 */
import type { ReactNode } from "react";

import { StrokeIcon } from "@quiz/ui";

const Icon = ({ children }: { children: ReactNode }): ReactNode => (
  <StrokeIcon strokeWidth={2} size={16}>
    {children}
  </StrokeIcon>
);

/** Compile. */
export const HammerIcon = (): ReactNode => (
  <Icon>
    <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" />
    <path d="m18 15 4-4" />
    <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
  </Icon>
);

/** Run the tests: a list of checked items. */
export const ListChecksIcon = (): ReactNode => (
  <Icon>
    <path d="m3 17 2 2 4-4" />
    <path d="m3 7 2 2 4-4" />
    <path d="M13 6h8" />
    <path d="M13 12h8" />
    <path d="M13 18h8" />
  </Icon>
);

/** Free try: a prompt. */
export const TerminalIcon = (): ReactNode => (
  <Icon>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" x2="20" y1="19" y2="19" />
  </Icon>
);

/**
 * The padlock of the template editor's lock button, closed or open: lucide's
 * `Lock` and `LockOpen`.
 */
export const LockIcon = ({ open = false }: { open?: boolean }): ReactNode => (
  <Icon>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d={open ? "M7 11V7a5 5 0 0 1 9.9-1" : "M7 11V7a5 5 0 0 1 10 0v4"} />
  </Icon>
);
