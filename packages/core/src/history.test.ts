import { describe, expect, it } from "vitest";
import { History } from "../src/history.js";

interface Doc {
  readonly value: number;
  readonly tag?: string;
}

describe("History (FR-01: undo/redo survives during the session)", () => {
  it("starts with nothing to undo or redo", () => {
    const history = new History<Doc>({ value: 0 });
    expect(history.current).toEqual({ value: 0 });
    expect(history.state).toMatchObject({ canUndo: false, canRedo: false, depth: 0, redoDepth: 0 });
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBeUndefined();
  });

  it("walks backwards and forwards through pushed states", () => {
    const history = new History<Doc>({ value: 0 });
    history.push("one", { value: 1 });
    history.push("two", { value: 2 });
    history.push("three", { value: 3 });

    expect(history.state).toMatchObject({ canUndo: true, canRedo: false, depth: 3 });
    expect(history.undo()).toEqual({ value: 2 });
    expect(history.undo()).toEqual({ value: 1 });
    expect(history.undo()).toEqual({ value: 0 });
    expect(history.undo()).toBeUndefined();
    expect(history.current).toEqual({ value: 0 });

    expect(history.redo()).toEqual({ value: 1 });
    expect(history.redo()).toEqual({ value: 2 });
    expect(history.redo()).toEqual({ value: 3 });
    expect(history.redo()).toBeUndefined();
    expect(history.current).toEqual({ value: 3 });
  });

  it("exposes the labels the UI shows on the undo/redo buttons", () => {
    const history = new History<Doc>({ value: 0 });
    history.push("Split clip", { value: 1 });
    history.push("Trim clip", { value: 2 });

    expect(history.state.undoLabel).toBe("Trim clip");
    expect(history.undoLabels()).toEqual(["Initial state", "Split clip"]);
    expect(history.currentLabel).toBe("Trim clip");
    history.undo();
    expect(history.state.redoLabel).toBe("Trim clip");
    expect(history.state.undoLabel).toBe("Split clip");
  });

  it("drops the redo branch as soon as a new edit is made", () => {
    const history = new History<Doc>({ value: 0 });
    history.push("a", { value: 1 });
    history.push("b", { value: 2 });
    history.undo();
    expect(history.state.canRedo).toBe(true);

    history.push("c", { value: 99 });
    expect(history.state.canRedo).toBe(false);
    expect(history.current).toEqual({ value: 99 });
    expect(history.undo()).toEqual({ value: 1 });
  });

  it("coalesces rapid same-label edits into a single undo step", () => {
    let clock = 1_000;
    const now = () => clock;
    const history = new History<Doc>({ value: 0 }, { coalesceWindowMs: 400 }, now);

    history.push("Drag opacity", { value: 1 }, { coalesce: true }, now);
    clock += 50;
    history.push("Drag opacity", { value: 2 }, { coalesce: true }, now);
    clock += 50;
    history.push("Drag opacity", { value: 3 }, { coalesce: true }, now);

    // Three drag samples, one undo step.
    expect(history.state.depth).toBe(1);
    expect(history.current).toEqual({ value: 3 });
    expect(history.undo()).toEqual({ value: 0 });
  });

  it("does not coalesce across the window boundary, a label change, or when disabled", () => {
    let clock = 0;
    const now = () => clock;
    const history = new History<Doc>({ value: 0 }, { coalesceWindowMs: 100 }, now);

    history.push("Drag", { value: 1 }, { coalesce: true }, now);
    clock += 500; // outside the window
    history.push("Drag", { value: 2 }, { coalesce: true }, now);
    expect(history.state.depth).toBe(2);

    clock += 10;
    history.push("Other", { value: 3 }, { coalesce: true }, now); // different label
    expect(history.state.depth).toBe(3);

    clock += 10;
    history.push("Other", { value: 4 }, {}, now); // coalesce not requested
    expect(history.state.depth).toBe(4);
  });

  it("bounds memory by dropping the oldest entries past the limit", () => {
    const history = new History<Doc>({ value: 0 }, { limit: 3 });
    for (let index = 1; index <= 10; index += 1) history.push(`edit ${index}`, { value: index });

    expect(history.state.depth).toBe(3);
    // Only the three most recent steps remain undoable, down to value 7 which is
    // the oldest retained state.
    expect(history.undo()).toEqual({ value: 9 });
    expect(history.undo()).toEqual({ value: 8 });
    expect(history.undo()).toEqual({ value: 7 });
    expect(history.undo()).toBeUndefined();
  });

  it("replaces the present without creating an undo step", () => {
    const history = new History<Doc>({ value: 0 });
    history.push("a", { value: 1 });
    history.replacePresent("Reloaded from disk", { value: 42, tag: "disk" });

    expect(history.current).toEqual({ value: 42, tag: "disk" });
    expect(history.state.depth).toBe(1);
    expect(history.undo()).toEqual({ value: 0 });
  });

  it("clears both stacks and can reset to a new initial state", () => {
    const history = new History<Doc>({ value: 0 });
    history.push("a", { value: 1 });
    history.push("b", { value: 2 });
    history.undo();

    history.clear({ value: 7 });
    expect(history.current).toEqual({ value: 7 });
    expect(history.state).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("keeps object identity for untouched parts of a document (structural sharing)", () => {
    // This is what makes a deep undo stack affordable for a large project.
    const shared = { heavy: new Array(1000).fill(0) };
    const history = new History<{ shared: typeof shared; value: number }>({ shared, value: 0 });
    history.push("edit", { shared, value: 1 });
    history.push("edit", { shared, value: 2 });

    expect(history.current.shared).toBe(shared);
    history.undo();
    expect(history.current.shared).toBe(shared);
  });
});
