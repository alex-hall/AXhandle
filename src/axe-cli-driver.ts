import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AxeDriver, AxeTapTarget } from "./types.js";

export interface AxeCommandResult {
  stdout: string;
  stderr: string;
}

export interface AxeCommandRunner {
  run(args: readonly string[]): Promise<AxeCommandResult>;
}

export class AxeCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    cause?: unknown
  ) {
    super(`AXe command failed: axe ${args.join(" ")}\n${stderr}`.trim(), { cause });
    this.name = "AxeCommandError";
  }
}

/** A shell-free Node runner. Arguments are never interpolated into a shell. */
export class NodeAxeCommandRunner implements AxeCommandRunner {
  private readonly execute = promisify(execFile);

  constructor(private readonly binary = "axe") {}

  async run(args: readonly string[]): Promise<AxeCommandResult> {
    try {
      const result = await this.execute(this.binary, [...args], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      const failure = error as { stderr?: string | Buffer };
      throw new AxeCommandError(args, String(failure.stderr ?? ""), error);
    }
  }
}

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
