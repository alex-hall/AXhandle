import { spawn } from "node:child_process";
import {
  AxeCliDriver,
  AxeCommandError,
  AxeCommandTimeoutError,
} from "./axe-cli-driver.js";
import type { AxeDriver, AxeSwipeGesture, AxeTapTarget } from "./types.js";

/** The slice of a child process the serve driver needs; injectable for tests. */
export interface AxeServeProcess {
  readonly stdin: {
    write(chunk: string, callback?: (error?: Error | null) => void): unknown;
  };
  readonly stdout: {
    setEncoding(encoding: "utf8"): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  };
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(): unknown;
}

export interface AxeServeDriverOptions {
  udid: string;
  /** An AXe binary built with `serve` support. Default: `axe`. */
  binary?: string;
  /**
   * Per-command response deadline. A command that gets no response line
   * within it KILLS the serve process — a missed response would pair every
   * later reply with the wrong request, so the stream is never allowed to
   * desynchronize; the next command respawns a fresh process. Default: 30s.
   */
  timeoutMs?: number;
  /** Deadline for the freshly spawned process's ready line. Default: 30s. */
  readyTimeoutMs?: number;
  /**
   * Driver for the operations the line protocol cannot carry — screenshots
   * and text with embedded newlines. Default: an AxeCliDriver on the same
   * binary and udid.
   */
  fallback?: AxeDriver;
  /** Process launcher override; defaults to node's spawn with piped stdio. */
  launch?: (binary: string, args: readonly string[]) => AxeServeProcess;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * An AxeDriver over one long-lived `axe serve` process instead of one CLI
 * invocation per command. Every classic invocation pays a fixed setup cost —
 * loading private frameworks and opening the simulator's accessibility/HID
 * session — before doing any work; serve pays it once, then streams commands
 * as protocol lines, reading exactly one JSON response line per command. The
 * protocol is strictly serial, which matches Device's per-device queue.
 *
 * Requires an AXe build whose CLI has the `serve` subcommand; the stock
 * binary does not. Lifecycle: the process is spawned on first use and
 * respawned on the next command after it dies (simulator reboot, crash,
 * command timeout); `dispose()` tears it down at test end, and it also
 * self-exits when its parent dies and closes stdin.
 */
export class AxeServeDriver implements AxeDriver {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly fallback: AxeDriver;
  private readonly launch: (
    binary: string,
    args: readonly string[],
  ) => AxeServeProcess;
  private child: AxeServeProcess | undefined;
  private pendingResponse: ((line: string) => void) | undefined;
  private ready: Promise<void> | undefined;

  constructor(private readonly options: AxeServeDriverOptions) {
    this.binary = options.binary ?? "axe";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fallback =
      options.fallback ?? new AxeCliDriver({ udid: options.udid });
    this.launch =
      options.launch ??
      ((binary, args) =>
        spawn(binary, [...args], {
          stdio: ["pipe", "pipe", "ignore"],
        }) as unknown as AxeServeProcess);
  }

  async describeUi(): Promise<unknown> {
    const response = await this.request(["describe-ui"]);
    return response.tree;
  }

  async tap(target: AxeTapTarget): Promise<void> {
    if (target.kind === "id") {
      await this.request(["tap", "--id", target.id]);
    } else {
      await this.request([
        "tap",
        "-x",
        String(target.x),
        "-y",
        String(target.y),
      ]);
    }
  }

  /**
   * The wait lives CLIENT-side as short single-attempt taps, not one long
   * serve-side `--wait-timeout`: a long-lived accessibility session can go
   * stale without erroring, and a serve-side wait then polls the stale
   * hierarchy for its whole budget while the element is visibly on screen.
   * Interleaving a `describe-ui` between attempts keeps the session
   * exercised through the recovery-capable dump path. Semantics match the
   * CLI driver: ambiguity fails fast, only genuine absence retries.
   */
  async tapLabel(label: string, waitTimeoutMs?: number): Promise<void> {
    const deadline = Date.now() + (waitTimeoutMs ?? 0);
    for (;;) {
      try {
        await this.request(["tap", "--label", label]);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const absent = message.includes("No accessibility element matched");
        if (!absent || Date.now() >= deadline) throw error;
        await this.request(["describe-ui"]).catch(() => undefined);
      }
    }
  }

  async swipe(gesture: AxeSwipeGesture): Promise<void> {
    await this.request([
      "swipe",
      "--start-x",
      String(gesture.startX),
      "--start-y",
      String(gesture.startY),
      "--end-x",
      String(gesture.endX),
      "--end-y",
      String(gesture.endY),
      ...(gesture.durationMs === undefined
        ? []
        : ["--duration", String(gesture.durationMs / 1000)]),
    ]);
  }

  /**
   * Touch down, hold, touch up — a genuine wall-clock hold between the down
   * and up events, exactly like AxeCliDriver's.
   */
  async longPress(x: number, y: number, holdMs = 1_500): Promise<void> {
    const point = ["-x", String(x), "-y", String(y)];
    await this.request(["touch", ...point, "--down"]);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await this.request(["touch", ...point, "--up"]);
  }

  async type(text: string): Promise<void> {
    if (text.includes("\n") || text.includes("\r")) {
      // The line protocol cannot frame embedded newlines.
      await this.fallback.type(text);
      return;
    }
    await this.request(["type", text]);
  }

  async keyCombo(modifiers: readonly number[], key: number): Promise<void> {
    await this.request([
      "key-combo",
      "--modifiers",
      modifiers.join(","),
      "--key",
      String(key),
    ]);
  }

  async screenshot(output: string): Promise<string> {
    if (!this.fallback.screenshot) {
      throw new Error(
        "The configured fallback driver does not support screenshots.",
      );
    }
    return this.fallback.screenshot(output);
  }

  /** Kill the serve process. Safe to call when not running; the next command respawns. */
  dispose(): void {
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
    this.pendingResponse = undefined;
  }

  // ── Serve process management ─────────────────────────────────────────────

  private async request(args: readonly string[]): Promise<ServeResponse> {
    const line = args.map(quoteToken).join(" ");
    await this.ensureRunning();
    const child = this.child;
    if (!child) {
      throw new AxeCommandError(
        args,
        "serve process died during startup",
        undefined,
        this.binary,
      );
    }

    const raw = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dispose();
        reject(
          new AxeCommandTimeoutError(
            args,
            this.timeoutMs,
            undefined,
            this.binary,
          ),
        );
      }, this.timeoutMs);
      this.pendingResponse = (responseLine) => {
        clearTimeout(timer);
        this.pendingResponse = undefined;
        resolve(responseLine);
      };
      child.stdin.write(`${line}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.dispose();
          reject(new AxeCommandError(args, error.message, error, this.binary));
        }
      });
    });

    let response: ServeResponse;
    try {
      response = JSON.parse(raw) as ServeResponse;
    } catch (error) {
      // A non-JSON line means the protocol itself derailed — kill the
      // process rather than risk pairing later replies with the wrong
      // requests.
      this.dispose();
      throw new AxeCommandError(
        args,
        `serve returned a non-JSON response line: ${raw.slice(0, 500)}`,
        error,
        this.binary,
      );
    }
    if (!response.ok) {
      throw new AxeCommandError(
        args,
        response.error ?? "command failed",
        undefined,
        this.binary,
      );
    }
    return response;
  }

  private ensureRunning(): Promise<void> {
    if (this.child && this.ready) return this.ready;

    const child = this.launch(this.binary, [
      "serve",
      "--udid",
      this.options.udid,
    ]);
    this.child = child;

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      // A killed process can flush one last line after its replacement is
      // already up — route lines only while this child is still current, or
      // a stale reply would be consumed as the new process's response.
      if (this.child !== child) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const responseLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.pendingResponse?.(responseLine);
      }
    });
    child.on("exit", () => {
      if (this.child === child) this.dispose();
    });
    child.on("error", () => {
      // A spawn failure fires "error" with no "exit" — clear the dead child
      // so the next command attempts a fresh spawn instead of awaiting this
      // one's rejected handshake forever.
      if (this.child === child) this.dispose();
    });

    // The first protocol line is {"ready":true} once frameworks and the
    // simulator session are up — the one place the old per-command setup
    // cost is still paid.
    this.ready = new Promise<void>((resolve, reject) => {
      const handshakeArgs = ["serve", "--udid", this.options.udid];
      const timer = setTimeout(() => {
        this.dispose();
        reject(
          new AxeCommandTimeoutError(
            handshakeArgs,
            this.readyTimeoutMs,
            undefined,
            this.binary,
          ),
        );
      }, this.readyTimeoutMs);
      this.pendingResponse = (line) => {
        clearTimeout(timer);
        this.pendingResponse = undefined;
        try {
          const parsed = JSON.parse(line) as { ready?: boolean };
          if (parsed.ready) {
            resolve();
            return;
          }
          throw new Error(`unexpected first line: ${line.slice(0, 500)}`);
        } catch (error) {
          this.dispose();
          reject(
            new AxeCommandError(
              handshakeArgs,
              `serve never became ready: ${line.slice(0, 500)}`,
              error,
              this.binary,
            ),
          );
        }
      };
      child.on("error", (...errorArgs: unknown[]) => {
        clearTimeout(timer);
        const cause = errorArgs[0];
        reject(
          new AxeCommandError(
            handshakeArgs,
            cause instanceof Error ? cause.message : String(cause),
            cause,
            this.binary,
          ),
        );
      });
    });
    return this.ready;
  }
}

interface ServeResponse {
  ok: boolean;
  error?: string;
  tree?: unknown;
}

/**
 * Serve-side tokenizer rules: double quotes with backslash escapes. Flags
 * and plain values stay bare so the wire format matches what the serve
 * tokenizer sees from an interactive session.
 */
const quoteToken = (token: string): string => {
  if (token !== "" && !/[\s"\\]/.test(token)) return token;
  return `"${token.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};
