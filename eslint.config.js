/**
 * ESLint flat config.
 *
 * Deliberately small: the goal is catching real defects (unused code, accidental `any`,
 * accidental globals), not stylistic preferences — Prettier owns formatting.
 *
 * Globals are declared explicitly rather than pulled from a package so the set is
 * auditable: anything not listed here is an error, which is how an accidental global
 * (`foo = 1`) gets caught.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Node built-ins and web-standard APIs available in Node 22+ and in the Tauri webview. */
const SHARED_GLOBALS = {
  // Node
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  global: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  require: "readonly",
  module: "writable",
  exports: "writable",
  // Timers
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  queueMicrotask: "readonly",
  // Web-standard platform APIs (undici / WebCrypto are first-class in Node 22+)
  fetch: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
  FormData: "readonly",
  Blob: "readonly",
  File: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  ReadableStream: "readonly",
  WritableStream: "readonly",
  TransformStream: "readonly",
  structuredClone: "readonly",
  crypto: "readonly",
  performance: "readonly",
  atob: "readonly",
  btoa: "readonly",
};

/** Browser-only globals, allowed for the React webview only. */
const BROWSER_GLOBALS = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  history: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  matchMedia: "readonly",
  getComputedStyle: "readonly",
  ResizeObserver: "readonly",
  MutationObserver: "readonly",
  IntersectionObserver: "readonly",
  CustomEvent: "readonly",
  Event: "readonly",
  KeyboardEvent: "readonly",
  PointerEvent: "readonly",
  MouseEvent: "readonly",
  DragEvent: "readonly",
  ClipboardEvent: "readonly",
  HTMLElement: "readonly",
  HTMLInputElement: "readonly",
  HTMLTextAreaElement: "readonly",
  HTMLCanvasElement: "readonly",
  HTMLDivElement: "readonly",
  HTMLButtonElement: "readonly",
  Element: "readonly",
  Node: "readonly",
  Image: "readonly",
  ImageData: "readonly",
  AudioContext: "readonly",
  SVGSVGElement: "readonly",
  DOMRect: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "apps/desktop/src-tauri/**",
      ".tmp/**",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: SHARED_GLOBALS,
    },
    rules: {
      // Unused code is a defect; allow the conventional `_`-prefix opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
      "no-console": "off",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": ["warn", "properties"],
    },
  },
  {
    // The React webview may touch the DOM; nothing else in the repo may.
    files: ["apps/desktop/src/**/*.ts", "apps/desktop/src/**/*.tsx"],
    languageOptions: { globals: BROWSER_GLOBALS },
  },
  {
    // Tests may reach for non-null assertions and loose casts to build fixtures.
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.test-helper.ts", "**/test/**/*.ts"],
    languageOptions: { globals: { ...SHARED_GLOBALS, ...BROWSER_GLOBALS } },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.config.ts", "**/*.config.js", "tools/**/*.mjs", "tools/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
