import { useCallback, useState } from "react";

import type { Me } from "@quiz/contracts";

import { cx, Tip, useCoarsePointer } from "./layers";

// Identity: a person as their picture, or their initials.

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
  // A cached picture may be complete before React listens for `load`, so the
  // ref measures too.
  const measure = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setPreview(previewSize(img));
  }, []);
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
          ref={measure}
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
