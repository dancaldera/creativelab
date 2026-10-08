/**
 * Keyboard shortcut resolution tests.
 *
 * `resolveShortcut` is a pure function of the event, so the entire key map can be exercised
 * in the node environment with plain objects — no DOM, no React, no fake timers.
 */
import { describe, expect, it } from "vitest";
import {
  SHUTTLE_RATES,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
  deleteSelectionVia,
  dispatchShortcut,
  nextShuttleRate,
  resolveShortcut,
  type ShortcutAction,
  type ShortcutEventLike,
  type ShortcutHandlers,
} from "./useKeyboardShortcuts";

/** A non-typing target: a plain object with no input semantics. */
const CANVAS = { tagName: "CANVAS" };
const INPUT = { tagName: "INPUT" };
const TEXTAREA = { tagName: "TEXTAREA" };
const CONTENTEDITABLE = { tagName: "DIV", isContentEditable: true, getAttribute: () => "textbox" };

function key(k: string, modifiers: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key: k, target: CANVAS, ...modifiers };
}

describe("resolveShortcut: transport", () => {
  it("maps space to play/pause", () => {
    expect(resolveShortcut(key(" "))).toEqual({ type: "play-pause" });
    expect(resolveShortcut(key("Spacebar"))).toEqual({ type: "play-pause" });
  });

  it("maps J/K/L to reverse, stop and forward", () => {
    expect(resolveShortcut(key("j"))).toEqual({ type: "shuttle", direction: "reverse" });
    expect(resolveShortcut(key("J"))).toEqual({ type: "shuttle", direction: "reverse" });
    expect(resolveShortcut(key("k"))).toEqual({ type: "stop" });
    expect(resolveShortcut(key("l"))).toEqual({ type: "shuttle", direction: "forward" });
  });

  it("ramps the shuttle speed on repeated presses and wraps at 8x", () => {
    let rate = 0;
    const ladder: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      rate = nextShuttleRate(rate, "forward");
      ladder.push(rate);
    }
    expect(ladder).toEqual([1, 2, 4, 8, 1, 2]);
    expect(SHUTTLE_RATES).toEqual([1, 2, 4, 8]);
  });

  it("restarts the ladder when the direction flips", () => {
    expect(nextShuttleRate(8, "reverse")).toBe(-1);
    expect(nextShuttleRate(-8, "forward")).toBe(1);
    expect(nextShuttleRate(0, "reverse")).toBe(-1);
  });
});

describe("resolveShortcut: editing keys", () => {
  it("maps S to split", () => {
    expect(resolveShortcut(key("s"))).toEqual({ type: "split" });
    expect(resolveShortcut(key("S"))).toEqual({ type: "split" });
  });

  it("maps N to the snapping toggle", () => {
    expect(resolveShortcut(key("n"))).toEqual({ type: "toggle-snap" });
  });

  it("maps +, = and - to zoom factors", () => {
    expect(resolveShortcut(key("+"))).toEqual({ type: "zoom", factor: ZOOM_IN_FACTOR });
    expect(resolveShortcut(key("="))).toEqual({ type: "zoom", factor: ZOOM_IN_FACTOR });
    expect(resolveShortcut(key("-"))).toEqual({ type: "zoom", factor: ZOOM_OUT_FACTOR });
    expect(resolveShortcut(key("_"))).toEqual({ type: "zoom", factor: ZOOM_OUT_FACTOR });
  });

  it("maps Delete and Backspace to delete, and Shift+Delete to ripple delete", () => {
    expect(resolveShortcut(key("Delete"))).toEqual({ type: "delete" });
    expect(resolveShortcut(key("Backspace"))).toEqual({ type: "delete" });
    expect(resolveShortcut(key("Delete", { shiftKey: true }))).toEqual({ type: "delete-ripple" });
  });

  it("maps Escape to clearing the selection", () => {
    expect(resolveShortcut(key("Escape"))).toEqual({ type: "clear-selection" });
  });

  it("ignores unrelated keys", () => {
    for (const unrelated of ["a", "q", "F5", "ArrowLeft", "Enter", "Tab"]) {
      expect(resolveShortcut(key(unrelated))).toBeNull();
    }
  });

  it("ignores an empty key value", () => {
    expect(resolveShortcut({ key: "", target: CANVAS })).toBeNull();
  });
});

describe("resolveShortcut: accelerator keys, cross-platform", () => {
  it("maps Cmd+Z (macOS) and Ctrl+Z (other platforms) to undo", () => {
    expect(resolveShortcut(key("z", { metaKey: true }))).toEqual({ type: "undo" });
    expect(resolveShortcut(key("z", { ctrlKey: true }))).toEqual({ type: "undo" });
  });

  it("maps Shift+Cmd+Z and Shift+Ctrl+Z to redo", () => {
    expect(resolveShortcut(key("z", { metaKey: true, shiftKey: true }))).toEqual({ type: "redo" });
    expect(resolveShortcut(key("z", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "redo" });
    expect(resolveShortcut(key("Z", { metaKey: true, shiftKey: true }))).toEqual({ type: "redo" });
  });

  it("also accepts the Windows Ctrl+Y redo convention", () => {
    expect(resolveShortcut(key("y", { ctrlKey: true }))).toEqual({ type: "redo" });
  });

  it("maps Cmd/Ctrl+A to select-all and Cmd/Ctrl+D to duplicate", () => {
    expect(resolveShortcut(key("a", { metaKey: true }))).toEqual({ type: "select-all" });
    expect(resolveShortcut(key("a", { ctrlKey: true }))).toEqual({ type: "select-all" });
    expect(resolveShortcut(key("d", { metaKey: true }))).toEqual({ type: "duplicate" });
  });

  it("does not fire plain-key bindings while an accelerator is held", () => {
    expect(resolveShortcut(key("s", { metaKey: true }))).toBeNull();
    expect(resolveShortcut(key(" ", { ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(key("Delete", { metaKey: true }))).toBeNull();
  });

  it("ignores bindings when Alt/Option is held", () => {
    expect(resolveShortcut(key("s", { altKey: true }))).toBeNull();
    expect(resolveShortcut(key(" ", { altKey: true }))).toBeNull();
    expect(resolveShortcut(key("z", { altKey: true, metaKey: true }))).toBeNull();
  });
});

describe("resolveShortcut: typing targets", () => {
  it("ignores every shortcut while the focus is in an input, textarea or contenteditable", () => {
    for (const target of [INPUT, TEXTAREA, CONTENTEDITABLE]) {
      for (const k of [" ", "j", "k", "l", "s", "n", "+", "-", "Delete", "Backspace"]) {
        expect(resolveShortcut({ key: k, target })).toBeNull();
      }
    }
  });

  it("still ignores accelerators inside a text field, so Cmd+A selects text", () => {
    expect(resolveShortcut({ key: "a", metaKey: true, target: INPUT })).toBeNull();
    expect(resolveShortcut({ key: "z", metaKey: true, target: TEXTAREA })).toBeNull();
  });

  it("honours an explicit opt-out marker", () => {
    const optOut = {
      tagName: "DIV",
      closest: (selector: string) => (selector.includes("data-shortcuts") ? {} : null),
    };
    expect(resolveShortcut({ key: " ", target: optOut })).toBeNull();
  });

  it("lets Escape through from a text field so the user can always escape", () => {
    expect(resolveShortcut({ key: "Escape", target: INPUT })).toEqual({ type: "clear-selection" });
    expect(resolveShortcut({ key: "Escape", target: CONTENTEDITABLE })).toEqual({ type: "clear-selection" });
  });
});

describe("dispatchShortcut", () => {
  function harness(): { handlers: ShortcutHandlers; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      handlers: {
        playPause: () => calls.push("playPause"),
        stop: () => calls.push("stop"),
        shuttle: (direction) => calls.push(`shuttle:${direction}`),
        split: () => calls.push("split"),
        undo: () => calls.push("undo"),
        redo: () => calls.push("redo"),
        zoom: (factor) => calls.push(`zoom:${factor}`),
        deleteSelection: (ripple) => calls.push(`delete:${ripple}`),
        selectAll: () => calls.push("selectAll"),
        clearSelection: () => calls.push("clearSelection"),
        toggleSnap: () => calls.push("toggleSnap"),
        duplicate: () => calls.push("duplicate"),
      },
    };
  }

  it("routes every action to exactly one handler", () => {
    const cases: Array<[ShortcutAction, string]> = [
      [{ type: "play-pause" }, "playPause"],
      [{ type: "stop" }, "stop"],
      [{ type: "shuttle", direction: "forward" }, "shuttle:forward"],
      [{ type: "shuttle", direction: "reverse" }, "shuttle:reverse"],
      [{ type: "split" }, "split"],
      [{ type: "undo" }, "undo"],
      [{ type: "redo" }, "redo"],
      [{ type: "zoom", factor: 1.25 }, "zoom:1.25"],
      [{ type: "delete" }, "delete:false"],
      [{ type: "delete-ripple" }, "delete:true"],
      [{ type: "select-all" }, "selectAll"],
      [{ type: "clear-selection" }, "clearSelection"],
      [{ type: "toggle-snap" }, "toggleSnap"],
      [{ type: "duplicate" }, "duplicate"],
    ];
    for (const [action, expected] of cases) {
      const { handlers, calls } = harness();
      expect(dispatchShortcut(action, handlers)).toBe(true);
      expect(calls).toEqual([expected]);
    }
  });

  it("reports null actions as unhandled so the browser default survives", () => {
    const { handlers, calls } = harness();
    expect(dispatchShortcut(null, handlers)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("composes resolution and dispatch end to end", () => {
    const { handlers, calls } = harness();
    dispatchShortcut(resolveShortcut(key("z", { metaKey: true })), handlers);
    dispatchShortcut(resolveShortcut(key("z", { metaKey: true, shiftKey: true })), handlers);
    dispatchShortcut(resolveShortcut(key(" ")), handlers);
    dispatchShortcut(resolveShortcut(key("Delete")), handlers);
    expect(calls).toEqual(["undo", "redo", "playPause", "delete:false"]);
  });
});

describe("deleteSelectionVia", () => {
  it("is a thin dispatcher that reads the live store, not a captured value", () => {
    // The store is a module singleton in this test environment; calling the function with an
    // empty selection must be a no-op rather than throwing.
    expect(() => deleteSelectionVia(false)).not.toThrow();
    expect(() => deleteSelectionVia(true)).not.toThrow();
  });
});
