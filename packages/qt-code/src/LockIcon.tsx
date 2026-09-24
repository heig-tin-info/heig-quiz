/**
 * The padlock of the template editor's lock button, closed or open.
 *
 * Inline rather than `lucide-react`: this package does not depend on it, and
 * one icon is not worth a dependency. The paths are lucide's `Lock` and
 * `LockOpen`, so the button matches the app's other icons; the size comes
 * from the button (`[&_svg]:size-*`).
 */
export function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d={open ? "M7 11V7a5 5 0 0 1 9.9-1" : "M7 11V7a5 5 0 0 1 10 0v4"} />
    </svg>
  );
}
