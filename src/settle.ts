import type { Frame } from "./types.js";

/** How far two reads of a frame may differ and still count as the same. */
export const FRAME_TOLERANCE = 1;

/**
 * Whether two reads of one element's frame describe an element at rest:
 * every edge within a point of the other read. Two reads without a frame
 * agree (there is no position to move); a frame appearing or vanishing
 * between reads does not.
 */
export function framesAgree(
  a: Frame | undefined,
  b: Frame | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    Math.abs(a.x - b.x) <= FRAME_TOLERANCE &&
    Math.abs(a.y - b.y) <= FRAME_TOLERANCE &&
    Math.abs(a.width - b.width) <= FRAME_TOLERANCE &&
    Math.abs(a.height - b.height) <= FRAME_TOLERANCE
  );
}
