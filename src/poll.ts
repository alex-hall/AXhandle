import type { Clock } from "./types.js";
import { systemClock } from "./types.js";

export class PollTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

export interface PollOptions {
  timeout: number;
  interval: number;
  clock?: Clock;
  /** Builds the timeout error; a PollTimeoutError is thrown when omitted. */
  onTimeout?: () => Error;
}

/**
 * The shared deadline/interval loop behind every wait in the library. The
 * condition always runs at least once, and one final time at (or after) the
 * deadline itself, so a short timeout can never truncate the last evaluation
 * a caller paid for.
 */
export async function poll(
  condition: () => Promise<boolean>,
  options: PollOptions
): Promise<void> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + options.timeout;

  for (;;) {
    if (await condition()) return;
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    await clock.sleep(Math.min(options.interval, Math.max(remaining, 1)));
  }

  throw (
    options.onTimeout?.() ??
    new PollTimeoutError(`Condition was not met within ${options.timeout}ms.`)
  );
}
