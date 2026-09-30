/**
 * The attestation of a station while it sits an exam (ADR-051 §6): the
 * attempt page re-attests every ten minutes, and before a submit the server
 * found stale,
 * through the very flow the station's screen uses (`station.ts`). The server
 * records each attempt against the station's cookie and decides what it
 * means; the page only learns the verdict from its writes:
 *
 *  - `423 kiosk_suspended` on any write (refused, or silent): the page is
 *    covered by a notice, and re-attests every 30 seconds until one is
 *    accepted — the suspension lifts by itself, and the autosave, which kept
 *    every answer and kept retrying, catches up;
 *  - `423 kiosk_attestation_stale` on the submit: re-attest, retry once.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { KIOSK_SUSPENDED_EVENT, refusedWith, usePublicConfig } from "../api";
import { attest } from "./station";
import { KIOSK_RETRY_MS } from "./useKioskStation";

/** The page re-attests this often; the server calls a station silent after 12 minutes. */
export const REATTEST_MS = 10 * 60_000;

export interface StationAttestation {
  /** A write was refused because the station is suspended, and no attestation has lifted it yet. */
  suspended: boolean;
  /** Runs the submit; when the server finds the station's check stale, re-attests and runs it once more. */
  guardSubmit: <T>(submit: () => Promise<T>) => Promise<T>;
}

export function useStationAttestation(active: boolean): StationAttestation {
  const config = usePublicConfig();
  const kiosk = useRef(config.data?.kiosk ?? null);
  kiosk.current = config.data?.kiosk ?? null;
  const [suspended, setSuspended] = useState(false);

  /** One attestation; an accepted one lifts the notice. */
  const reattest = useCallback(async () => {
    const trouble = await attest(kiosk.current);
    if (trouble === null) setSuspended(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onSuspended = () => setSuspended(true);
    window.addEventListener(KIOSK_SUSPENDED_EVENT, onSuspended);
    const id = setInterval(() => void reattest(), REATTEST_MS);
    return () => {
      window.removeEventListener(KIOSK_SUSPENDED_EVENT, onSuspended);
      clearInterval(id);
    };
  }, [active, reattest]);

  useEffect(() => {
    if (!active || !suspended) return;
    const id = setInterval(() => void reattest(), KIOSK_RETRY_MS);
    return () => clearInterval(id);
  }, [active, suspended, reattest]);

  const guardSubmit = useCallback(
    async <T,>(submit: () => Promise<T>): Promise<T> => {
      try {
        return await submit();
      } catch (error) {
        if (!active || !refusedWith(error, "kiosk_attestation_stale")) throw error;
        await reattest();
        return submit();
      }
    },
    [active, reattest],
  );

  return { suspended, guardSubmit };
}
