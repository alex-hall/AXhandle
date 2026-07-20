export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AccessibilityNode {
  role: string;
  id?: string;
  label?: string;
  value?: string | number | boolean;
  enabled?: boolean;
  visible: boolean;
  frame?: Frame;
  children: AccessibilityNode[];
}

export interface AccessibilityTree {
  root: AccessibilityNode;
}

export type AxeTapTarget =
  | { kind: "id"; id: string }
  | { kind: "point"; x: number; y: number };

export interface AxeSwipeGesture {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Total gesture duration; AXe's own default applies when omitted. */
  durationMs?: number;
}

/** The narrow, typed boundary around the AXe CLI. */
export interface AxeDriver {
  describeUi(): Promise<unknown>;
  tap(target: AxeTapTarget): Promise<void>;
  /**
   * Tap the first element whose accessibility label matches exactly, waiting
   * up to `waitTimeoutMs` for it to exist. This reaches elements that never
   * appear in `describeUi` — native alert buttons in particular — and is the
   * escape hatch tree-resolved locators cannot provide. AXe rejects ambiguous
   * labels rather than guessing.
   */
  tapLabel?(label: string, waitTimeoutMs?: number): Promise<void>;
  swipe?(gesture: AxeSwipeGesture): Promise<void>;
  /** Touch down, hold, touch up at one point — long-press affordances. */
  longPress?(x: number, y: number, holdMs?: number): Promise<void>;
  type(text: string): Promise<void>;
  keyCombo(modifiers: readonly number[], key: number): Promise<void>;
  screenshot?(output: string): Promise<string>;
}

export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
};

export interface WaitOptions {
  timeout?: number;
  interval?: number;
}

export interface FillOptions extends WaitOptions {
  /** Disable only for controls whose accessibility value intentionally masks input. */
  verify?: boolean;
}
