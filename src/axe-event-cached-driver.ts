import type { UiChangeSignal } from "./change-signal.js";
import type { AxeDriver, AxeSwipeGesture, AxeTapTarget } from "./types.js";

export interface AxeEventCachedDriverOptions {
  /**
   * Where change events come from. The driver owns what it is handed:
   * `dispose()` disposes the signal along with the wrapped driver.
   */
  signal: UiChangeSignal;
  /**
   * Upper bound on how long a dump may be served from cache with no change
   * event, in milliseconds. This exists because some UI is invisible to an
   * app-side beacon — UIKit menus, the keyboard, system sheets — so a
   * beacon that never fires is not proof the screen is unchanged. Default
   * 1500.
   */
  maxStalenessMs?: number;
  /**
   * Minimum sleep for `sleepUntilChange` even when the screen is already
   * dirty, in milliseconds. WITHOUT this floor, a continuously-animating
   * screen (a countdown pill, a spinner — the beacon fires every frame, so
   * the dirty flag never stays cleared) collapses every poll sleep to 0ms
   * and the loop spins at full dump speed. The floor caps a perpetually
   * dirty screen at a few polls per second while staying well under any
   * realistic fallback interval, so a genuine change is still caught
   * promptly. Default 40.
   */
  minPollMs?: number;
}

const DEFAULT_MAX_STALENESS_MS = 1_500;
const DEFAULT_MIN_POLL_MS = 40;

/**
 * An event-invalidated cache over any `AxeDriver`: `describeUi()` answers
 * from the last dump until a change event or a driver interaction marks
 * the screen dirty. Poll loops between real UI changes become nearly free
 * — the expensive dump runs when something actually happened, not once per
 * interval.
 *
 * It also implements the `sleepUntilChange` capability, which `Device`
 * auto-wires into its poll clock: waits re-check their condition within
 * milliseconds of a change event instead of up to a full interval later.
 *
 * The two safety valves are `maxStalenessMs` (beacon-blind native UI) and
 * `minPollMs` (perpetually-animating screens); both carry their rationale
 * on the option.
 */
export class AxeEventCachedDriver implements AxeDriver {
  // Optional capabilities are conditionally-assigned FIELDS, not methods,
  // so the decorator stays transparent: when the wrapped driver lacks one,
  // this driver reports it absent and Device's capability checks fail with
  // their own messages instead of a surprise at dispatch time.
  readonly tapLabel?: (label: string, waitTimeoutMs?: number) => Promise<void>;
  readonly swipe?: (gesture: AxeSwipeGesture) => Promise<void>;
  readonly longPress?: (x: number, y: number, holdMs?: number) => Promise<void>;
  readonly screenshot?: (output: string) => Promise<string>;

  private dirty = true;
  private cachedUi: unknown;
  private cachedAt = 0;
  private waiters: Array<() => void> = [];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly inner: AxeDriver,
    private readonly options: AxeEventCachedDriverOptions,
  ) {
    this.unsubscribe = options.signal.subscribe(() => this.markDirtyAndWake());

    const dirtying =
      <Args extends unknown[], Result>(
        operation: (...args: Args) => Promise<Result>,
      ) =>
      (...args: Args): Promise<Result> => {
        this.markDirtyAndWake();
        return operation(...args);
      };

    if (inner.tapLabel) this.tapLabel = dirtying(inner.tapLabel.bind(inner));
    if (inner.swipe) this.swipe = dirtying(inner.swipe.bind(inner));
    if (inner.longPress) this.longPress = dirtying(inner.longPress.bind(inner));
    // Screenshots read the screen; they cannot change it.
    if (inner.screenshot) this.screenshot = inner.screenshot.bind(inner);
  }

  async describeUi(): Promise<unknown> {
    this.options.signal.ensureWatching();
    const maxStaleness =
      this.options.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS;
    if (
      !this.dirty &&
      this.cachedUi !== undefined &&
      Date.now() - this.cachedAt < maxStaleness
    ) {
      return this.cachedUi;
    }
    // Clear BEFORE the dump: an event landing mid-dump re-marks the flag,
    // so the next read re-dumps. Over-invalidation is safe; staleness is
    // not.
    this.dirty = false;
    const ui = await this.inner.describeUi();
    this.cachedUi = ui;
    this.cachedAt = Date.now();
    return ui;
  }

  /**
   * A poll sleep that ends EARLY the moment the screen changes (change
   * event or driver interaction), or after `milliseconds` as the fallback.
   * When the screen is already dirty the sleep is floored at `minPollMs`
   * instead of returning immediately — see the option for why. Callers are
   * poll loops that re-check their condition on wake, so waking early only
   * re-checks sooner.
   */
  sleepUntilChange(milliseconds: number): Promise<void> {
    this.options.signal.ensureWatching();
    if (this.dirty) {
      const minPoll = this.options.minPollMs ?? DEFAULT_MIN_POLL_MS;
      return new Promise((resolve) => setTimeout(resolve, minPoll));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve();
      }, milliseconds);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  tap(target: AxeTapTarget): Promise<void> {
    this.markDirtyAndWake();
    return this.inner.tap(target);
  }

  type(text: string): Promise<void> {
    this.markDirtyAndWake();
    return this.inner.type(text);
  }

  keyCombo(modifiers: readonly number[], key: number): Promise<void> {
    this.markDirtyAndWake();
    return this.inner.keyCombo(modifiers, key);
  }

  dispose(): void {
    this.unsubscribe();
    this.options.signal.dispose();
    this.inner.dispose?.();
  }

  private markDirtyAndWake(): void {
    this.dirty = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}
