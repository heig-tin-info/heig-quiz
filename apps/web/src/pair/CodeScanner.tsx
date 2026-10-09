import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import { Button, cx } from "../ui";
import { stationCodeOf, type Decode } from "./scan";

/** The pause between two looks at the camera: a few per second is enough, and spares a phone's battery. */
const INTERVAL_MS = 200;

/**
 * The camera inline in the pairing card, with one Cancel. It reads frames
 * until one holds a station code, then hands that code over ONCE and lets
 * the camera go. The camera is released on every way out: a code, Cancel,
 * the page hidden, the component gone. A QR that is not a station's is
 * named under the video and the scan goes on; nothing is sent for it.
 */
export function CodeScanner({
  decoder,
  onCode,
  onCancel,
  onFail,
}: {
  /** Started by the click that opened the scanner: the decoder's chunk is fetched only then. */
  decoder: Promise<Decode>;
  onCode: (code: string) => void;
  onCancel: () => void;
  onFail: () => void;
}) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [foreign, setForeign] = useState(false);
  // The latest callbacks, read by the one long-lived scan loop of the effect.
  const handlers = useRef({ onCode, onCancel, onFail });
  handlers.current = { onCode, onCancel, onFail };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    void (async () => {
      try {
        const opened = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        const element = video.current!;
        element.srcObject = opened;
        await element.play();
        const decode = await decoder;
        const tick = async () => {
          if (stopped) return;
          const value = await decode(element).catch(() => null);
          if (stopped) return;
          if (value !== null) {
            const code = stationCodeOf(value, window.location.origin);
            if (code !== null) {
              release();
              handlers.current.onCode(code);
              return;
            }
            setForeign(true);
          }
          timer = setTimeout(() => void tick(), INTERVAL_MS);
        };
        void tick();
      } catch {
        if (stopped) return;
        release();
        handlers.current.onFail();
      }
    })();

    const onVisibility = () => {
      if (document.visibilityState !== "hidden" || stopped) return;
      release();
      handlers.current.onCancel();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [decoder]);

  return (
    <div className="flex flex-col gap-2">
      <video
        ref={video}
        muted
        playsInline
        aria-label={t("pair.scan.video")}
        className="aspect-square w-full rounded-card border border-line bg-surface-2 object-cover"
      />
      <p className={cx("text-[13px]", foreign ? "text-warning" : "text-fg-muted")} role="status">
        {t(foreign ? "pair.scan.foreign" : "pair.scan.aim")}
      </p>
      <Button variant="secondary" className="w-full" onClick={onCancel}>
        {t("pair.scan.cancel")}
      </Button>
    </div>
  );
}
