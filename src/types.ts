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

/** The narrow, typed boundary around the AXe CLI. */
export interface AxeDriver {
  describeUi(): Promise<unknown>;
  tap(target: AxeTapTarget): Promise<void>;
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
