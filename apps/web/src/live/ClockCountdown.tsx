import { memo, type ComponentProps } from "react";

import { Countdown, useNow } from "../ui";

/**
 * A `Countdown` that ticks by itself, once a second, on the clock it is
 * given — the SERVER's on the live path (`useServerClock().now`), so every
 * countdown of a screen reads one time and the deadline stays the server's
 * (invariant 5).
 *
 * The tick lives here, in the leaf, and nowhere above it: the player and the
 * live dashboard hand down a stable `clock` function rather than a `now` that
 * changes every second, so a tick re-renders the digits and not the question
 * editor or the thirty-by-twelve grid around them. All of them share the one
 * timer of `useNow`, so two countdowns on a screen never disagree.
 */
export const ClockCountdown = memo(function ClockCountdown({
  clock,
  ...countdown
}: Omit<ComponentProps<typeof Countdown>, "now"> & {
  /** The time to count against; must be stable, it is re-read every tick. */
  clock: () => number;
}) {
  const now = useNow(1_000, clock);
  return <Countdown {...countdown} now={now} />;
});
