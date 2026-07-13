import type { AccessibilityNode, AccessibilityTree, Frame } from "./types.js";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

const firstValue = (...values: unknown[]): string | number | boolean | undefined => {
  for (const value of values) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
  }
  return undefined;
};

const firstBoolean = (...values: unknown[]): boolean | undefined => {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
};

const numberAt = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const normalizeFrame = (value: unknown): Frame | undefined => {
  if (!isRecord(value)) return undefined;

  const x = numberAt(value, "x");
  const y = numberAt(value, "y");
  const width = numberAt(value, "width");
  const height = numberAt(value, "height");

  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }

  return { x, y, width, height };
};

const childValues = (record: JsonRecord): unknown[] => {
  const value = record.AXChildren ?? record.children;
  return Array.isArray(value) ? value : [];
};

/**
 * Normalises only the fields this package owns. Unknown AXe fields are ignored
 * deliberately, so new upstream metadata cannot break old fixture parsing.
 */
export function normalizeAxeNode(raw: unknown): AccessibilityNode {
  if (!isRecord(raw)) {
    throw new TypeError("Expected an accessibility node object.");
  }

  return {
    role: (firstString(raw.AXRole, raw.role, raw.type) ?? "Unknown").toLowerCase(),
    id: firstString(raw.AXUniqueId, raw.AXIdentifier, raw.id),
    label: firstString(raw.AXLabel, raw.label, raw.name),
    value: firstValue(raw.AXValue, raw.value),
    enabled: firstBoolean(raw.AXEnabled, raw.enabled),
    visible: firstBoolean(raw.AXVisible, raw.visible, raw.isVisible) ?? true,
    frame: normalizeFrame(raw.frame ?? raw.AXFrame),
    children: childValues(raw).map(normalizeAxeNode)
  };
}

export function normalizeAxeTree(raw: unknown): AccessibilityTree {
  if (Array.isArray(raw)) {
    return {
      root: {
        role: "Application",
        visible: true,
        children: raw.map(normalizeAxeNode)
      }
    };
  }

  if (!isRecord(raw)) {
    throw new TypeError("Expected an AXe accessibility tree object or array.");
  }

  const root = raw.root ?? raw.AXRoot ?? raw;
  return { root: normalizeAxeNode(root) };
}

export function descendants(
  root: AccessibilityNode,
  includeRoot = true
): AccessibilityNode[] {
  const result: AccessibilityNode[] = [];
  const visit = (node: AccessibilityNode) => {
    result.push(node);
    node.children.forEach(visit);
  };

  if (includeRoot) visit(root);
  else root.children.forEach(visit);
  return result;
}

export function nodeDescription(node: AccessibilityNode): string {
  const details = [node.role];
  if (node.id) details.push(`id=${JSON.stringify(node.id)}`);
  if (node.label) details.push(`label=${JSON.stringify(node.label)}`);
  if (node.value !== undefined) details.push(`value=${JSON.stringify(node.value)}`);
  return details.join(" ");
}
