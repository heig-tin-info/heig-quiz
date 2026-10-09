import { normalizeUserCode } from "@quiz/domain";

/**
 * The station code a scanned QR carries, or null when it is not one. Two
 * shapes only: this site's own `/pair?code=…` (what a station shows, ADR-051
 * §7), or a bare code. Anything else — another site, another page, a code
 * that cannot be one — is refused: the value is never navigated to, and a
 * refusal sends nothing (every wrong look-up counts against the student).
 */
export function stationCodeOf(value: string, origin: string): string | null {
  const text = value.trim();
  const bare = normalizeUserCode(text);
  if (bare !== null) return bare;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname.replace(/\/+$/, "") !== "/pair") return null;
  return normalizeUserCode(url.searchParams.get("code") ?? "");
}

/** Whether this browser can open a camera at all: the scan button is offered only then. */
export const canScan = (): boolean => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** One look at the current frame of the video: the text of a QR in it, or null. */
export type Decode = (video: HTMLVideoElement) => Promise<string | null>;

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};

/** The longer side of the frame jsQR reads: enough for a station's QR, cheap on the main thread. */
const FRAME = 640;

/**
 * The browser's own `BarcodeDetector` when it reads QR codes; otherwise
 * jsQR (Apache-2.0), loaded here only, on the main thread over a downscaled
 * canvas frame — no worker, so the CSP needs no `blob:` nor `worker-src`.
 */
export async function loadDecoder(): Promise<Decode> {
  const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  const formats = Native ? await Native.getSupportedFormats().catch((): string[] => []) : [];
  if (Native && formats.includes("qr_code")) {
    const detector = new Native({ formats: ["qr_code"] });
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
  }
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    const { videoWidth: w, videoHeight: h } = video;
    if (!context || w === 0 || h === 0) return null;
    const scale = Math.min(1, FRAME / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  };
}
