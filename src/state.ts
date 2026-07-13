import type { AccessibilityNode } from "./types.js";

/** AXe currently represents switch state as booleans, numbers, or strings. */
export const checkedState = (node: AccessibilityNode): boolean | undefined => {
  if (typeof node.value === "boolean") return node.value;
  if (node.value === 1) return true;
  if (node.value === 0) return false;
  if (typeof node.value !== "string") return undefined;

  switch (node.value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "on":
    case "checked":
      return true;
    case "0":
    case "false":
    case "off":
    case "unchecked":
      return false;
    default:
      return undefined;
  }
};
