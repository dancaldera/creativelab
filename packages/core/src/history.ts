/**
 * Undo/redo history.
 *
 * FR-01: "undo/redo survives during session". Because every timeline operation in
 * `timeline.ts` is a pure transform returning a new document, history is a bounded
 * stack of document snapshots. Structural sharing means untouched clips, tracks and
 * assets are the *same object references* between snapshots, so a 200-entry history of
 * a large project does not cost 200 copies of the media library.
 */

export interface HistorySnapshot<T> {
  readonly label: string;
  readonly state: T;
  readonly at: number;
}

export interface HistoryOptions {
  /** Maximum number of undo steps retained. Oldest entries are dropped first. */
  readonly limit?: number;
  /** Label coalescing window for repeated edits of the same kind. */
  readonly coalesceWindowMs?: number;
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly depth: number;
  readonly redoDepth: number;
}

export const DEFAULT_HISTORY_LIMIT = 200;
export const DEFAULT_COALESCE_WINDOW_MS = 400;

export class History<T> {
  #past: HistorySnapshot<T>[] = [];
  #future: HistorySnapshot<T>[] = [];
  #present: HistorySnapshot<T>;
  #limit: number;
  #coalesceWindowMs: number;
  #lastPushAt = 0;

  constructor(initial: T, options: HistoryOptions = {}, now: () => number = Date.now) {
    this.#limit = Math.max(1, options.limit ?? DEFAULT_HISTORY_LIMIT);
    this.#coalesceWindowMs = Math.max(0, options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS);
    this.#present = { label: "Initial state", state: initial, at: now() };
    this.#lastPushAt = this.#present.at;
  }

  get current(): T {
    return this.#present.state;
  }

  get currentLabel(): string {
    return this.#present.label;
  }

  get state(): HistoryState {
    return {
      canUndo: this.#past.length > 0,
      canRedo: this.#future.length > 0,
      // These label the *action*, which is what an "Undo X" / "Redo X" menu item means.
      // `present.label` is the action that produced the current state, i.e. the one an
      // undo would reverse. `past.at(-1).label` would name the state we travel *to*,
      // which reads as the wrong action to the user.
      undoLabel: this.#past.length > 0 ? this.#present.label : null,
      redoLabel: this.#future[0]?.label ?? null,
      depth: this.#past.length,
      redoDepth: this.#future.length,
    };
  }

  /**
   * Record a new state.
   *
   * When `coalesce` is true and the previous push had the same label within the
   * coalesce window, the *previous* snapshot is kept as the undo target. That makes a
   * slider drag or a repeated nudge a single undo step, which is what users expect.
   */
  push(
    label: string,
    next: T,
    options: { coalesce?: boolean } = {},
    now: () => number = Date.now,
  ): void {
    const at = now();
    const shouldCoalesce =
      options.coalesce === true &&
      this.#future.length === 0 &&
      this.#past.length > 0 &&
      this.#present.label === label &&
      at - this.#lastPushAt <= this.#coalesceWindowMs;

    if (!shouldCoalesce) {
      this.#past.push(this.#present);
      if (this.#past.length > this.#limit) this.#past.shift();
    }
    this.#present = { label, state: next, at };
    this.#lastPushAt = at;
    // A new edit always invalidates the redo branch.
    this.#future = [];
  }

  /** Replace the present without creating an undo step (e.g. server-side reconciliation). */
  replacePresent(label: string, next: T, now: () => number = Date.now): void {
    this.#present = { label, state: next, at: now() };
  }

  undo(): T | undefined {
    const previous = this.#past.pop();
    if (!previous) return undefined;
    this.#future.unshift(this.#present);
    this.#present = previous;
    this.#lastPushAt = 0;
    return this.#present.state;
  }

  redo(): T | undefined {
    const next = this.#future.shift();
    if (!next) return undefined;
    this.#past.push(this.#present);
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#present = next;
    this.#lastPushAt = 0;
    return this.#present.state;
  }

  /**
   * Labels of the states `undo()` can travel to, oldest first — the left-to-right
   * history a History panel renders. The current state's own label is `currentLabel`.
   */
  undoLabels(): string[] {
    return this.#past.map((entry) => entry.label);
  }

  clear(initial?: T): void {
    if (initial !== undefined)
      this.#present = { label: "Initial state", state: initial, at: Date.now() };
    this.#past = [];
    this.#future = [];
  }
}
