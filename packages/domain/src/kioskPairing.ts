/**
 * The pairing of a kiosk station with a student's phone (ADR-051 §7): the
 * device authorization grant of RFC 8628, adapted. Pure: the random bytes and
 * the current instant are always passed in.
 *
 *  - the USER CODE the station shows and the student types: 8 characters as
 *    `XXXX-XXXX`, on an alphabet with no vowel (no word to spell) and none of
 *    `0 O 1 I L` (nothing to misread from two metres);
 *  - the STATE MACHINE of a pairing: `pending → approved → consumed`, and
 *    `pending | approved → expired` once its time is up;
 *  - the ANSWER to a station's poll of the token endpoint (RFC 8628 §3.5).
 */

/** 27 symbols: the consonants but L, and the digits but 0 and 1. */
export const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
/** The characters of a code, without its dash. */
export const USER_CODE_LENGTH = 8;

/**
 * The largest multiple of the alphabet's size a byte can hold (243 = 27 × 9):
 * a byte at or above it is thrown away, so every symbol is equally likely —
 * `byte % 27` over all 256 values would favour the first 13.
 */
const UNBIASED_BELOW = 256 - (256 % USER_CODE_ALPHABET.length);

/** `ABCDEFGH` → `ABCD-EFGH`. */
const dashed = (raw: string) => `${raw.slice(0, 4)}-${raw.slice(4)}`;

/**
 * A fresh user code, `XXXX-XXXX`, drawn from `randomBytes` (the server's CSPRNG)
 * by rejection sampling. It asks for more bytes whenever a batch runs out.
 */
export function generateUserCode(randomBytes: (n: number) => Uint8Array): string {
  let code = "";
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of randomBytes(USER_CODE_LENGTH * 2)) {
      if (byte >= UNBIASED_BELOW) continue;
      code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (code.length === USER_CODE_LENGTH) break;
    }
  }
  return dashed(code);
}

/**
 * What a student typed, in the one canonical form (`XXXX-XXXX`), or null when
 * it cannot be a code: lower case, spaces and a missing or doubled dash are
 * forgiven; a symbol outside the alphabet, or the wrong length, is not.
 */
export function normalizeUserCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]+/g, "");
  if (raw.length !== USER_CODE_LENGTH) return null;
  for (const ch of raw) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return dashed(raw);
}

// --- The state machine -----------------------------------------------------

export const PAIRING_STATES = ["pending", "approved", "consumed", "expired"] as const;
export type PairingState = (typeof PAIRING_STATES)[number];
export type PairingEvent = "approve" | "consume" | "expire";

const TRANSITIONS: Record<PairingState, Partial<Record<PairingEvent, PairingState>>> = {
  pending: { approve: "approved", expire: "expired" },
  approved: { consume: "consumed", expire: "expired" },
  consumed: {},
  expired: {},
};

/** The state `event` leads to from `state`, or null when the transition is illegal. */
export function pairingTransition(state: PairingState, event: PairingEvent): PairingState | null {
  return TRANSITIONS[state][event] ?? null;
}

/**
 * The state a stored pairing is really in at `now`: a pending or approved
 * pairing past its `expiresAt` is expired, whatever its row still says.
 */
export function pairingStateAt(state: PairingState, expiresAt: Date, now: Date): PairingState {
  return now.getTime() >= expiresAt.getTime()
    ? (pairingTransition(state, "expire") ?? state)
    : state;
}

// --- The station's poll (RFC 8628 §3.4–3.5) --------------------------------

/** The seconds a station waits between two polls, at first (ADR-051 §7). */
export const PAIRING_INTERVAL_S = 2;
/** What `slow_down` adds to the interval (RFC 8628 §3.5). */
export const SLOW_DOWN_STEP_S = 5;
/** How long a code lives (ADR-051 §7). */
export const PAIRING_EXPIRES_IN_S = 300;

export type PairingPollOutcome =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "approved";

/**
 * The answer to one poll of the token endpoint, and the interval the station
 * must keep from now on. A consumed pairing is `access_denied`: its session
 * was handed out once, never twice. Polling a pending pairing sooner than the
 * interval is `slow_down`, and the interval grows by five seconds for good.
 * An approved pairing is handed out however fast it was asked for.
 */
export function pollAnswer(input: {
  state: PairingState;
  expiresAt: Date;
  lastPollAt: Date | null;
  interval: number;
  now: Date;
}): { outcome: PairingPollOutcome; interval: number } {
  const { interval, now } = input;
  const state = pairingStateAt(input.state, input.expiresAt, now);
  switch (state) {
    case "expired":
      return { outcome: "expired_token", interval };
    case "consumed":
      return { outcome: "access_denied", interval };
    case "approved":
      return { outcome: "approved", interval };
    case "pending": {
      const tooSoon =
        input.lastPollAt !== null && now.getTime() - input.lastPollAt.getTime() < interval * 1000;
      return tooSoon
        ? { outcome: "slow_down", interval: interval + SLOW_DOWN_STEP_S }
        : { outcome: "authorization_pending", interval };
    }
  }
}
