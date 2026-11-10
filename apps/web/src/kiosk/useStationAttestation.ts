/**
 * The attestation of a station while its kiosk session sits (ADR-051 §6),
 * through the very flow the station's screen uses (`station.ts`). The
 * attempt route holds it from its first screen, the waiting room included,
 * to the end screen:
 *
 *  - it attests AT ONCE, then every {@link KIOSK_REATTEST_MS}. The schedule
 *    starts at that first attestation, never at whatever the station did
 *    before: the pairing screen's last one may be minutes old, and the
 *    server calls a station silent `KIOSK_SILENT_AFTER_MS` after it
 *    (issue #1076);
 *  - an attestation that fails, or a write answered `423 kiosk_suspended`
 *    (refused, or silent), is tried again every {@link KIOSK_RETRY_MS} until
 *    one is accepted: a lost request must not leave the station silent for a
 *    whole round. The suspension lifts by itself, and the autosave, which
 *    kept every answer and kept retrying, catches up. Only the 423 covers
 *    the page with the notice: a failure the server did not act on shows
 *    nothing;
 *  - `423 kiosk_attestation_stale` on the submit: re-attest, retry once.
 *
 * One attestation at a time: a call made while one is in flight joins it.
 * The server records each attempt against the station's cookie and decides
 * what it means; the page only learns the verdict from its writes.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { KIOSK_REATTEST_MS } from "@quiz/domain";

import { KIOSK_SUSPENDED_EVENT, refusedWith, usePublicConfig } from "../api";
import { attest } from "./station";
import { KIOSK_RETRY_MS } from "./useKioskStation";

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
  // The schedule waits for the configuration, which names the attestation mode.
  const running = active && !config.isLoading;
  const [suspended, setSuspended] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);

  /** One attestation, or the one already in flight; an accepted one lifts the notice. */
  const reattest = useCallback(() => {
    inFlight.current ??= attest(kiosk.current)
      .then((trouble) => {
        setFailed(trouble !== null);
        if (trouble === null) setSuspended(false);
      })
      .finally(() => {
        inFlight.current = null;
      });
    return inFlight.current;
  }, []);

  useEffect(() => {
    if (!active) return;
    const onSuspended = () => setSuspended(true);
    window.addEventListener(KIOSK_SUSPENDED_EVENT, onSuspended);
    return () => window.removeEventListener(KIOSK_SUSPENDED_EVENT, onSuspended);
  }, [active]);

  useEffect(() => {
    if (!running) return;
    void reattest();
    const id = setInterval(() => void reattest(), KIOSK_REATTEST_MS);
    return () => clearInterval(id);
  }, [running, reattest]);

  const retrying = suspended || failed;
  useEffect(() => {
    if (!running || !retrying) return;
    const id = setInterval(() => void reattest(), KIOSK_RETRY_MS);
    return () => clearInterval(id);
  }, [running, retrying, reattest]);

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
