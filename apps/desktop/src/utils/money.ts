/**
 * Money helpers for the renderer.
 *
 * These are **re-exports of `@creativelab/core`**, not copies.
 *
 * They were previously hand-mirrored here because importing core values broke the webview
 * bundle: the core barrel re-exported `ids.ts`, which imported `node:crypto`. That is now
 * fixed — `ids.ts` uses the Web Crypto API, and `@creativelab/core` resolves to the
 * isomorphic `browser.ts` entry point for the desktop app — so the renderer runs the same
 * implementation the host does. See `docs/ARCHITECTURE.md`.
 */
export { addMoney, dayKey, formatMoney, roundMoney, spendOn } from "@creativelab/core";

/** Structural shape for callers that only need an amount and a currency. */
export type { Spend as SpendLike } from "@creativelab/core";
