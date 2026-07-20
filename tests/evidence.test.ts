import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureDeviceEvidence,
  Device,
  DirectoryArtifactSink,
  InMemoryArtifactSink
} from "../src/index.js";
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
      expect.objectContaining({ kind: "raw-accessibility-tree", device: "primary" }),
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

describe("DirectoryArtifactSink", () => {
  it("materializes JSON and text artifacts as files, one directory per capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "axhandle-evidence-"));
    const sink = new DirectoryArtifactSink(dir);

    await sink.write({
      kind: "accessibility-tree",
      device: "primary",
      contentType: "application/json",
      body: { root: { role: "application", visible: true, children: [] } }
    });
    await sink.write({
      kind: "capture-error",
      device: "primary",
      contentType: "text/plain",
      message: "first failure"
    });
    await sink.write({
      kind: "capture-error",
      device: "primary",
      contentType: "text/plain",
      message: "second failure"
    });
    // Screenshots are already on disk at their own path — nothing to write.
    await sink.write({
      kind: "screenshot",
      device: "primary",
      contentType: "image/png",
      path: join(dir, "never-created.png")
    });

    expect(readdirSync(dir).sort()).toEqual([
      "accessibility-tree.json",
      "capture-error-1.txt",
      "capture-error-2.txt"
    ]);
    expect(JSON.parse(readFileSync(join(dir, "accessibility-tree.json"), "utf8"))).toMatchObject({
      root: { role: "application" }
    });
    expect(readFileSync(join(dir, "capture-error-2.txt"), "utf8")).toBe("second failure");
    expect(existsSync(join(dir, "never-created.png"))).toBe(false);
  });
});
