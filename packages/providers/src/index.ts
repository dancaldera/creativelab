/**
 * @creativelab/providers — capability-based AI provider adapters, catalog and cost
 * estimation.
 *
 * Layering (ARCHITECTURE.md): this package depends on `@creativelab/core` only. It never
 * touches the filesystem, the DOM or Tauri, and every network call goes through an injected
 * `fetch`, so the whole surface is testable without a network.
 *
 * The flow the app is expected to follow (PRD §9):
 *
 * ```ts
 * const registry = new ProviderRegistry({ catalog: new ModelCatalog({ store }), adapters: [gateway, elevenlabs, cloudflare, mock] });
 * const { models, errors } = await registry.listModels({ credentials, fetch });
 * const validation = await registry.validate(request, { credentials, fetch });   // hides unsupported features
 * const estimate = await registry.estimateCost(request, { credentials, fetch }); // may be null -> warn
 * const submitted = await registry.submit(request, { credentials, fetch });      // idempotency key set by the job queue
 * ```
 */
export * from "./capabilities.js";
export * from "./requests.js";
export * from "./adapter.js";
export * from "./credentials.js";
export * from "./http.js";
export * from "./errors.js";
export * from "./validate.js";
export * from "./cost.js";
export * from "./remote.js";
export * from "./registry.js";
export * from "./catalog.js";
export * from "./adapters/mock.js";
export * from "./adapters/vercel-gateway.js";
export * from "./adapters/elevenlabs.js";
export * from "./adapters/cloudflare.js";
export * from "./adapters/bytes.js";
export { RestAdapter, type RestAdapterConfig } from "./adapters/shared.js";
