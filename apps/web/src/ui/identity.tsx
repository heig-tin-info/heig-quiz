import { useState } from "react";

import type { Me } from "@quiz/contracts";

import { cx, Tip, useCoarsePointer } from "./layers";

// Identity: a person or an organization as their picture, or their initials.

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
  const [failed, setFailed] = useState(false);
  // The side of the enlarged picture, once it has loaded; 0 = no preview.
  const [preview, setPreview] = useState(0);
  const coarse = useCoarsePointer();
  const picture = src && !failed;
  return (
    <Tip
      label={label}
      className="inline-flex shrink-0"
      media={
        !picture || coarse ? undefined : preview > 0 ? (
          <img
            src={src}
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
          src={src}
          alt={label ?? ""}
          referrerPolicy="no-referrer"
          onLoad={(e) => setPreview(previewSize(e.currentTarget))}
          onError={() => setFailed(true)}
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

/** Initials disc (no account picture, or one that failed). */
export function Initials({
  name,
  tone = "muted",
  label,
  className = "size-7 text-xs",
}: {
  name: [string, string];
  tone?: "muted" | "accent";
  /** The full name, when the disc stands alone and must be announced. */
  label?: string;
  className?: string;
}) {
  const initials = `${name[0].charAt(0)}${name[1].charAt(0)}`.toUpperCase() || "?";
  const colors =
    tone === "accent"
      ? "bg-accent font-semibold text-on-fill"
      : "bg-surface-3 font-semibold text-fg-muted";
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${colors} ${className}`}
    >
      {initials}
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
 * The three sizes of an organization's picture, each with the corner of the
 * radius scale that keeps it a soft square (DESIGN.md › OrgAvatar): the
 * sidebar, a list row, a page header. At 16 px two letters are a smudge, so
 * the smallest shows one.
 */
const ORG_SIZES = {
  xs: { box: "size-4 rounded-sm text-[9px]", letters: 1 },
  sm: { box: "size-6 rounded-key text-[10px]", letters: 2 },
  md: { box: "size-9 rounded-field text-xs", letters: 2 },
} as const;

/**
 * An organization (the GitHub owner of a classroom's repositories): its
 * public picture, or its initials when there is none (`src={null}`) or when
 * it fails to load. A soft square, never a disc — a disc is a person.
 * Decorative beside the name; `label` names it when it stands alone.
 */
export function OrgAvatar({
  login,
  src = `https://github.com/${login}.png?size=96`,
  size = "sm",
  label,
  className,
}: {
  /** The organization's login, e.g. `heig-tin-info`. */
  login: string;
  /** Defaults to GitHub's public picture of the login; `null` when none is known. */
  src?: string | null;
  size?: keyof typeof ORG_SIZES;
  /** The organization's name, when the picture stands alone and must be announced. */
  label?: string;
  className?: string;
}) {
  // The URL that failed, so that a new `src` gets its own chance to load.
  const [failed, setFailed] = useState<string | null>(null);
  const { box, letters } = ORG_SIZES[size];
  const frame = cx("inline-flex shrink-0", box, className);
  if (src && src !== failed) {
    return (
      <img
        src={src}
        alt={label ?? ""}
        referrerPolicy="no-referrer"
        onError={() => setFailed(src)}
        className={cx(frame, "object-cover")}
      />
    );
  }
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={cx(frame, "items-center justify-center bg-surface-3 font-semibold text-fg-muted")}
    >
      {orgInitials(login).slice(0, letters)}
    </span>
  );
}
