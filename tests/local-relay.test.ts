import { afterEach, describe, expect, it } from "vitest";
import { startLocalRelay } from "./support/local-relay.js";

let relay: Awaited<ReturnType<typeof startLocalRelay>> | undefined;

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("local relay", () => {
  it("delivers each message to peers but not its sender", async () => {
    relay = await startLocalRelay(0);
    const created = await fetch(`${relay.url}/messages`, {
      body: JSON.stringify({ from: "Alice", body: "Hello Bob" }),
      headers: { "Content-Type": "application/json" },
      method: "POST"
    });

    expect(created.status).toBe(201);
    await expect(fetch(`${relay.url}/messages?recipient=Alice&after=0`).then((result) => result.json()))
      .resolves.toEqual({ messages: [] });
    await expect(fetch(`${relay.url}/messages?recipient=Bob&after=0`).then((result) => result.json()))
      .resolves.toEqual({
        messages: [{ id: 1, from: "Alice", body: "Hello Bob" }]
      });
  });
});
