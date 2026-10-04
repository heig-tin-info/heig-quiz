/**
 * One card of a student's activity list: what it is, where it comes from, one
 * line, one button. The evaluation, poll and project rows of `cards.tsx` and
 * `ProjectRow.tsx` all wear it; it is a file of its own so that a row may
 * import it without importing the list that draws every row.
 *
 * A row decides nothing about emphasis: the page says which button is the
 * primary, since the home lights every open card and the classroom page only
 * its most urgent one.
 */
import { Badge, Button, Card, LinkButton } from "../ui";

/**
 * The one action of a row: a button (`onClick`), or a link (`href`) — to a
 * page on GitHub in a new tab (`external`), or a plain navigation of this
 * window (the GitHub account link flow, which comes back here). `loading`
 * disables the button and says so with a spinner.
 */
export type RowAction = {
  label: string;
  primary?: boolean;
  loading?: boolean;
} & (
  | { onClick: () => void | Promise<void>; href?: undefined; external?: undefined }
  | { href: string; external?: boolean; onClick?: undefined }
);

export function ActivityRow({
  title,
  where,
  line,
  badge,
  action,
}: {
  title: string;
  /** Absent on a page that is already the classroom's. */
  where?: string | undefined;
  line: string | null;
  badge: { label: string; accent: boolean };
  action?: RowAction | undefined;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-5">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-[17px] font-bold leading-snug tracking-tight">{title}</p>
        {where ? <p className="mt-0.5 text-sm text-fg-muted">{where}</p> : null}
        {line ? <p className="mt-1 text-[13px] text-fg-faint">{line}</p> : null}
      </div>
      <Badge tone={badge.accent ? "accent" : "zinc"}>{badge.label}</Badge>
      {action ? <RowActionControl action={action} /> : null}
    </Card>
  );
}

/** The row's button, or its link to a page on GitHub (a new tab, never the app's frame). */
export function RowActionControl({ action, className }: { action: RowAction; className?: string }) {
  const variant = action.primary ? "primary" : "secondary";
  if (action.href !== undefined) {
    return (
      <LinkButton
        href={action.href}
        {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}
        variant={variant}
        className={className}
      >
        {action.label}
      </LinkButton>
    );
  }
  return (
    <Button variant={variant} onClick={() => void action.onClick()} loading={action.loading ?? false} className={className}>
      {action.label}
    </Button>
  );
}
