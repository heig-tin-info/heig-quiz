import { useT } from "../i18n";
import { Actions } from "./actions";
import { cx, type MenuItem } from "./layers";
import { PersonAvatar } from "./page";
import { Popover } from "./popover";

/**
 * A group of people as a row of discs: the staff of a course, the teachers of
 * a classroom. A disc alone carries the name in a `Tip` and nothing else,
 * because a name is all a reader wants while scanning; everything ELSE about
 * that person — their address, what may be done to their seat — waits behind
 * a click, where it costs the row nothing.
 *
 * The row has a ceiling. Past `max` the rest becomes one "+N" disc opening on
 * the whole list, so a course with twelve colleagues reads like a course with
 * three and the twelve are still one gesture away.
 */

/** The shape every people row is given: an account with a name and a face. */
export interface Person {
  userId: string;
  givenName: string;
  familyName: string;
  email: string;
  avatarUrl: string | null;
}

const fullName = (p: Person) => `${p.givenName} ${p.familyName}`;

/** The disc itself, at the one size a row of people uses. */
const DISC = "size-6 text-[10px]";

/** The card behind a disc: the face, the name, the address, the actions. */
function PersonCard({ person, actions }: { person: Person; actions?: MenuItem[] }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5">
      <PersonAvatar
        name={[person.givenName, person.familyName]}
        src={person.avatarUrl}
        className="size-9 text-sm"
      />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold">{fullName(person)}</p>
        <a
          href={`mailto:${person.email}`}
          className="block truncate text-xs text-fg-muted hover:text-fg hover:underline"
        >
          {person.email}
        </a>
      </div>
      {actions && actions.length > 0 ? (
        <span className="ml-auto">
          <Actions items={actions} label={t("common.actions")} size="sm" />
        </span>
      ) : null}
    </div>
  );
}

/**
 * One person as a small disc: hovering names them, clicking opens the card.
 * The button carries the full name as its accessible name, so the disc is
 * never an unlabelled control for a screen reader.
 */
export function PersonPill({
  person,
  actions,
  className = "",
}: {
  person: Person;
  actions?: MenuItem[];
  className?: string;
}) {
  const name = fullName(person);
  return (
    <Popover
      label={name}
      align="start"
      trigger={
        <button type="button" aria-label={name} className={cx("rounded-full", className)}>
          <PersonAvatar
            name={[person.givenName, person.familyName]}
            src={person.avatarUrl}
            label={name}
            className={DISC}
          />
        </button>
      }
    >
      <PersonCard person={person} actions={actions} />
    </Popover>
  );
}

/** A row of `PersonPill`s, capped at `max` with a "+N" disc for the rest. */
export function PeopleStack({
  people,
  actions,
  max = 10,
  className = "",
}: {
  people: Person[];
  /** The actions of ONE person; an empty list leaves the card read-only. */
  actions?: (p: Person) => MenuItem[];
  max?: number;
  className?: string;
}) {
  const t = useT();
  if (people.length === 0) return null;
  const shown = people.length > max ? people.slice(0, max) : people;
  const rest = people.length - shown.length;
  const moreLabel = t("people.more", { n: rest });
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)}>
      {shown.map((p) => (
        <PersonPill key={p.userId} person={p} actions={actions?.(p)} />
      ))}
      {rest > 0 ? (
        <Popover
          label={moreLabel}
          align="start"
          open="hover"
          trigger={
            <button
              type="button"
              aria-label={moreLabel}
              // The look of an `Initials` disc, because that is what it stands
              // in for: the same size, the same surface, the same weight.
              className={cx(
                "inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-fg-muted",
                DISC,
              )}
            >
              +{rest}
            </button>
          }
        >
          <ul className="max-h-[60dvh] space-y-2 overflow-y-auto">
            {people.map((p) => (
              <li key={p.userId}>
                <PersonCard person={p} actions={actions?.(p)} />
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </span>
  );
}
