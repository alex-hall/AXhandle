import { afterAll, expect } from "vitest";
import { Device } from "../src/index.js";
import { InMemoryArtifactSink } from "../src/evidence.js";
import { FixtureAxeDriver } from "../src/testing.js";
import { createAxeTest } from "../src/vitest.js";

const events: string[] = [];
const evidence = new InMemoryArtifactSink();
const failureEvents: string[] = [];
const failureEvidence = new InMemoryArtifactSink();

const test = createAxeTest({
  createDevices: () => ({
    primary: new Device("primary", new FixtureAxeDriver({ AXRole: "Application" }))
  }),
  beforeTest: async () => {
    events.push("before");
  },
  reset: async () => {
    events.push("reset");
  },
  evidence: {
    sink: evidence,
    capture: "always"
  }
});

test("injects devices through a normal Vitest fixture", async ({ devices }) => {
  events.push("test");
  expect(devices.primary).toBeInstanceOf(Device);
});

const failureTest = createAxeTest({
  createDevices: () => ({
    primary: new Device("failure-device", new FixtureAxeDriver({ AXRole: "Application" }))
  }),
  reset: async () => {
    failureEvents.push("reset");
  },
  beforeTest: async () => {
    throw new Error("intentional setup failure");
  },
  evidence: { sink: failureEvidence }
});

failureTest.fails("captures evidence before resetting a failed test", async ({ devices }) => {
  void devices;
});

afterAll(() => {
  expect(events).toEqual(["before", "test", "reset"]);
  expect(evidence.artifacts).toEqual([
    expect.objectContaining({ kind: "accessibility-tree", device: "primary" }),
    expect.objectContaining({ kind: "command-log", device: "primary" })
  ]);
  expect(failureEvents).toEqual(["reset"]);
  expect(failureEvidence.artifacts).toEqual([
    expect.objectContaining({ kind: "accessibility-tree", device: "failure-device" }),
    expect.objectContaining({ kind: "command-log", device: "failure-device" })
  ]);
});
