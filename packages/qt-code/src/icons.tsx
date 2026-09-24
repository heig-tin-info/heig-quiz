/**
 * The few icons of the program surfaces, as inline SVG.
 *
 * `apps/web` draws its icons with lucide-react, which this package does not
 * depend on; five 24 px outlines do not justify a dependency (and a lockfile
 * change). The paths are lucide's own (ISC), so the icons match the app's.
 * Decorative: every one sits beside a word or inside a labelled button, so
 * it is hidden from assistive technology. Sized by the button (`[&_svg]:size-*`).
 */
import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

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

/** Remove a row. */
export const TrashIcon = (): ReactNode => (
  <Icon>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </Icon>
);

/** Add a row. */
export const PlusIcon = (): ReactNode => (
  <Icon>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Icon>
);
