import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Device } from "./device.js";

export type AxeArtifact =
  | {
      kind: "raw-accessibility-tree" | "accessibility-tree" | "command-log";
      device: string;
      contentType: "application/json";
      body: unknown;
    }
  | {
      kind: "screenshot";
      device: string;
      contentType: "image/png";
      path: string;
    }
  | {
      kind: "capture-error";
      device: string;
      contentType: "text/plain";
      message: string;
    };

/** Consumers decide whether artifacts go to disk, a CI system, or memory. */
export interface ArtifactSink {
  write(artifact: AxeArtifact): Promise<void>;
}

export class InMemoryArtifactSink implements ArtifactSink {
  readonly artifacts: AxeArtifact[] = [];

  async write(artifact: AxeArtifact): Promise<void> {
    this.artifacts.push(artifact);
  }
}

/**
 * Writes each artifact as a file in one directory — the production default
 * for retaining failure evidence. Screenshot artifacts are already on disk at
 * their own path, so only JSON and text artifacts need materializing here.
 *
 * One sink typically serves a whole suite, receiving one capture per device
 * per failing test — so file names carry the device name, and a repeated
 * device/kind pair gets a numeric suffix instead of clobbering the earlier
 * capture. Retained evidence must never silently self-destruct.
 */
export class DirectoryArtifactSink implements ArtifactSink {
  private readonly writes = new Map<string, number>();

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  async write(artifact: AxeArtifact): Promise<void> {
    if (artifact.kind === "screenshot") return;

    const base = `${fileSafe(artifact.device)}-${artifact.kind}`;
    if (artifact.kind === "capture-error") {
      writeFileSync(this.nextPath(base, "txt"), artifact.message);
      return;
    }
    writeFileSync(this.nextPath(base, "json"), JSON.stringify(artifact.body, null, 2));
  }

  private nextPath(base: string, extension: string): string {
    const count = (this.writes.get(base) ?? 0) + 1;
    this.writes.set(base, count);
    const suffix = count === 1 ? "" : `-${count}`;
    return join(this.directory, `${base}${suffix}.${extension}`);
  }
}

/** Device names become file-name segments; never let them traverse paths. */
const fileSafe = (value: string): string => value.replace(/[^\w.-]+/g, "-");

export interface CaptureDeviceEvidenceOptions {
  /** A path factory opt-in; screenshots are never captured implicitly. */
  screenshotPath?: (device: Device) => string | undefined;
}

/**
 * Captures useful, serializable evidence without assuming a reporter or file
 * layout. Capture errors become artifacts instead of concealing test failures.
 */
export async function captureDeviceEvidence(
  device: Device,
  sink: ArtifactSink,
  options: CaptureDeviceEvidenceOptions = {}
): Promise<void> {
  try {
    const snapshot = await device.uiSnapshot();
    await sink.write({
      kind: "raw-accessibility-tree",
      device: device.name,
      contentType: "application/json",
      body: snapshot.raw
    });
    await sink.write({
      kind: "accessibility-tree",
      device: device.name,
      contentType: "application/json",
      body: snapshot.tree
    });
  } catch (error) {
    await sink.write(captureError(device, "accessibility tree", error));
  }

  const screenshotPath = options.screenshotPath?.(device);
  if (screenshotPath) {
    try {
      await sink.write({
        kind: "screenshot",
        device: device.name,
        contentType: "image/png",
        path: await device.screenshot(screenshotPath)
      });
    } catch (error) {
      await sink.write(captureError(device, "screenshot", error));
    }
  }

  await sink.write({
    kind: "command-log",
    device: device.name,
    contentType: "application/json",
    body: device.commandLog()
  });
}

const captureError = (device: Device, operation: string, error: unknown): AxeArtifact => ({
  kind: "capture-error",
  device: device.name,
  contentType: "text/plain",
  message: `Could not capture ${operation}: ${error instanceof Error ? error.message : String(error)}`
});
