import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as browser from "../src/browser.js";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * The browser-safe surface must stay free of Node built-ins.
 *
 * This is the regression guard for a real failure: `ids.ts` used to import `node:crypto`,
 * which made the whole core barrel un-bundleable for the webview and forced the UI to
 * duplicate timeline and budget logic. The webview build in CI catches it too, but this
 * test names the offending module instead of failing with an opaque bundler error.
 */
describe("@creativelab/core/browser", () => {
  it("exposes the isomorphic modules the renderer needs", () => {
    // Time
    expect(typeof browser.frameRate).toBe("function");
    expect(typeof browser.formatTimecode).toBe("function");
    expect(typeof browser.parseTimecode).toBe("function");
    expect(browser.FRAME_RATE_PRESETS.length).toBeGreaterThan(0);
    // Ids
    expect(typeof browser.newId).toBe("function");
    // Timeline
    expect(typeof browser.splitClip).toBe("function");
    expect(typeof browser.trimClip).toBe("function");
    expect(typeof browser.moveClip).toBe("function");
    expect(typeof browser.snapClipMove).toBe("function");
    expect(typeof browser.createInitialDocument).toBe("function");
    // History, jobs, budget
    expect(typeof browser.History).toBe("function");
    expect(typeof browser.canTransition).toBe("function");
    expect(typeof browser.evaluateBudget).toBe("function");
    expect(typeof browser.normalizeCost).toBe("function");
    // Schema tables
    expect(browser.EXPORT_PRESETS.length).toBeGreaterThan(0);
    expect(browser.ASPECT_PRESETS.length).toBeGreaterThan(0);
    expect(browser.TRACK_LIMITS.video).toBeGreaterThanOrEqual(3);
  });

  it("does not pull in filesystem, SQLite or session APIs", () => {
    // These are host-only; reaching them from the webview would fail the bundle.
    expect("openWorkspace" in browser).toBe(false);
    expect("SqliteProjectStore" in browser).toBe(false);
    expect("runMigrations" in browser).toBe(false);
    expect("ProjectSession" in browser).toBe(false);
  });

  it("imports no Node built-ins, directly or transitively", async () => {
    const visited = new Set<string>();
    const offenders: string[] = [];

    const walk = async (file: string): Promise<void> => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/from\s+"(node:[^"]+)"/g)) {
        offenders.push(`${file.replace(SOURCE_DIR, "src")} imports ${match[1]}`);
      }
      // Follow relative re-exports and value imports so the check is transitive.
      for (const match of source.matchAll(/from\s+"(\.[^"]+)\.js"/g)) {
        await walk(join(SOURCE_DIR, `${match[1]}.ts`));
      }
    };

    await walk(join(SOURCE_DIR, "browser.ts"));

    expect(offenders).toEqual([]);
    // Sanity: the walk really did traverse the module graph.
    expect(visited.size).toBeGreaterThan(4);
  });

  it("generates ids with Web Crypto, so the same code runs in the host and the webview", () => {
    const id = browser.newId("clip");
    expect(id).toMatch(/^clp_[0-9a-f]{24}$/);
    // Distinct per call.
    expect(browser.newId("clip")).not.toBe(id);
    expect(browser.newRunId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports the same module inventory from both entry points", async () => {
    // Guards against the two barrels drifting apart in the other direction: a new
    // isomorphic module added to `index.ts` but forgotten in `browser.ts`.
    const browserSource = await readFile(join(SOURCE_DIR, "browser.ts"), "utf8");
    const exported = [...browserSource.matchAll(/export \* from "\.\/([a-z-]+)\.js"/g)].map(
      (match) => match[1],
    );
    const hostOnly = new Set(["manifest", "migrations", "session", "workspace"]);
    const files = (await readdir(SOURCE_DIR))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => name.replace(/\.ts$/, ""))
      .filter((name) => name !== "browser" && name !== "index" && !hostOnly.has(name) && !name.includes("."));

    // Every candidate module should be deliberately classified, not silently skipped.
    for (const name of files) {
      expect(
        exported.includes(name) || hostOnly.has(name),
        `${name}.ts is neither exported from browser.ts nor listed as host-only`,
      ).toBe(true);
    }
  });
});
