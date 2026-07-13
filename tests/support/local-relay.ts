import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

interface RelayMessage {
  id: number;
  from: string;
  body: string;
}

export interface LocalRelay {
  readonly url: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A deliberately tiny, public-only relay used by the two-simulator sample. */
export async function startLocalRelay(port = 4100): Promise<LocalRelay> {
  let nextId = 1;
  let messages: RelayMessage[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Access-Control-Allow-Origin", "*");

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { status: "ok" });
    }

    if (request.method === "DELETE" && url.pathname === "/messages") {
      messages = [];
      nextId = 1;
      return sendJson(response, 204);
    }

    if (request.method === "GET" && url.pathname === "/messages") {
      const recipient = url.searchParams.get("recipient");
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!recipient || !Number.isInteger(after) || after < 0) {
        return sendJson(response, 400, { error: "recipient and non-negative after are required" });
      }
      return sendJson(response, 200, {
        messages: messages.filter((message) => message.from !== recipient && message.id > after)
      });
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      try {
        const body = await readJson(request);
        if (!isMessage(body)) {
          return sendJson(response, 400, { error: "from and body are required strings" });
        }
        const message = { id: nextId++, from: body.from, body: body.body };
        messages.push(message);
        return sendJson(response, 201, { message });
      } catch {
        return sendJson(response, 400, { error: "expected valid JSON" });
      }
    }

    return sendJson(response, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    reset: async () => {
      messages = [];
      nextId = 1;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const isMessage = (value: unknown): value is Pick<RelayMessage, "from" | "body"> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { from?: unknown }).from === "string" &&
  (value as { from: string }).from.trim().length > 0 &&
  typeof (value as { body?: unknown }).body === "string" &&
  (value as { body: string }).body.trim().length > 0;

const sendJson = (
  response: ServerResponse,
  status: number,
  body?: unknown
): void => {
  response.statusCode = status;
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
};
