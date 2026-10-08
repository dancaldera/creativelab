# ADR 0003 — Capability-based provider adapters with an explicit unsupported channel

- **Status:** accepted
- **Date:** 2026-10-07
- **Requirements:** PRD §8 (Provider strategy and compatibility), §12, §19 (BYOK, which models
  to target), FR-05 to FR-08

## Context

The studio must reach image, video, speech, sound-effect, music and transcription models
through Vercel AI Gateway, ElevenLabs, Cloudflare Workers AI and an open-ended list of
optional direct providers. These providers disagree about almost everything: request
shape, sync versus async, output delivery (inline bytes vs. expiring URL), whether a seed
or negative prompt exists, duration limits, and pricing units.

The PRD is explicit that the answer is "capability-based adapters, not one hard-coded SDK
abstraction" and, critically, that "**unknown features must be hidden/disabled rather than
silently ignored**".

That last sentence is the whole design constraint. A UI that offers a Seed field to a model
that ignores it produces a user who believes they reproduced a shot when they did not. A
UI that offers a 12-second duration to a model capped at 5 produces a paid failure.

## Decision

One `ProviderAdapter` interface (PRD §8's contract verbatim: `listModels`,
`describeCapabilities`, `estimateCost`, `validate`, `submit`, `getJob`, `cancel`,
`fetchOutputs`, `normalizeError`), and a first-class **capability declaration** per model.

`validate(request, capabilities)` returns four buckets: `errors` (the request is malformed),
`warnings`, and `unsupported` — a per-field list naming exactly what the model cannot do.
The UI hides or disables controls from `unsupported`, so an unsupported feature is never
silently dropped.

Adapters **default to the conservative value**. When a gateway does not report a capability,
the adapter sets it `false`/`null` rather than guessing `true`. Under-promising a capability
shows the user a disabled control; over-promising spends their money on a request the
provider will reject.

Every adapter takes an injectable `fetch`, which is what lets the whole provider layer be
tested against a table-driven contract suite with no network.

## Consequences

- Adding a provider is one file plus a registry line; the UI needs no change.
- The model catalog is cached locally with `fetchedAt` and an `isStale` flag (PRD §8). A
  failed refresh marks entries stale rather than deleting them, so a network blip degrades
  the UI instead of emptying it. The UI shows the last-refreshed timestamp and warns on
  stale pricing.
- Capability discovery is a network call, so it must be cached and must tolerate failure.
  `ProviderRegistry.listModels` collects per-provider errors into an array instead of
  throwing, so one broken provider cannot blank the whole model picker.
- Cost estimation must be able to say "I don't know". `estimateCost` returns `Spend | null`,
  and `normalizeCost` returns `null` rather than `0` for unparseable pricing — a fabricated
  zero would silently defeat every budget cap in ADR-adjacent `budget.ts`.
- Pricing is a UI-visible, per-model fact with a refresh timestamp. Provider pricing changes
  are a product risk (PRD §18); this makes the change visible instead of surprising.
- The cost surface is BYOK. Keys live in the OS keychain behind a `CredentialVault`
  interface, are referenced by opaque handle, and never enter the webview, the database, a
  log line, or an exported project.

## Alternatives considered

- **One `AISDK`-style unified client.** Rejected by PRD §8, and in practice it either drops
  provider-specific controls (hiding real capability) or grows a lowest-common-denominator
  API that cannot express them.
- **Per-provider code paths in the UI.** Rejected: every new provider would touch the UI,
  and `if (provider === "elevenlabs")` branches are exactly what the PRD's "not one
  hard-coded SDK abstraction" warns against.
- **Optimistic capability defaults, corrected on error.** Rejected: it converts a disabled
  button into a failed paid request.
- **A required application backend that proxies providers.** Rejected by the executive
  summary (no mandatory backend) and by §13 (no publicly reachable local server).
