import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Device } from "../src/index.js";
import { FixtureAxeDriver, fixtureTree } from "../src/testing.js";
import { axeMatchers } from "../src/vitest.js";
import type { AxeFixture } from "../src/testing.js";

expect.extend(axeMatchers);

const fixturePath = fileURLToPath(
  new URL("./fixtures/swiftui-sample.initial.json", import.meta.url)
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as AxeFixture;

describe("captured SwiftUI accessibility fixture", () => {
  it("uses semantic roles and labels while preserving native role differences", async () => {
    const device = new Device("swiftui-fixture", new FixtureAxeDriver(fixtureTree(fixture)));

    await expect(device.findByTestId("sample-root")).toBeVisible();
    await expect(device.findByRole("text field", { name: "Message" })).toBeVisible();
    await expect(device.findByRole("button", { name: "Send" })).toBeDisabled();
    await expect(device.findByRole("switch", { name: "Notifications" })).toBeVisible();
    // SwiftUI NavigationLink is currently exposed by AXe as a button, unlike
    // the React Native sample's Pressable with an explicit link role.
    await expect(device.findByRole("button", { name: "Details" })).toBeVisible();
  });
});
