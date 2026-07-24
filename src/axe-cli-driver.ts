import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AxeDriver, AxeSwipeGesture, AxeTapTarget } from "./types.js";

export interface AxeCommandResult {
  stdout: string;
  stderr: string;
}

export interface AxeCommandRunner {
  run(args: readonly string[]): Promise<AxeCommandResult>;
}

export class AxeCommandError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;
  readonly executable: string;

  constructor(
    args: readonly string[],
    stderr: string,
    cause?: unknown,
    executable = "axe"
  ) {
    const typedText = args[0] === "type" ? args[1] : undefined;
    const safeArgs = redactTypeArgument(args, typedText);
    const safeStderr = redactTypedText(stderr, typedText);

    // A child-process error can include the complete command line. Preserve it
    // for ordinary commands, but never retain it for text entry failures.
    super(
      `AXe command failed: ${executable} ${safeArgs.join(" ")}\n${safeStderr}`.trim(),
      typedText === undefined ? { cause } : undefined
    );
    this.name = "AxeCommandError";
    this.args = safeArgs;
    this.stderr = safeStderr;
    this.executable = executable;
  }
}

const redactTypeArgument = (args: readonly string[], typedText: string | undefined): readonly string[] => {
  if (typedText === undefined) return [...args];
  return args.map((argument, index) => (index === 1 ? "<redacted>" : argument));
};

const redactTypedText = (value: string, typedText: string | undefined): string => {
  if (typedText === undefined || typedText.length === 0) return value;
  return value.replaceAll(typedText, "<redacted>");
};

/**
 * A hung AXe process was killed at its hard deadline. Distinct from
 * AxeCommandError so retry layers can tell "wedged CLI — retrying is
 * right" from "element genuinely absent": an axe invocation has been
 * observed sitting for hundreds of seconds against a busily re-rendering
 * screen, far past any wait it was asked to perform.
 */
export class AxeCommandTimeoutError extends AxeCommandError {
  readonly timeoutMs: number;

  constructor(
    args: readonly string[],
    timeoutMs: number,
    cause?: unknown,
    executable = "axe"
  ) {
    super(
      args,
      `killed after exceeding the ${timeoutMs}ms hard deadline (hung CLI process)`,
      cause,
      executable
    );
    this.name = "AxeCommandTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface NodeAxeCommandRunnerOptions {
  /**
   * Hard per-invocation deadline. The child process is KILLED (SIGKILL)
   * when it elapses — a wedged process would otherwise hold the
   * simulator's accessibility connection and freeze every wait built on
   * top of it. Calls that legitimately wait (`tap --wait-timeout N`)
   * automatically extend the deadline to N plus a margin, so this cap
   * never races a healthy call. Default: 60s.
   */
  timeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
/** Headroom past an explicit --wait-timeout before the kill fires. */
const WAIT_TIMEOUT_MARGIN_MS = 15_000;

/** A shell-free Node runner. Arguments are never interpolated into a shell. */
export class NodeAxeCommandRunner implements AxeCommandRunner {
  private readonly execute = promisify(execFile);
  private readonly timeoutMs: number;

  constructor(
    private readonly binary = "axe",
    options: NodeAxeCommandRunnerOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  async run(args: readonly string[]): Promise<AxeCommandResult> {
    const timeout = deadlineFor(args, this.timeoutMs);
    try {
      const result = await this.execute(this.binary, [...args], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout,
        killSignal: "SIGKILL"
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      const failure = error as { stderr?: string | Buffer; killed?: boolean; signal?: string };
      if (failure.killed === true && failure.signal === "SIGKILL") {
        throw new AxeCommandTimeoutError(args, timeout, error, this.binary);
      }
      const stderr = String(failure.stderr ?? "").trim();
      const detail = stderr || (error instanceof Error ? error.message : String(error));
      throw new AxeCommandError(args, detail, error, this.binary);
    }
  }
}

/**
 * The effective kill deadline for one invocation: the configured cap, or —
 * when the command itself polls (`--wait-timeout <seconds>`) — that wait
 * plus a margin, whichever is larger.
 */
const deadlineFor = (args: readonly string[], timeoutMs: number): number => {
  const flagIndex = args.indexOf("--wait-timeout");
  if (flagIndex === -1 || flagIndex + 1 >= args.length) return timeoutMs;
  const waitSeconds = Number(args[flagIndex + 1]);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) return timeoutMs;
  return Math.max(timeoutMs, waitSeconds * 1000 + WAIT_TIMEOUT_MARGIN_MS);
};

export interface AxeCliDriverOptions {
  udid: string;
  runner?: AxeCommandRunner;
}

/**
 * The production adapter around AXe's documented CLI primitives. Higher-level
 * locators never construct CLI flags directly.
 */
export class AxeCliDriver implements AxeDriver {
  private readonly runner: AxeCommandRunner;

  constructor(private readonly options: AxeCliDriverOptions) {
    this.runner = options.runner ?? new NodeAxeCommandRunner();
  }

  async describeUi(): Promise<unknown> {
    const { stdout } = await this.runner.run(["describe-ui", "--udid", this.options.udid]);
    try {
      return JSON.parse(stdout) as unknown;
    } catch (error) {
      throw new AxeCommandError(
        ["describe-ui", "--udid", this.options.udid],
        `AXe did not return valid JSON: ${stdout.slice(0, 500)}`,
        error
      );
    }
  }

  async tap(target: AxeTapTarget): Promise<void> {
    const targetArgs =
      target.kind === "id"
        ? ["--id", target.id]
        : ["-x", String(target.x), "-y", String(target.y)];
    await this.runner.run(["tap", ...targetArgs, "--udid", this.options.udid]);
  }

  async tapLabel(label: string, waitTimeoutMs?: number): Promise<void> {
    await this.runner.run([
      "tap",
      "--label",
      label,
      ...(waitTimeoutMs === undefined ? [] : ["--wait-timeout", formatSeconds(waitTimeoutMs)]),
      "--udid",
      this.options.udid
    ]);
  }

  async swipe(gesture: AxeSwipeGesture): Promise<void> {
    await this.runner.run([
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
        : ["--duration", formatSeconds(gesture.durationMs)]),
      "--udid",
      this.options.udid
    ]);
  }

  /**
   * Touch down, hold, touch up — two `touch` invocations bracketing a real
   * wall-clock hold. The hold is genuine elapsed time on the device, so it is
   * deliberately not routed through any injectable test clock.
   */
  async longPress(x: number, y: number, holdMs = 1_500): Promise<void> {
    const point = ["-x", String(x), "-y", String(y)];
    await this.runner.run(["touch", ...point, "--down", "--udid", this.options.udid]);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await this.runner.run(["touch", ...point, "--up", "--udid", this.options.udid]);
  }

  async type(text: string): Promise<void> {
    await this.runner.run(["type", text, "--udid", this.options.udid]);
  }

  async keyCombo(modifiers: readonly number[], key: number): Promise<void> {
    await this.runner.run([
      "key-combo",
      "--modifiers",
      modifiers.join(","),
      "--key",
      String(key),
      "--udid",
      this.options.udid
    ]);
  }

  async screenshot(output: string): Promise<string> {
    const { stdout } = await this.runner.run([
      "screenshot",
      "--output",
      output,
      "--udid",
      this.options.udid
    ]);
    return stdout.trim() || output;
  }
}

/** AXe's duration flags take seconds; the public API stays in milliseconds. */
const formatSeconds = (milliseconds: number): string => String(milliseconds / 1000);
