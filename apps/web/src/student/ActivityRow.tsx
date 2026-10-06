/**
 * One card of a student's activity list (DESIGN.md, "The student's activity
 * card"): a kind icon, the title, a status badge, the meta items (icon + text)
 * and one button. The evaluation, poll and project rows of `cards.tsx` and
 * `ProjectRow.tsx` all wear it; it is a file of its own so that a row may
 * import it without importing the list that draws every row. The two lines
 * every row counts down with live here for the same reason.
 *
 * A row decides nothing about emphasis: the page says which button is the
 * primary, since the home lights every open card and the classroom page only
 * its most urgent one. The accent is the button's alone: neither the kind
 * icon nor the status badge ever takes it.
 */
import { formatDuration, type TFunction } from "../i18n";
import {
  Badge,
  Button,
  Card,
  isoDateTime,
  isPlainClick,
  LinkButton,
  MetaLine,
  Tip,
  type IconType,
  type Tone,
} from "../ui";

/**
 * The one action of a row: a button (`onClick`), or a link (`href`) — to a
 * page on GitHub in a new tab (`external`), or a plain navigation of this
 * window (the GitHub account link flow, which comes back here). `loading`
 * disables the button and says so with a spinner.
 */
export type RowAction = {
  label: string;
  /** A mark before the label: the GitHub mark on what leads to GitHub (never the accent). */
  icon?: IconType;
  primary?: boolean;
  loading?: boolean;
} & (
  | { onClick: () => void | Promise<void>; href?: undefined; external?: undefined }
  | { href: string; external?: boolean; onClick?: undefined }
);

/**
 * The row's title as a door to the activity's own page: a real link (a long
 * press or a modified click opens the address), navigated in the app on a
 * plain click.
 */
export interface RowLink {
  href: string;
  onNavigate: () => void;
}

/** "{time} left" until `deadlineAt`, or "Due {when}" once it has passed. */
export const leftLine = (deadlineAt: string, now: number, t: TFunction): string => {
  const left = Date.parse(deadlineAt) - now;
  return left > 0 ? t("shome.left", { time: formatDuration(left, t) }) : t("shome.dueAt", { when: isoDateTime(deadlineAt) });
};

/** "Starts in {time}" until `opensAt`, or "Starts at {when}" once it has passed. */
export const startsLine = (opensAt: string, now: number, t: TFunction): string => {
  const wait = Date.parse(opensAt) - now;
  return wait > 0 ? t("shome.opensIn", { time: formatDuration(wait, t) }) : t("shome.opensAt", { when: isoDateTime(opensAt) });
};

/** What a card is: a small icon before the title, named by a `Tip` and by its accessible name. */
export interface RowKind {
  label: string;
  icon: IconType;
}

/** Where the activity stands: a badge beside the title (green done or open, amber to do or running, zinc neutral). */
export interface RowStatus {
  label: string;
  tone: Tone;
  icon?: IconType;
}

/** The status as a badge: beside a card's title, and beside the project page's. */
export function StatusBadge({ status }: { status: RowStatus }) {
  return (
    <Badge tone={status.tone} {...(status.icon ? { icon: status.icon } : {})}>
      {status.label}
    </Badge>
  );
}

export function ActivityRow({
  kind,
  title,
  link,
  where,
  status,
  meta,
  action,
}: {
  kind: RowKind;
  title: string;
  /** The activity's own page, when it has one the student may open. */
  link?: RowLink | undefined;
  /** Absent on a page that is already the classroom's. */
  where?: string | undefined;
  status?: RowStatus | undefined;
  /** The card's facts: `MetaItem`s, drawn in one wrapping line. */
  meta?: React.ReactNode;
  action?: RowAction | undefined;
}) {
  const KindIcon = kind.icon;
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-5">
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Tip label={kind.label}>
            <span role="img" aria-label={kind.label} tabIndex={0} className="inline-flex rounded-sm">
              <KindIcon className="size-4 shrink-0 text-fg-faint" />
            </span>
          </Tip>
          <p className="min-w-0 text-[17px] font-bold leading-snug tracking-tight">
            {link ? (
              <a
                href={link.href}
                className="hover:underline"
                onClick={(e) => {
                  if (!isPlainClick(e)) return;
                  e.preventDefault();
                  link.onNavigate();
                }}
              >
                {title}
              </a>
            ) : (
              title
            )}
          </p>
          {status ? <StatusBadge status={status} /> : null}
        </div>
        {where ? <p className="mt-0.5 text-sm text-fg-muted">{where}</p> : null}
        {meta ? <MetaLine className="mt-1.5">{meta}</MetaLine> : null}
      </div>
      {action ? <RowActionControl action={action} /> : null}
    </Card>
  );
}

/** The row's button, or its link to a page on GitHub (a new tab, never the app's frame). */
export function RowActionControl({ action, className }: { action: RowAction; className?: string }) {
  const variant = action.primary ? "primary" : "secondary";
  const Icon = action.icon;
  if (action.href !== undefined) {
    return (
      <LinkButton
        href={action.href}
        {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}
        variant={variant}
        className={className}
      >
        {Icon ? <Icon className="size-4" /> : null}
        {action.label}
      </LinkButton>
    );
  }
  return (
    <Button variant={variant} onClick={() => void action.onClick()} loading={action.loading ?? false} className={className}>
      {Icon && !action.loading ? <Icon className="size-4" /> : null}
      {action.label}
    </Button>
  );
}
