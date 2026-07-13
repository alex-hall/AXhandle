import type { Device } from "./device.js";

export type AxeArtifact =
  | {
      kind: "accessibility-tree" | "command-log";
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
    await sink.write({
      kind: "accessibility-tree",
      device: device.name,
      contentType: "application/json",
      body: await device.accessibilityTree()
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
