import { useState } from "react";

import type { Me } from "@quiz/contracts";

import { cx, Tip, useCoarsePointer } from "./layers";

// Identity: a person or an organization as their picture, or their initials,
// and the GitHub mark (the one brand an identity here is tied to).

/**
 * The picture-or-initials flow of every avatar: the URL to show, or null
 * when there is none OR it failed to load (a stale IdP URL, a deleted
 * organization — a broken-image glyph is not a face). The failure is kept
 * per URL, so a new `src` gets its own chance.
 */
function usePicture(src: string | null | undefined): [string | null, () => void] {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = src && src !== failed ? src : null;
  return [shown, () => setFailed(src ?? null)];
}

/**
 * A person: their picture, or their initials when there is none OR when it
 * fails to load — an IdP picture URL goes stale, and the browser's
 * broken-image glyph is not a face. `label` is the full name, for an avatar
 * standing alone (a row of colleagues): it names the picture and shows as a
 * `Tip`, never as a native `title`. Leave it out when the name is written
 * beside the avatar, where a bubble would only repeat it.
 *
 * A picture that loaded shows larger in that same `Tip` on hover, with the
 * name under it when there is a `label`: at most `PREVIEW_MAX` px, never
 * upscaled past its natural size. The copy is decorative (`alt=""`, the
 * bubble is aria-hidden), initials have none, and a touch screen has none.
 */
export function PersonAvatar({
  name,
  src,
  label,
  tone = "muted",
  className = "size-7 text-xs",
}: {
  /** Given name, family name. */
  name: [string, string];
  src: string | null | undefined;
  label?: string;
  /** `accent` is the signed-in user's own disc; everyone else is `muted`. */
  tone?: "muted" | "accent";
  className?: string;
}) {
  const [picture, onError] = usePicture(src);
  // The side of the enlarged picture, once it has loaded; 0 = no preview.
  const [preview, setPreview] = useState(0);
  const coarse = useCoarsePointer();
  return (
    <Tip
      label={label}
      className="inline-flex shrink-0"
      media={
        !picture || coarse ? undefined : preview > 0 ? (
          <img
            src={picture}
            alt=""
            referrerPolicy="no-referrer"
            style={{ width: preview, height: preview }}
            className="block rounded-md object-cover"
          />
        ) : null
      }
    >
      {picture ? (
        <img
          src={picture}
          alt={label ?? ""}
          referrerPolicy="no-referrer"
          onLoad={(e) => setPreview(previewSize(e.currentTarget))}
          onError={onError}
          className={cx("shrink-0 rounded-full object-cover", className)}
        />
      ) : (
        <Initials name={name} tone={tone} label={label} className={className} />
      )}
    </Tip>
  );
}

/** The enlarged avatar's ceiling, in CSS pixels. */
const PREVIEW_MAX = 176;

/**
 * The side of the enlarged picture: at most `PREVIEW_MAX`, never past the
 * image's own pixels (an IdP picture may be small), and 0 — no preview — when
 * that would not be larger than the disc already on screen.
 */
function previewSize(img: HTMLImageElement): number {
  const side = Math.min(PREVIEW_MAX, img.naturalWidth, img.naturalHeight);
  return side > img.offsetWidth ? side : 0;
}

/** The signed-in user's avatar: initials on the accent colour as fallback. */
export function Avatar({ me, className = "size-16 text-xl" }: { me: Me; className?: string }) {
  return (
    <PersonAvatar
      name={[me.givenName, me.familyName]}
      src={me.avatarUrl}
      tone="accent"
      className={className}
    />
  );
}

/**
 * Initials disc (no account picture, or one that failed): the two initials
 * of `name`, or `text` as given. A disc unless `shape` names another corner
 * (the organization's soft square): a prop rather than a class in
 * `className`, because `cx` joins classes and does not merge them, so a
 * second `rounded-*` would lose to `rounded-full` by stylesheet order.
 */
export function Initials({
  name,
  text,
  tone = "muted",
  label,
  shape = "rounded-full",
  className = "size-7 text-xs",
}: {
  name?: [string, string];
  /** The letters to show, when they are not a person's initials. */
  text?: string;
  tone?: "muted" | "accent";
  /** The full name, when the disc stands alone and must be announced. */
  label?: string;
  shape?: string;
  className?: string;
}) {
  const initials = text ?? (name ? `${name[0].charAt(0)}${name[1].charAt(0)}`.toUpperCase() : "");
  const colors =
    tone === "accent"
      ? "bg-accent font-semibold text-on-fill"
      : "bg-surface-3 font-semibold text-fg-muted";
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={cx("inline-flex shrink-0 items-center justify-center", shape, colors, className)}
    >
      {initials || "?"}
    </span>
  );
}

/**
 * An organization's initials, from its login: the first letter of the first
 * two words (`heig-tin-info` ⇒ "HT"), or its first two letters when it is one
 * word (`octocat` ⇒ "OC").
 */
export function orgInitials(login: string): string {
  const words = login.split(/[-_.\s]+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]!.charAt(0)}${words[1]!.charAt(0)}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

/**
 * The three sizes of an organization's picture, each with the corner that
 * keeps it a soft square (DESIGN.md › OrgAvatar): the sidebar, a list row, a
 * page header. At 16 px two letters are a smudge, so the smallest shows one.
 */
const ORG_SIZES = {
  xs: { box: "size-4 text-[9px]", shape: "rounded-key", letters: 1 },
  sm: { box: "size-6 text-[10px]", shape: "rounded-key", letters: 2 },
  md: { box: "size-9 text-xs", shape: "rounded-field", letters: 2 },
} as const;

/**
 * An organization (the GitHub owner of a classroom's repositories): its
 * picture, or its initials when there is none or it fails to load. A soft
 * square, never a disc — a disc is a person. Decorative: the name is written
 * beside it. `src` is a same-origin URL the API serves (M2-02); the browser
 * never loads github.com, which would hand the viewer's IP to GitHub.
 */
export function OrgAvatar({
  login,
  src,
  size = "sm",
  className,
}: {
  /** The organization's login, e.g. `heig-tin-info`. */
  login: string;
  src?: string;
  size?: keyof typeof ORG_SIZES;
  className?: string;
}) {
  const [picture, onError] = usePicture(src);
  const { box, shape, letters } = ORG_SIZES[size];
  if (picture) {
    return <img src={picture} alt="" onError={onError} className={cx("shrink-0 object-cover", shape, box, className)} />;
  }
  return <Initials text={orgInitials(login).slice(0, letters)} shape={shape} className={cx(box, className)} />;
}

/**
 * The GitHub mark, drawn in `currentColor`. It has the shape of an
 * `IconType`, so it goes wherever a lucide icon goes (`Button`, `Actions`,
 * `Badge`, `EmptyState`), and it is sized the same way: a lucide icon is
 * 24 × 24 until a `size-*` class says otherwise, and its round glyphs span
 * 20 of those 24 units. The mark fills its own 16-unit box edge to edge, so
 * the view box leaves the same one-twelfth margin around it — at `size-4`
 * beside a `Pencil` or a `Users`, the disc reads as the same size, not one
 * step larger. Decorative: the text beside it names the thing.
 */
export function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="-1.6 -1.6 19.2 19.2"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
