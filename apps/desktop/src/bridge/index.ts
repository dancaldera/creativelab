/**
 * Bridge selection.
 *
 * A Tauri webview injects `window.__TAURI_INTERNALS__`; a plain browser does not. That
 * single probe is the whole decision: native IPC when the app is packaged, the in-memory
 * mock otherwise, so `pnpm dev` in a browser is a fully explorable editor.
 *
 * The chosen bridge is a module singleton — the UI must never construct a second one,
 * because the mock's state lives inside it (see `bridge/mock.ts`).
 */
import type { StudioBridge } from "./protocol";
import { MockStudioBridge } from "./mock";
import { TauriStudioBridge } from "./tauri";

export type BridgeKind = StudioBridge["kind"];

let cached: StudioBridge | null = null;

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>);
}

/** The active bridge: Tauri when running inside the desktop shell, the mock otherwise. */
export function getBridge(): StudioBridge {
  if (!cached) cached = isTauriRuntime() ? new TauriStudioBridge() : new MockStudioBridge();
  return cached;
}

/** Which renderer backend is live; drives the connection badge in the toolbar. */
export const bridgeKind: BridgeKind = isTauriRuntime() ? "tauri" : "mock";

/** Human-readable label for the toolbar badge (PRD §14 connectivity indicator). */
export function bridgeDescription(kind: BridgeKind = bridgeKind): string {
  return kind === "tauri" ? "Native (Tauri IPC)" : "Browser mock (in-memory)";
}

export { MockStudioBridge } from "./mock";
export { TauriStudioBridge } from "./tauri";
export * from "./protocol";
