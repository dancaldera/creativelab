/**
 * `@creativelab/core/browser` — the isomorphic, dependency-free half of core.
 *
 * The main entry point (`@creativelab/core`) is a Node package: it re-exports
 * `workspace.ts`, `migrations.ts`, `session.ts` and the SQLite store, all of which import
 * `node:fs` or `node:sqlite`. A bundler targeting the webview cannot resolve those, so
 * importing anything from the main barrel used to fail the Vite build and forced the UI to
 * duplicate timeline and budget logic — exactly the drift the layering rules exist to
 * prevent.
 *
 * This entry point exports only modules that are pure and platform-neutral, so the renderer
 * can import the **same implementation** the host runs. Anything here must stay free of
 * Node built-ins; that is enforced by a test that reads this file and by the webview build
 * in CI.
 *
 * Not here, on purpose: filesystem, migrations, the project session, the SQLite store and
 * `manifest.ts` (which touches `node:fs`). Those belong to the host and are reached over
 * the allowlisted IPC bridge.
 */
export * from "./timebase.js";
export * from "./ids.js";
export * from "./errors.js";
export * from "./schema.js";
export * from "./timeline.js";
export * from "./history.js";
export * from "./jobs.js";
export * from "./budget.js";
