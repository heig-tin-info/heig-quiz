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
 *  - an attestation that never reached the server is tried again every
 *    {@link KIOSK_RETRY_MS}: a lost request must not leave the station
 *    silent for a whole round. One the server recorded (refused, or Google
 *    unavailable) is tried again after 30 s, 1 min, then every 2 min — each
 *    try costs a call to Google and an audit row; a station out of the
 *    registry waits for the next round. None of these shows anything;
 *  - a write answered `423 kiosk_suspended` (refused, or silent) covers the
 *    page with the notice, and the station re-attests every
 *    {@link KIOSK_RETRY_MS} until one is accepted. The suspension lifts by
 *    itself, and the autosave, which kept every answer and kept retrying,
 *    catches up;
 *  - `423 kiosk_attestation_stale` on the submit: re-attest, retry once.
 *
 * One attestation at a time: a call made while one is in flight joins it.
 * The server records each attempt against the station's cookie and decides
 * what it means; the page only learns the verdict from its writes.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { KIOSK_REATTEST_MS } from "@quiz/domain";

import { KIOSK_SUSPENDED_EVENT, refusedWith, usePublicConfig } from "../api";
import { attestOnce, type AttestOutcome } from "./station";
import { KIOSK_RETRY_MS } from "./useKioskStation";

export interface StationAttestation {
  /** A write was refused because the station is suspended, and no attestation has lifted it yet. */
  suspended: boolean;
  /** Runs the submit; when the server finds the station's check stale, re-attests and runs it once more. */
  guardSubmit: <T>(submit: () => Promise<T>) => Promise<T>;
}

/** The longest wait before a failed attestation the server recorded is tried again. */
const RETRY_CAP_MS = 2 * 60_000;

/**
 * When a station tries again after an attestation that went wrong: soon when
 * nothing reached the server; backing off (30 s, 1 min, then every 2) when it
 * recorded the failure, since each try costs a call to Google and an audit
 * row; never before the next round when the station is out of the registry.
 */
function retryAfter(outcome: AttestOutcome, recorded: number): number | null {
  if (outcome === "ok" || outcome === "revoked") return null;
  if (outcome === "lost") return KIOSK_RETRY_MS;
  return Math.min(KIOSK_RETRY_MS * 2 ** recorded, RETRY_CAP_MS);
}

export function useStationAttestation(active: boolean): StationAttestation {
  const config = usePublicConfig();
  const kiosk = useRef(config.data?.kiosk ?? null);
  kiosk.current = config.data?.kiosk ?? null;
  // A configuration that failed to load is asked for again before each try.
  const refetchConfig = useRef(config.refetch);
  refetchConfig.current = config.refetch;
  // The schedule waits for the configuration, which names the attestation mode.
  const running = active && !config.isLoading;
  const [suspended, setSuspended] = useState(false);
  const [retryMs, setRetryMs] = useState<number | null>(null);
  const recorded = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  /** One attestation, or the one already in flight; an accepted one lifts the notice. */
  const reattest = useCallback(() => {
    inFlight.current ??= (async () => {
      const station = kiosk.current ?? (await refetchConfig.current()).data?.kiosk ?? null;
      const outcome = await attestOnce(station);
      setRetryMs(retryAfter(outcome, recorded.current));
      if (outcome === "refused" || outcome === "unavailable") recorded.current += 1;
      if (outcome === "ok") {
        recorded.current = 0;
        setSuspended(false);
      }
    })().finally(() => {
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

  // A suspended station tries every 30 s whatever the last outcome: it is blocked until one is accepted.
  const retryEvery = suspended ? KIOSK_RETRY_MS : retryMs;
  useEffect(() => {
    if (!running || retryEvery === null) return;
    const id = setInterval(() => void reattest(), retryEvery);
    return () => clearInterval(id);
  }, [running, retryEvery, reattest]);

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
