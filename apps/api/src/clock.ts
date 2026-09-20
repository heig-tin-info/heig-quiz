/**
 * The server clock, injectable (invariant 5, WP5 rule "tests never sleep").
 *
 * Nothing in the live path calls `new Date()` directly: a route reads
 * `app.clock.now()` and hands the instant to the service, and the ticker does
 * the same. A test therefore drives the deadline boundary, the pause shift
 * and the grace window by moving one object, in microseconds, instead of
 * waiting for the wall clock.
 */
import type { FastifyInstance } from "fastify";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock a test moves by hand. `advance` is the only way time passes. */
export class TestClock implements Clock {
  private current: Date;
  constructor(at: Date | string = "2026-09-20T10:00:00.000Z") {
    this.current = typeof at === "string" ? new Date(at) : new Date(at.getTime());
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(at: Date | string): void {
    this.current = typeof at === "string" ? new Date(at) : new Date(at.getTime());
  }
  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }
}

/** ISO-8601 with milliseconds — the single wire format of every timestamp. */
export const iso = (d: Date): string => d.toISOString();

/** `null` survives the round trip: a missing deadline is not an epoch. */
export const isoOrNull = (d: Date | null | undefined): string | null =>
  d === null || d === undefined ? null : d.toISOString();

declare module "fastify" {
  interface FastifyInstance {
    /** The system clock in production; a `TestClock` in the tests. */
    clock: Clock;
  }
}
