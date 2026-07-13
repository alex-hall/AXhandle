import { describe, expect, it } from "vitest";
import { captureDeviceEvidence, Device, InMemoryArtifactSink } from "../src/index.js";
import { FixtureAxeDriver } from "../src/testing.js";

describe("captureDeviceEvidence", () => {
  it("collects a normalized tree, optional screenshot result, and command log", async () => {
    const driver = new FixtureAxeDriver({ AXRole: "Application" });
    const device = new Device("primary", driver);
    const sink = new InMemoryArtifactSink();

    await captureDeviceEvidence(device, sink, {
      screenshotPath: () => "artifacts/primary.png"
    });

    expect(sink.artifacts).toEqual([
      expect.objectContaining({ kind: "accessibility-tree", device: "primary" }),
      expect.objectContaining({ kind: "capture-error", device: "primary" }),
      expect.objectContaining({ kind: "command-log", device: "primary" })
    ]);
    expect(sink.artifacts.at(-1)).toMatchObject({
      kind: "command-log",
      body: expect.arrayContaining([
        expect.objectContaining({ command: "inspect", status: "passed" }),
        expect.objectContaining({ command: "screenshot", status: "failed" })
      ])
    });
  });
});
