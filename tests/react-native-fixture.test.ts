import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Device } from "../src/index.js";
import { FixtureAxeDriver, fixtureTree } from "../src/testing.js";
import { axeMatchers } from "../src/vitest.js";
import type { AxeFixture } from "../src/testing.js";

expect.extend(axeMatchers);

const fixturePath = fileURLToPath(
  new URL("./fixtures/react-native-sample.initial.json", import.meta.url)
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as AxeFixture;

describe("captured React Native accessibility fixture", () => {
  it("preserves semantic native roles and identifiers from AXe", async () => {
    const device = new Device("react-native-fixture", new FixtureAxeDriver(fixtureTree(fixture)));

    await expect(device.findByTestId("sample-root")).toBeVisible();
    await expect(device.findByRole("button", { name: "Use Alice" })).toBeVisible();
    await expect(device.findByRole("button", { name: "Use Bob" })).toBeVisible();
    await expect(device.findByTestId("composer")).toBeVisible();
    await expect(device.findByText("AXe React Native Sample")).toBeVisible();
    await expect(device.findByRole("text field", { name: "Message" })).toBeVisible();
    await expect(device.findByRole("button", { name: "Send" })).toBeDisabled();
    await expect(device.findByRole("switch", { name: "Notifications" })).toBeVisible();
    await expect(device.findByRole("link", { name: "Details" })).toBeVisible();
  });
});
