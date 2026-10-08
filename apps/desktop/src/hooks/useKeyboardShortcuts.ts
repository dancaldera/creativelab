/**
 * Keyboard map (PRD §6: "space play/pause; J/K/L transport; S split; Cmd/Ctrl+Z undo;
 * +/- timeline zoom; delete and multi-select").
 *
 * The resolution step is a **pure function of the event**, deliberately separated from the
 * React effect that binds it, so the whole table is unit-testable in the node environment.
 * `resolveShortcut` returns either an action or `null`; the effect is a thin dispatcher.
 */
import { useEffect } from "react";
import { deleteClips as deleteClipsOp } from "../state/coreOps";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";

export type ShortcutAction =
  | { type: "play-pause" }
  | { type: "stop" }
  /** J/L. The dispatcher turns a repeated press into the next shuttle speed. */
  | { type: "shuttle"; direction: "reverse" | "forward" }
  | { type: "split" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "zoom"; factor: number }
  | { type: "delete" }
  | { type: "delete-ripple" }
  | { type: "select-all" }
  | { type: "clear-selection" }
  | { type: "toggle-snap" }
  | { type: "duplicate" };

/** The subset of `KeyboardEvent` the resolver needs; makes tests trivial and DOM-free. */
export interface ShortcutEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** `event.target`; typing targets suppress every shortcut except Escape. */
  target?: unknown;
  /** `event.repeat`; surfaced so callers can distinguish a held key from a new press. */
  repeat?: boolean;
}

/** Input-like targets where the user is typing and single-key shortcuts must not fire. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditableElement(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (TYPING_TAGS.has(tag)) return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.getAttribute === "function" && element.getAttribute("role") === "textbox") return true;
  if (typeof element.closest === "function" && element.closest("[contenteditable='true'],[data-shortcuts='off']")) {
    return true;
  }
  return false;
}

/** The primary accelerator: Cmd on macOS, Ctrl elsewhere — either is accepted. */
function hasPrimaryModifier(event: ShortcutEventLike): boolean {
  return event.metaKey === true || event.ctrlKey === true;
}

/** Alt/Option is never part of a binding, so it must not be swallowed silently. */
function hasForeignModifier(event: ShortcutEventLike): boolean {
  return event.altKey === true;
}

/** Rate ladder for repeated J/L presses. */
export const SHUTTLE_RATES = [1, 2, 4, 8] as const;

export const ZOOM_IN_FACTOR = 1.25;
export const ZOOM_OUT_FACTOR = 0.8;

/**
 * Map a key event to an editor action.
 *
 * Order matters: the "typing" rule is checked first (only `Escape` survives it), then the
 * accelerator shortcuts, then the bare single keys.
 */
export function resolveShortcut(event: ShortcutEventLike): ShortcutAction | null {
  const key = typeof event.key === "string" ? event.key : "";
  if (key === "") return null;

  const typing = isEditableElement(event.target);
  const primary = hasPrimaryModifier(event);
  const shift = event.shiftKey === true;
  // Normalize *everything* to lower case: multi-character names such as "Escape", "Delete",
  // "Backspace" and "Spacebar" must compare against the same table as single characters.
  const lower = key.toLowerCase();
  // Layout-independent fallbacks for the keys whose `key` value moves between layouts
  // (`+`/`=` on a US keyboard is `Equal`, and so on).
  const code = typeof event.code === "string" ? event.code : "";
  const isZoomIn = lower === "+" || lower === "=" || code === "Equal" || code === "NumpadAdd";
  const isZoomOut = lower === "-" || lower === "_" || code === "Minus" || code === "NumpadSubtract";

  // Escape always clears the selection, even from inside a field — it is the "get me out" key.
  if (lower === "escape") return { type: "clear-selection" };

  if (typing) return null;
  if (hasForeignModifier(event)) return null;

  // -- accelerator shortcuts ------------------------------------------------
  if (primary) {
    switch (lower) {
      case "z":
        return shift ? { type: "redo" } : { type: "undo" };
      case "y":
        // Windows convention for redo.
        return { type: "redo" };
      case "a":
        return { type: "select-all" };
      case "d":
        return { type: "duplicate" };
      default:
        return null;
    }
  }

  if (shift && lower === "delete") return { type: "delete-ripple" };

  // -- transport and edit keys ---------------------------------------------
  switch (lower) {
    case " ":
    case "spacebar":
      return { type: "play-pause" };
    case "k":
      return { type: "stop" };
    case "j":
      return { type: "shuttle", direction: "reverse" };
    case "l":
      return { type: "shuttle", direction: "forward" };
    case "s":
      return { type: "split" };
    case "n":
      return { type: "toggle-snap" };
    case "delete":
    case "backspace":
      return { type: "delete" };
    default:
      break;
  }

  if (isZoomIn) return { type: "zoom", factor: ZOOM_IN_FACTOR };
  if (isZoomOut) return { type: "zoom", factor: ZOOM_OUT_FACTOR };
  return null;
}

/**
 * Next shuttle rate for a repeated press: 1x → 2x → 4x → 8x → back to 1x, signed by
 * direction. `K` resets the rate to zero, which is why the store's rate is the input.
 */
export function nextShuttleRate(current: number, direction: "reverse" | "forward"): number {
  const sign = direction === "reverse" ? -1 : 1;
  // Switching direction restarts the ladder rather than continuing the opposite one.
  if (Math.sign(current) !== 0 && Math.sign(current) !== sign) return sign;
  const magnitude = Math.abs(current);
  const index = SHUTTLE_RATES.indexOf(magnitude as (typeof SHUTTLE_RATES)[number]);
  const next = SHUTTLE_RATES[index === -1 ? 0 : (index + 1) % SHUTTLE_RATES.length]!;
  return next * sign;
}

export interface ShortcutHandlers {
  playPause: () => void;
  stop: () => void;
  shuttle: (direction: "reverse" | "forward") => void;
  split: () => void;
  undo: () => void;
  redo: () => void;
  zoom: (factor: number) => void;
  deleteSelection: (ripple: boolean) => void;
  selectAll: () => void;
  clearSelection: () => void;
  toggleSnap: () => void;
  duplicate: () => void;
}

/** Dispatch one resolved action through a handler bag. Returns true when handled. */
export function dispatchShortcut(action: ShortcutAction | null, handlers: ShortcutHandlers): boolean {
  if (!action) return false;
  switch (action.type) {
    case "play-pause":
      handlers.playPause();
      return true;
    case "stop":
      handlers.stop();
      return true;
    case "shuttle":
      handlers.shuttle(action.direction);
      return true;
    case "split":
      handlers.split();
      return true;
    case "undo":
      handlers.undo();
      return true;
    case "redo":
      handlers.redo();
      return true;
    case "zoom":
      handlers.zoom(action.factor);
      return true;
    case "delete":
      handlers.deleteSelection(false);
      return true;
    case "delete-ripple":
      handlers.deleteSelection(true);
      return true;
    case "select-all":
      handlers.selectAll();
      return true;
    case "clear-selection":
      handlers.clearSelection();
      return true;
    case "toggle-snap":
      handlers.toggleSnap();
      return true;
    case "duplicate":
      handlers.duplicate();
      return true;
    default: {
      const never: never = action;
      void never;
      return false;
    }
  }
}

/**
 * Delete the selection.
 *
 * Without `ripple` this defers to the store's sticky edit mode; with `ripple`
 * (`Shift+Delete`) it always closes the gap by routing through the same pure
 * delete-with-ripple algebra the store uses.
 */
export function deleteSelectionVia(ripple: boolean): void {
  const editor = useEditorStore.getState();
  if (!ripple) {
    editor.deleteSelected();
    return;
  }
  const selection = editor.selection;
  if (selection.size === 0) return;
  editor.applyEdit("Ripple delete", (document) => {
    const locked = new Set(document.tracks.filter((track) => track.locked).map((track) => track.id));
    const ids = document.clips
      .filter((clip) => selection.has(clip.id) && !locked.has(clip.trackId))
      .map((clip) => clip.id);
    if (ids.length === 0) return document;
    return { ...document, clips: deleteClipsOp(document.clips, ids, { ripple: true }) };
  });
  editor.clearSelection();
}

/**
 * Bind the table to the window. `Space` and the delete keys are prevented from their
 * default browser behaviour, but only when a binding actually matched.
 */
export function useKeyboardShortcuts(enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof window === "undefined") return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      const editor = useEditorStore.getState();
      const ui = useUiStore.getState();
      const action = resolveShortcut({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        target: event.target,
        repeat: event.repeat,
      });
      if (!action) return;

      const handled = dispatchShortcut(action, {
        playPause: () => editor.setPlaying(!editor.isPlaying, editor.isPlaying ? 0 : 1),
        stop: () => editor.setPlaying(false, 0),
        shuttle: (direction) => {
          const rate = nextShuttleRate(editor.playbackRate, direction);
          editor.setPlaybackRate(rate);
          ui.showToast(`${Math.abs(rate)}x ${rate < 0 ? "reverse" : "play"}`, "info");
        },
        split: () => editor.splitAtPlayhead(),
        undo: () => editor.undo(),
        redo: () => editor.redo(),
        zoom: (factor) => editor.zoomBy(factor),
        deleteSelection: (ripple) => deleteSelectionVia(ripple),
        selectAll: () => editor.selectClips(editor.document.clips.map((clip) => clip.id)),
        clearSelection: () => editor.clearSelection(),
        toggleSnap: () => editor.toggleSnap(),
        duplicate: () => editor.duplicateSelected(),
      });

      if (!handled) return;
      // Space scrolls the page; Delete/Backspace can trigger back-navigation.
      if (action.type === "play-pause" || action.type === "delete" || action.type === "delete-ripple") {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
