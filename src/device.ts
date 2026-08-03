import { AsyncLocalStorage } from "node:async_hooks";
import {
  Locator,
  LocatorResolutionError,
  LocatorTimeoutError,
} from "./locator.js";
import type { TapOptions, TextQueryOptions } from "./locator.js";
import { poll, PollTimeoutError } from "./poll.js";
import { checkedState } from "./state.js";
import { normalizeAxeTree } from "./tree.js";
import type {
  AccessibilityNode,
  AccessibilityTree,
  AxeDriver,
  AxeSwipeGesture,
  AxeTapTarget,
  Clock,
  FillOptions,
  WaitOptions,
} from "./types.js";
import { systemClock } from "./types.js";

export interface DeviceTimeouts {
  action: number;
  assertion: number;
  interval: number;
}

export interface DeviceOptions {
  clock?: Clock;
  timeouts?: Partial<DeviceTimeouts>;
  /**
   * How long one `describe-ui` dump may be reused for further reads, in
   * milliseconds. Only genuinely back-to-back reads (a check-then-tap, a
   * multi-locator probe) share a dump: any action invalidates the cache
   * immediately, so does every wait-sleep on the device's clock (each poll
   * iteration re-dumps, whatever its interval), and the window — clamped
   * strictly below the device poll interval — bounds reuse across reads the
   * consumer spaces out itself. Defaults to `min(interval - 1, 50)`; `0`
   * disables reuse entirely.
   */
  cacheWindowMs?: number;
}

export type DeviceCommandStatus = "passed" | "failed";

/**
 * Built-in command names, plus any name given to recordAction() — every
 * timed operation on a device shares this one log.
 */
export type DeviceCommandName =
  | "inspect"
  | "tap"
  | "tap-point"
  | "tap-label"
  | "swipe"
  | "type"
  | "fill"
  | "check"
  | "uncheck"
  | "screenshot"
  | (string & {});

export interface DeviceCommandLogEntry {
  sequence: number;
  command: DeviceCommandName;
  startedAt: number;
  finishedAt: number;
  status: DeviceCommandStatus;
  error?: string;
}

export interface RawActionOptions {
  /**
   * Command-log row name override. Coordinate gestures are semantically
   * opaque in a log ("tap-point" at 200,500 — of what?), so callers tapping
   * frame-derived or AX-invisible targets should say what they meant.
   */
  command?: string;
}

export interface LongPressOptions extends RawActionOptions {
  /** Hold duration; the driver's default applies when omitted. */
  holdMs?: number;
}

export interface TapLabelOptions {
  /** How long AXe should wait for the label to exist before tapping. */
  waitTimeout?: number;
  /**
   * `optional: true` returns false instead of throwing when the tap fails —
   * the standard way to drain a system alert whose arrival races the flow.
   */
  optional?: boolean;
}

export interface UiSnapshot {
  raw: unknown;
  tree: AccessibilityTree;
}

export interface ScrollIntoViewOptions {
  /** Maximum swipes before failing (default 6). */
  maxSwipes?: number;
  /**
   * Points to treat as covered at the top of the viewport — a pinned
   * header or nav bar. An element under it counts as not yet in view.
   * Default 0.
   */
  topInset?: number;
  /**
   * Points to treat as covered at the bottom of the viewport. Being inside
   * the screen is not the same as being tappable: a row can sit fully
   * on-screen yet directly BEHIND a pinned footer, passing every plain
   * on-screen check while every tap on it presses the footer instead.
   * Default 0.
   */
  bottomInset?: number;
  /** Points per swipe (default: a third of the viewport height). */
  swipeDistance?: number;
  /**
   * Post-swipe inertia floor in milliseconds (default 250). Scroll
   * inertia has no observable end condition, so this is a genuine wall
   * sleep; the loop re-measures afterwards, which self-heals an unsettled
   * scroll. `0` disables it.
   */
  settleMs?: number;
  /**
   * Viewport height override for trees whose root reports no frame; the
   * root's own frame is used when available.
   */
  viewportHeight?: number;
}

const defaultTimeouts: DeviceTimeouts = {
  action: 3_000,
  assertion: 5_000,
  interval: 100,
};

/**
 * A named iOS Simulator facade. Commands on one device are serialised, while
 * separate Device instances remain ordinary, independently composable promises.
 */
export class Device {
  readonly clock: Clock;
  readonly timeouts: DeviceTimeouts;
  /** Effective snapshot-reuse window after clamping; see DeviceOptions. */
  readonly cacheWindowMs: number;
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;
  private readonly log: DeviceCommandLogEntry[] = [];
  /** Set while the current async context holds this device's queue slot. */
  private readonly holdingQueue = new AsyncLocalStorage<true>();
  private cache: { snapshot: UiSnapshot; at: number } | undefined;

  constructor(
    readonly name: string,
    private readonly driver: AxeDriver,
    options: DeviceOptions = {},
  ) {
    // Every sleep on the device's clock invalidates the snapshot cache —
    // polls (locator waits, tap-until settles, actionability retries) all
    // sleep through this clock, so each iteration re-dumps even when its
    // per-call interval is shorter than the cache window.
    const base = options.clock ?? systemClock;
    // A driver that can observe screen changes supplies the poll sleep:
    // waits wake the moment a change lands instead of up to an interval
    // later. Safe by construction here — every internal use of clock.sleep
    // is a poll loop that re-checks its condition on wake. An explicit
    // clock always wins (tests own time), and pacing floors that must
    // genuinely elapse belong on wallSleep(), never this clock.
    const pollSleep =
      options.clock === undefined && driver.sleepUntilChange
        ? driver.sleepUntilChange.bind(driver)
        : (milliseconds: number) => base.sleep(milliseconds);
    this.clock = {
      now: () => base.now(),
      sleep: async (milliseconds) => {
        await pollSleep(milliseconds);
        this.cache = undefined;
      },
    };
    this.timeouts = { ...defaultTimeouts, ...options.timeouts };
    // Clamp strictly below the poll interval: a device tuned for tight
    // polling (a small interval) is asking for freshness over reuse.
    const cap = Math.max(0, this.timeouts.interval - 1);
    this.cacheWindowMs = Math.min(
      Math.max(0, options.cacheWindowMs ?? 50),
      cap,
    );
  }

  /** Release the underlying driver's held resources, if it holds any. */
  dispose(): void {
    this.driver.dispose?.();
  }

  /**
   * Suffix a failure message with this device's name. Multi-device suites
   * raise identical-looking errors from every actor; the tag is what tells
   * a reader which simulator failed. Every error thrown through the device
   * queue or a locator wait is tagged automatically — this is public for
   * consumer-built helpers that throw their own errors about this device.
   * No-op when the tag is already present (wrapped errors fold earlier
   * messages in) or the device has no name.
   */
  /**
   * A sleep that always elapses in full, in real time — never the device
   * clock, whose poll sleeps may end EARLY when the driver reports a
   * screen change. Early waking is correct for poll loops (they re-check
   * on wake) and a correctness bug for pacing floors: a system-UI settle
   * window or animation floor that is cut short defeats its purpose. Use
   * this for every wait that must genuinely pass.
   */
  wallSleep(milliseconds: number): Promise<void> {
    return systemClock.sleep(milliseconds);
  }

  tagMessage(message: string): string {
    const tag = `[${this.name}]`;
    return this.name.length === 0 || message.includes(tag)
      ? message
      : `${message} ${tag}`;
  }

  findByTestId(value: string): Locator {
    return Locator.from(this, { kind: "testId", value });
  }

  findByText(value: string, options: TextQueryOptions = {}): Locator {
    return Locator.from(
      this,
      options.exact === false
        ? { kind: "text", value, exact: false }
        : { kind: "text", value },
    );
  }

  findByLabel(value: string, options: TextQueryOptions = {}): Locator {
    return Locator.from(
      this,
      options.exact === false
        ? { kind: "label", value, exact: false }
        : { kind: "label", value },
    );
  }

  findByRole(role: string, options: { name?: string } = {}): Locator {
    return Locator.from(this, { kind: "role", role, name: options.name });
  }

  async inspect(locator: Locator): Promise<AccessibilityNode> {
    return this.enqueue("inspect", async () =>
      locator.resolveFrom((await this.readSnapshot()).tree),
    );
  }

  async accessibilityTree(): Promise<AccessibilityTree> {
    return (await this.uiSnapshot()).tree;
  }

  async uiSnapshot(): Promise<UiSnapshot> {
    return this.enqueue("inspect", async () => this.readSnapshot());
  }

  async count(locator: Locator): Promise<number> {
    return this.enqueue(
      "inspect",
      async () =>
        locator.matchesIn((await this.readSnapshot()).tree, {
          strict: true,
        }).length,
    );
  }

  /**
   * Non-strict match count — plumbing for Locator.isPresent()/waitForGone().
   * Consumers should reach for the Locator methods, not this.
   */
  async presenceCount(locator: Locator): Promise<number> {
    return (await this.presentNodes(locator)).length;
  }

  /** Non-strict matching nodes from one fresh snapshot; see Locator.presentNodes(). */
  async presentNodes(locator: Locator): Promise<AccessibilityNode[]> {
    return this.enqueue("inspect", async () =>
      locator.matchesIn((await this.readSnapshot()).tree),
    );
  }

  /**
   * Which of these is on screen? Evaluates every candidate against ONE
   * accessibility snapshot and returns the first present (in argument order),
   * or undefined. Prefer this over consecutive exists() calls — each of those
   * is a full tree fetch.
   */
  async firstPresent(
    ...locators: readonly Locator[]
  ): Promise<Locator | undefined> {
    return this.enqueue("inspect", async () => {
      const { tree } = await this.readSnapshot();
      return locators.find((locator) => locator.matchesIn(tree).length > 0);
    });
  }

  /** @deprecated Use {@link tap} — iOS has taps, not clicks. Removed in 1.0. */
  async click(locator: Locator, options: TapOptions = {}): Promise<void> {
    await this.tap(locator, options);
  }

  async tap(locator: Locator, options: TapOptions = {}): Promise<void> {
    const until = options.until;
    if (until === undefined) {
      await this.enqueue("tap", () => this.tapOnce(locator, options));
      return;
    }

    // Tap-until-arrival: one successful tap is not proof of navigation (a
    // control can render before its touch handler attaches, or an overlay can
    // swallow the tap), so retap until the arrival locator is present.
    const attempts = options.attempts ?? 3;
    const settleTimeout = options.settleTimeout ?? this.timeouts.action;
    const interval = options.interval ?? this.timeouts.interval;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.enqueue("tap", () => this.tapOnce(locator, options));
      } catch (error) {
        // The control may be gone precisely because an earlier tap landed.
        if (await until.isPresent()) return;
        throw error;
      }

      try {
        await poll(() => until.isPresent(), {
          timeout: settleTimeout,
          interval,
          clock: this.clock,
        });
        return;
      } catch (error) {
        if (!(error instanceof PollTimeoutError)) throw error;
        // Arrival marker not up yet — the tap may have been swallowed; retap.
      }
    }

    throw new LocatorTimeoutError(
      this.tagMessage(
        `Tapped ${locator.describe()} ${attempts} times, but ${until.describe()} never appeared.`,
      ),
    );
  }

  /**
   * Coordinate tap through the device queue and command log. `command` names
   * the log row — coordinate taps are semantically opaque, so a tag like
   * `numpad-7` is the difference between a readable log and noise.
   */
  async tapPoint(
    x: number,
    y: number,
    options: RawActionOptions = {},
  ): Promise<void> {
    await this.enqueue(options.command ?? "tap-point", () =>
      this.driver.tap({ kind: "point", x, y }),
    );
  }

  /** Long-press at a point; requires driver support. See tapPoint on `command`. */
  async longPress(
    x: number,
    y: number,
    options: LongPressOptions = {},
  ): Promise<void> {
    const longPress = this.driver.longPress?.bind(this.driver);
    if (!longPress) {
      throw new Error(
        "The configured AXe driver does not support long-presses.",
      );
    }
    await this.enqueue(options.command ?? "long-press", () =>
      longPress(x, y, options.holdMs),
    );
  }

  /**
   * Tap by exact accessibility label WITHOUT resolving the tree — the escape
   * hatch for elements `describe-ui` never reports, native alert buttons
   * above all, and a one-CLI-call fast path where the next wait in the flow
   * verifies the outcome anyway. No actionability check happens. Returns
   * whether the tap landed; failures only throw when `optional` is unset.
   */
  async tapLabel(
    label: string,
    options: TapLabelOptions = {},
  ): Promise<boolean> {
    const tapLabel = this.driver.tapLabel?.bind(this.driver);
    if (!tapLabel) {
      throw new Error("The configured AXe driver does not support label taps.");
    }

    return this.enqueue("tap-label", async () => {
      try {
        await tapLabel(label, options.waitTimeout);
        return true;
      } catch (error) {
        if (options.optional) return false;
        throw error;
      }
    });
  }

  async swipe(
    gesture: AxeSwipeGesture,
    options: RawActionOptions = {},
  ): Promise<void> {
    const swipe = this.driver.swipe?.bind(this.driver);
    if (!swipe) {
      throw new Error("The configured AXe driver does not support swipes.");
    }
    await this.enqueue(options.command ?? "swipe", () => swipe(gesture));
  }

  /**
   * Swipe until the element sits fully inside the viewport (minus the
   * insets), in either vertical direction. See Locator.scrollIntoView for
   * why presence in the tree is not the same as tappable.
   */
  async scrollIntoView(
    locator: Locator,
    options: ScrollIntoViewOptions = {},
  ): Promise<void> {
    if (!this.driver.swipe) {
      throw new Error("The configured AXe driver does not support swipes.");
    }
    const maxSwipes = options.maxSwipes ?? 6;
    const topInset = options.topInset ?? 0;
    const bottomInset = options.bottomInset ?? 0;
    const settleMs = options.settleMs ?? 250;

    for (let swipes = 0; ; swipes++) {
      const { tree } = await this.uiSnapshot();
      const node = this.resolveTagged(locator, tree);
      const frame = node.frame;
      if (!frame) {
        throw new LocatorResolutionError(
          this.tagMessage(
            `${locator.describe()} resolved to ${node.role}, but it has no frame to scroll to.`,
          ),
        );
      }

      const viewportTop = tree.root.frame?.y ?? 0;
      const viewportHeight = options.viewportHeight ?? tree.root.frame?.height;
      if (viewportHeight === undefined) {
        throw new Error(
          this.tagMessage(
            "Cannot scroll: the tree's root reports no frame. Pass ScrollIntoViewOptions.viewportHeight.",
          ),
        );
      }
      const top = viewportTop + topInset;
      const bottom = viewportTop + viewportHeight - bottomInset;
      if (frame.y >= top && frame.y + frame.height <= bottom) return;

      if (swipes >= maxSwipes) {
        throw new LocatorTimeoutError(
          this.tagMessage(
            `${locator.describe()} was still outside the viewport after ${maxSwipes} ${maxSwipes === 1 ? "swipe" : "swipes"} (frame y=${frame.y}..${frame.y + frame.height}, viewport ${top}..${bottom}${bottomInset ? ` with bottomInset ${bottomInset}` : ""}).`,
          ),
        );
      }

      // Swipe in the element's own column — guaranteed to land inside the
      // scroll container that holds it. Start points stay well off the
      // screen edges (a bottom-edge drag is the home gesture) and off the
      // insets (a pinned bar would eat the gesture).
      const distance = options.swipeDistance ?? Math.round(viewportHeight / 3);
      const x = frame.x + frame.width / 2;
      const scrollUp = frame.y + frame.height > bottom;
      const startY = scrollUp
        ? Math.min(viewportTop + viewportHeight * 0.75, bottom - 24)
        : Math.max(viewportTop + viewportHeight * 0.25, top + 24);
      const endY = scrollUp
        ? Math.max(startY - distance, top + 24)
        : Math.min(startY + distance, bottom - 24);
      await this.swipe(
        { startX: x, startY, endX: x, endY, durationMs: 400 },
        { command: "scroll-into-view" },
      );
      // FIXED FLOOR: scroll inertia has no observable end condition, and an
      // early wake here (the event clock fires on every scroll frame) would
      // re-measure a frame still in motion. The loop re-checks after, which
      // self-heals an unsettled scroll on the next pass.
      if (settleMs > 0) await this.wallSleep(settleMs);
    }
  }

  /**
   * Runs an out-of-band operation inside the device's command queue and log,
   * so work that bypasses the typed surface (biometric triggers, app
   * lifecycle, raw driver calls) still serializes with queued commands and
   * shows up in commandLog() with real timings.
   *
   * Reentrancy is safe: device calls made INSIDE the operation run inline on
   * the already-held queue slot (still logged) instead of deadlocking behind
   * it.
   */
  async recordAction<T>(
    command: DeviceCommandName,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(command, operation);
  }

  /**
   * HID-types into whatever currently holds focus, resolving nothing. The
   * fast path when the previous action just focused the field (a tapLabel,
   * a coordinate tap on an AX-invisible target) — typeInto() would pay a
   * tree resolve and a second tap for a focus the flow already owns.
   */
  async type(text: string): Promise<void> {
    await this.enqueue("type", () => this.driver.type(text));
  }

  async typeInto(
    locator: Locator,
    text: string,
    options: WaitOptions = {},
  ): Promise<void> {
    await this.enqueue("type", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      await this.driver.tap(this.tapTargetFor(node, tree));
      await this.driver.type(text);
    });
  }

  async fill(
    locator: Locator,
    text: string,
    options: FillOptions = {},
  ): Promise<void> {
    await this.enqueue("fill", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      await this.driver.tap(this.tapTargetFor(node, tree));
      // HID 227 is Left Command and 4 is the "A" key.
      await this.driver.keyCombo([227], 4);
      await this.driver.type(text);
    });

    if (options.verify ?? true) {
      await locator.waitFor((node) => node.value === text, {
        timeout: options.timeout ?? this.timeouts.action,
        interval: options.interval,
      });
    }
  }

  async setChecked(
    locator: Locator,
    expected: boolean,
    options: WaitOptions = {},
  ): Promise<void> {
    await this.enqueue(expected ? "check" : "uncheck", async () => {
      const { tree, node } = await this.resolveActionTarget(locator, options);
      const current = checkedState(node);
      if (current === undefined) {
        throw new Error(
          `Cannot ${expected ? "check" : "uncheck"} ${locator.describe()}: AXe did not report a switch state.`,
        );
      }
      if (current !== expected)
        await this.driver.tap(this.tapTargetFor(node, tree));
    });

    await locator.waitFor((node) => checkedState(node) === expected, {
      timeout: options.timeout ?? this.timeouts.action,
      interval: options.interval,
    });
  }

  async screenshot(output: string): Promise<string> {
    return this.enqueue("screenshot", async () => {
      if (!this.driver.screenshot) {
        throw new Error(
          "The configured AXe driver does not support screenshots.",
        );
      }
      return this.driver.screenshot(output);
    });
  }

  /**
   * A copy of the structured command history for reporters and artifact
   * sinks. Pass `after` (a value from commandMark()) to window the log to the
   * commands issued since — the primitive for per-step timing attribution.
   */
  commandLog(
    options: { after?: number } = {},
  ): readonly DeviceCommandLogEntry[] {
    const after = options.after ?? 0;
    return this.log
      .filter((entry) => entry.sequence > after)
      .map((entry) => ({ ...entry }));
  }

  /** The current log position, for commandLog({ after }) windowing. */
  commandMark(): number {
    return this.sequence;
  }

  /**
   * The current accessibility snapshot. Reuses the last dump when it is
   * younger than cacheWindowMs and no action has invalidated it since
   * (execute() drops the cache after every non-read command); otherwise runs
   * a fresh dump and refreshes the cache.
   */
  private async readSnapshot(): Promise<UiSnapshot> {
    if (
      this.cacheWindowMs > 0 &&
      this.cache &&
      this.clock.now() - this.cache.at <= this.cacheWindowMs
    ) {
      return this.cache.snapshot;
    }
    const raw = await this.driver.describeUi();
    const snapshot: UiSnapshot = { raw, tree: normalizeAxeTree(raw) };
    this.cache = { snapshot, at: this.clock.now() };
    return snapshot;
  }

  /** Strict resolution against a held tree, with the device-name tag that
   *  enqueued resolutions get from execute(). */
  private resolveTagged(
    locator: Locator,
    tree: AccessibilityTree,
  ): AccessibilityNode {
    try {
      return locator.resolveFrom(tree);
    } catch (error) {
      if (error instanceof Error)
        error.message = this.tagMessage(error.message);
      throw error;
    }
  }

  private async tapOnce(locator: Locator, options: WaitOptions): Promise<void> {
    const { tree, node } = await this.resolveActionTarget(locator, options);
    await this.driver.tap(this.tapTargetFor(node, tree));
  }

  private tapTargetFor(
    node: AccessibilityNode,
    tree: ReturnType<typeof normalizeAxeTree>,
  ): AxeTapTarget {
    if (node.id && countId(tree.root, node.id) === 1) {
      return { kind: "id", id: node.id };
    }

    if (node.frame) {
      return {
        kind: "point",
        x: node.frame.x + node.frame.width / 2,
        y: node.frame.y + node.frame.height / 2,
      };
    }

    throw new Error(
      `Cannot tap ${node.role}: it has no unique accessibility id or frame.`,
    );
  }

  private async resolveActionTarget(
    locator: Locator,
    options: WaitOptions,
  ): Promise<{
    tree: ReturnType<typeof normalizeAxeTree>;
    node: AccessibilityNode;
  }> {
    const timeout = options.timeout ?? this.timeouts.action;
    const interval = options.interval ?? this.timeouts.interval;
    const deadline = this.clock.now() + timeout;
    let lastError: LocatorResolutionError | undefined;

    while (true) {
      const { tree } = await this.readSnapshot();
      try {
        const node = locator.resolveFrom(tree);
        if (!node.visible) {
          throw new LocatorResolutionError(
            `${locator.describe()} resolved to ${node.role}, but it is not visible.`,
          );
        }
        if (node.enabled === false) {
          throw new LocatorResolutionError(
            `${locator.describe()} resolved to ${node.role}, but it is disabled.`,
          );
        }
        return { tree, node };
      } catch (error) {
        if (!(error instanceof LocatorResolutionError)) throw error;
        lastError = error;
      }

      if (this.clock.now() >= deadline) {
        throw new LocatorTimeoutError(
          `${locator.describe()} was not actionable within ${timeout}ms. ${lastError?.message ?? ""}`.trim(),
        );
      }

      await this.clock.sleep(interval);
    }
  }

  private async enqueue<T>(
    command: DeviceCommandName,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.holdingQueue.getStore()) {
      // The current async context already holds this device's queue slot —
      // a device call nested inside recordAction(). Run inline (still
      // logged); waiting on the tail here would deadlock behind ourselves.
      return this.execute(command, operation);
    }

    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await this.holdingQueue.run(true, () =>
        this.execute(command, operation),
      );
    } finally {
      release?.();
    }
  }

  private async execute<T>(
    command: DeviceCommandName,
    operation: () => Promise<T>,
  ): Promise<T> {
    const sequence = ++this.sequence;
    const startedAt = this.clock.now();
    try {
      const result = await operation();
      this.log.push({
        sequence,
        command,
        startedAt,
        finishedAt: this.clock.now(),
        status: "passed",
      });
      return result;
    } catch (error) {
      // Tag before logging so the log row and the thrown error agree.
      if (error instanceof Error)
        error.message = this.tagMessage(error.message);
      this.log.push({
        sequence,
        command,
        startedAt,
        finishedAt: this.clock.now(),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // Any command other than a read may have changed the screen (taps,
      // typing, gestures, whatever a recordAction wrapped). Drop the cached
      // snapshot so the next read re-dumps and sees the new state.
      if (command !== "inspect") this.cache = undefined;
    }
  }
}

const countId = (node: AccessibilityNode, id: string): number =>
  (node.id === id ? 1 : 0) +
  node.children.reduce((count, child) => count + countId(child, id), 0);
