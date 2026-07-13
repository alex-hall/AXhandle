import { afterAll, expect } from "vitest";
import { Device } from "../src/index.js";
import { FixtureAxeDriver } from "../src/testing.js";
import { createAxeTest } from "../src/vitest.js";

const events: string[] = [];

const test = createAxeTest({
  createDevices: () => ({
    primary: new Device("primary", new FixtureAxeDriver({ AXRole: "Application" }))
  }),
  beforeTest: async () => {
    events.push("before");
  },
  reset: async () => {
    events.push("reset");
  }
});

test("injects devices through a normal Vitest fixture", async ({ devices }) => {
  events.push("test");
  expect(devices.primary).toBeInstanceOf(Device);
});

afterAll(() => {
  expect(events).toEqual(["before", "test", "reset"]);
});
