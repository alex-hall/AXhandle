import { describe, expect, it } from "vitest";
import { fixtureTree } from "../src/testing.js";

describe("fixtureTree", () => {
  it("accepts a fixture that conforms to the versioned fixture schema", () => {
    const tree = { AXRole: "Application", AXChildren: [] };

    expect(fixtureTree({
      formatVersion: 1,
      metadata: {
        source: "captured",
        axeVersion: "1.7.1",
        xcodeVersion: "26.6",
        runtime: "iOS 26.5",
        device: "iPhone 17",
        orientation: "portrait"
      },
      tree
    })).toBe(tree);
  });

  it.each([
    { formatVersion: 1, metadata: [], tree: {} },
    { formatVersion: 1, metadata: { source: "private" }, tree: {} },
    { formatVersion: 1, metadata: { source: "synthetic", extra: true }, tree: {} },
    { formatVersion: 1, metadata: { source: "synthetic" }, tree: "not a tree" },
    { formatVersion: 1, metadata: { source: "synthetic" }, tree: {}, extra: true }
  ])("rejects malformed fixture input %#", (fixture) => {
    expect(() => fixtureTree(fixture)).toThrow(TypeError);
  });
});
