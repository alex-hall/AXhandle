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
      const stderr = String(failure.stderr ?? "").trim();
      const detail = stderr || (error instanceof Error ? error.message : String(error));
      throw new AxeCommandError(args, detail, error, this.binary);
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
