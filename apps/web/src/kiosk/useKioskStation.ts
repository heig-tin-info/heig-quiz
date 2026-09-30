import { useEffect, useRef, useState } from "react";

import type { KioskDeviceAuthorization, PublicConfig } from "@quiz/contracts";
import { SLOW_DOWN_STEP_S } from "@quiz/domain";

import { attest, authorize, pollToken, type StationTrouble } from "./station";

/** What the station's screen shows (ADR-051 §7). */
export type KioskPhase =
  | { kind: "starting" }
  | { kind: StationTrouble }
  | { kind: "code"; auth: KioskDeviceAuthorization; expiresAt: number }
  | { kind: "opening" };

/** A station that cannot show a code tries again, from the attestation, this often. */
export const KIOSK_RETRY_MS = 30_000;

/** Where an approved station goes: a full navigation, so no history entry leads back here. */
const openExam = (url: string) => window.location.replace(url);

/**
 * The station's loop: attest (§5), ask for a code, poll until a phone
 * approves it — honouring the interval and `slow_down` — and open the exam.
 * An expired, refused or unknown code is renewed; a station out of the
 * registry, or a platform out of reach, says so and starts over every
 * {@link KIOSK_RETRY_MS}. `ready` holds the loop until the public
 * configuration has been read.
 */
export function useKioskStation(
  kiosk: PublicConfig["kiosk"],
  ready: boolean,
  open: (url: string) => void = openExam,
): KioskPhase {
  const [phase, setPhase] = useState<KioskPhase>({ kind: "starting" });
  // The latest `open`: a new function from the caller must not restart the loop.
  const opener = useRef(open);
  opener.current = open;
  // The loop restarts when the configuration CHANGES, not when an equal one is passed again.
  const config = useRef(kiosk);
  config.current = kiosk;
  const configKey = kiosk ? `${kiosk.mock} ${kiosk.extensionId ?? ""}` : null;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = setTimeout(() => {
          timers.delete(id);
          resolve();
        }, ms);
        timers.add(id);
      });

    /**
     * One code, polled until it is approved (`done`), dies (`renew`: the loop
     * attests again before the next, so a station that waits for an hour is
     * never silent when it is paired, ADR-051 §6), or the station cannot go on.
     */
    async function pair(): Promise<StationTrouble | "done" | "renew"> {
      const auth = await authorize();
      if (!alive) return "done";
      if (typeof auth === "string") return auth;
      const expiresAt = Date.now() + auth.expires_in * 1000;
      setPhase({ kind: "code", auth, expiresAt });
      let interval = auth.interval;
      for (;;) {
        await sleep(interval * 1000);
        if (!alive) return "done";
        if (Date.now() >= expiresAt) break;
        const answer = await pollToken(auth.device_code);
        if (!alive) return "done";
        if ("redirect" in answer) {
          setPhase({ kind: "opening" });
          opener.current(answer.redirect);
          return "done";
        }
        if (answer.error === "authorization_pending") continue;
        if (answer.error === "slow_down") {
          interval += SLOW_DOWN_STEP_S;
          continue;
        }
        if (answer.error === "not_recognised") return answer.error;
        // expired_token, access_denied, invalid_grant: a fresh code.
        return "renew";
      }
      return "renew";
    }

    void (async () => {
      // A trouble screen stays up while the station tries again: flashing
      // "starting" every half minute would only draw the eye to it.
      while (alive) {
        const trouble = (await attest(config.current)) ?? (await pair());
        if (!alive || trouble === "done") return;
        if (trouble === "renew") continue;
        setPhase({ kind: trouble });
        await sleep(KIOSK_RETRY_MS);
      }
    })();

    return () => {
      alive = false;
      for (const id of timers) clearTimeout(id);
    };
  }, [configKey, ready]);

  return phase;
}
