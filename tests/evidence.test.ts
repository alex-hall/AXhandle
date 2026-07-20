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
  const tree = (marker: string) => ({
    kind: "accessibility-tree" as const,
    device: marker.split(":")[0] ?? marker,
    contentType: "application/json" as const,
    body: { marker }
  });

  it("materializes JSON and text artifacts as files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "axhandle-evidence-"));
    const sink = new DirectoryArtifactSink(dir);

    await sink.write(tree("primary:only"));
    await sink.write({
      kind: "capture-error",
      device: "primary",
      contentType: "text/plain",
      message: "screenshot failed"
    });
    // Screenshots are already on disk at their own path — nothing to write.
    await sink.write({
      kind: "screenshot",
      device: "primary",
      contentType: "image/png",
      path: join(dir, "never-created.png")
    });

    expect(readdirSync(dir).sort()).toEqual([
      "primary-accessibility-tree.json",
      "primary-capture-error.txt"
    ]);
    expect(
      JSON.parse(readFileSync(join(dir, "primary-accessibility-tree.json"), "utf8"))
    ).toEqual({ marker: "primary:only" });
    expect(readFileSync(join(dir, "primary-capture-error.txt"), "utf8")).toBe(
      "screenshot failed"
    );
    expect(existsSync(join(dir, "never-created.png"))).toBe(false);
  });

  it("never clobbers evidence across devices or repeated captures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "axhandle-evidence-"));
    const sink = new DirectoryArtifactSink(dir);

    // One suite-wide sink sees one capture per device per failing test:
    // two devices in the first failing test, then a second failing test.
    await sink.write(tree("alice:test-1"));
    await sink.write(tree("bob:test-1"));
    await sink.write(tree("alice:test-2"));

    expect(readdirSync(dir).sort()).toEqual([
      "alice-accessibility-tree-2.json",
      "alice-accessibility-tree.json",
      "bob-accessibility-tree.json"
    ]);
    expect(
      JSON.parse(readFileSync(join(dir, "alice-accessibility-tree.json"), "utf8"))
    ).toEqual({ marker: "alice:test-1" });
    expect(
      JSON.parse(readFileSync(join(dir, "alice-accessibility-tree-2.json"), "utf8"))
    ).toEqual({ marker: "alice:test-2" });
    expect(
      JSON.parse(readFileSync(join(dir, "bob-accessibility-tree.json"), "utf8"))
    ).toEqual({ marker: "bob:test-1" });
  });

  it("keeps hostile device names inside the evidence directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "axhandle-evidence-"));
    const sink = new DirectoryArtifactSink(dir);

    await sink.write({
      kind: "capture-error",
      device: "../escape attempt",
      contentType: "text/plain",
      message: "contained"
    });

    // ".." survives as an inert file-name PREFIX; the path separator does not.
    expect(readdirSync(dir)).toEqual(["..-escape-attempt-capture-error.txt"]);
  });
});
