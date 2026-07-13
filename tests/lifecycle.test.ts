import { describe, expect, it } from "vitest";
import { Device } from "../src/index.js";
import { FixtureAxeDriver } from "../src/testing.js";
import { getAxeCleanupFailures, runAxeTestLifecycle } from "../src/vitest.js";

describe("runAxeTestLifecycle", () => {
  it("preserves a primary test failure while recording evidence, reset, and release failures", async () => {
    const events: string[] = [];
    const primaryError = new Error("primary test failure");
    let received: unknown;

    try {
      await runAxeTestLifecycle({
        deviceProvider: {
          allocate: () => {
            events.push("allocate");
            return { primary: new Device("primary", new FixtureAxeDriver({ AXRole: "Application" })) };
          },
          release: async () => {
            events.push("release");
            throw new Error("release failure");
          }
        },
        evidence: {
          sink: {
            write: async () => {
              events.push("evidence");
              throw new Error("evidence failure");
            }
          }
        },
        reset: async () => {
          events.push("reset");
          throw new Error("reset failure");
        }
      }, async () => {
        events.push("test");
        throw primaryError;
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBe(primaryError);
    expect(events).toEqual([
      "allocate",
      "test",
      "evidence",
      "evidence",
      "reset",
      "release"
    ]);
    expect(getAxeCleanupFailures(received).map((failure) => failure.phase)).toEqual([
      "evidence",
      "reset",
      "release"
    ]);
  });

  it("throws the first cleanup failure after a successful test and still releases the lease", async () => {
    const events: string[] = [];
    const resetError = new Error("reset failure");
    let received: unknown;

    try {
      await runAxeTestLifecycle({
        deviceProvider: {
          allocate: () => {
            events.push("allocate");
            return { primary: new Device("primary", new FixtureAxeDriver({ AXRole: "Application" })) };
          },
          release: async () => {
            events.push("release");
            throw new Error("release failure");
          }
        },
        reset: async () => {
          events.push("reset");
          throw resetError;
        }
      }, async () => {
        events.push("test");
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBe(resetError);
    expect(events).toEqual(["allocate", "test", "reset", "release"]);
    expect(getAxeCleanupFailures(received).map((failure) => failure.phase)).toEqual([
      "reset",
      "release"
    ]);
  });
});
