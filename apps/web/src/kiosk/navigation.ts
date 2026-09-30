/**
 * How a kiosk station's pages leave a sitting (ADR-051 §7): ONE way back to
 * the station's screen, and ONE way to learn that the sitting's session has
 * ended while the page only waits (a lobby the teacher closed).
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { meKey } from "../queryKeys";
import { useEventStream } from "../realtime/useEventStream";

/** How long a station shows the end of an attempt before its own screen. */
export const STATION_END_MS = 8_000;

/** Back to the station's screen: a full navigation, with no history entry to come back by. */
export function toKiosk(): void {
  window.location.replace("/kiosk");
}

/**
 * Joins the page's event stream on a kiosk session (without watching
 * anything of its own) to hear it drop. The server closes the streams of a
 * session it ends; the session is then asked again, {@link STATION_END_MS}
 * later — so that a closed screen is not cut short — and a session that is
 * gone signs the page out, whose `/take` then returns to `/kiosk`
 * (`StationOrLanding`). A mere network blip costs one `/me`.
 */
export function useStationSessionWatch(onStation: boolean): void {
  const qc = useQueryClient();
  const { connected } = useEventStream({ enabled: onStation, safetyRefetch: false });
  const dropped = onStation && !connected;
  useEffect(() => {
    if (!dropped) return;
    const id = setTimeout(() => void qc.invalidateQueries({ queryKey: meKey }), STATION_END_MS);
    return () => clearTimeout(id);
  }, [dropped, qc]);
}
