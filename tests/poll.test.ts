import { describe, expect, it } from "vitest";
import { poll, PollTimeoutError } from "../src/index.js";
import type { Clock } from "../src/types.js";

const fakeClock = (): Clock & { elapsed(): number } => {
  let time = 0;
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
    elapsed: () => time
  };
};

describe("poll", () => {
  it("returns as soon as the condition is met", async () => {
    const clock = fakeClock();
    let calls = 0;

    await poll(async () => ++calls >= 1, { timeout: 5_000, interval: 100, clock });

    expect(calls).toBe(1);
    expect(clock.elapsed()).toBe(0);
  });

  it("evaluates at least once even with a zero timeout", async () => {
    const clock = fakeClock();
    let calls = 0;

    await expect(
      poll(
        async () => {
          calls += 1;
          return false;
        },
        { timeout: 0, interval: 100, clock }
      )
    ).rejects.toBeInstanceOf(PollTimeoutError);
    expect(calls).toBe(1);
  });

  it("spends the full budget: one final evaluation lands at the deadline", async () => {
    const clock = fakeClock();
    let calls = 0;

    // t=0 false, t=100 false, t=200 (the deadline itself) succeeds — a loop
    // that checked the deadline before evaluating would fail here.
    await poll(async () => ++calls === 3, { timeout: 200, interval: 100, clock });

    expect(calls).toBe(3);
    expect(clock.elapsed()).toBe(200);
  });

  it("clamps the last sleep so the interval cannot overshoot the deadline", async () => {
    const clock = fakeClock();

    await expect(
      poll(async () => false, { timeout: 250, interval: 100, clock })
    ).rejects.toBeInstanceOf(PollTimeoutError);

    expect(clock.elapsed()).toBe(250);
  });

  it("throws the caller's error when onTimeout is provided", async () => {
    await expect(
      poll(async () => false, {
        timeout: 0,
        interval: 100,
        clock: fakeClock(),
        onTimeout: () => new RangeError("still missing")
      })
    ).rejects.toThrow(RangeError);
  });
});
