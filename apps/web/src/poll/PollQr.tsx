import { useEffect, useState } from "react";
import { toString as qrToString } from "qrcode";

import { useT } from "../i18n";
import { cx } from "../ui";

/**
 * The QR a room scans, on a white tile (mockup 10).
 *
 * Two things about it are deliberate. The tile does NOT follow the theme —
 * it is white with near-black modules in both, because a camera needs the
 * contrast the code was designed with and an inverted QR is a QR half the
 * phones in the room will not read (see `apps/web/DESIGN.md`, "Projection").
 * And the markup comes from the library rather than from a grid of `<rect>`
 * elements: a real join URL is a 37 × 37 code, which is 1369 DOM nodes
 * redrawn on every frame of a tally that moves twice a second, where the
 * library's two `<path>` elements cost nothing.
 *
 * The string injected is one this browser just generated from `value`; it
 * never carries anything a participant wrote.
 */

/** Modules and background, fixed: a QR is read by a camera, not by a theme. */
const QR_DARK = "#131211";
const QR_LIGHT = "#ffffff";

export function PollQr({
  value,
  label,
  className = "",
}: {
  value: string;
  /** Accessible name — the code itself, so a reader hears what to type. */
  label: string;
  className?: string;
}) {
  const t = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setSvg(null);
    setFailed(false);
    qrToString(value, {
      type: "svg",
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: QR_DARK, light: QR_LIGHT },
    })
      .then((markup) => {
        if (live) setSvg(markup);
      })
      .catch(() => {
        // The code under the QR is the fallback, and it is already on screen.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [value]);

  if (failed) return null;

  return (
    <span
      role="img"
      aria-label={label}
      className={cx(
        "block size-[clamp(88px,9vw,132px)] shrink-0 rounded-[14px] border border-line bg-white p-[clamp(6px,0.6vw,10px)]",
        className,
      )}
    >
      {svg === null ? (
        <span className="sr-only">{t("common.loading")}</span>
      ) : (
        <span
          aria-hidden
          className="block size-full [&>svg]:block [&>svg]:size-full"
          // Locally generated markup, from a URL this page was served; see
          // the note above.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </span>
  );
}
