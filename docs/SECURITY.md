# Security and privacy

This project is local-first: a project is a folder you own, and editing plus exporting it
works with no network connection and no account. This document describes the guarantees the
implementation actually makes, how each one is enforced, and where it is tested. It is
deliberately specific — a security claim you cannot point at code for is marketing.

Requirements source: [PRD §13](./PRD.md).

## Reporting a vulnerability

Open a [private security advisory](https://github.com/dancaldera/creativelab/security/advisories/new)
rather than a public issue. Please include a reproduction, the affected component, and
whether media or credentials could be exposed. There is no bug bounty.

## Credentials

**Guarantee:** provider API keys exist only in the operating system credential store. They
never reach the webview, the database, a log line, an error object or an exported project.

| Control                                                                                                           | Where                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Storage in the OS keychain (`SecItem` on macOS), service `com.creativelab.studio`, account `provider:<id>`        | `apps/desktop/src-tauri/src/credentials.rs`                                                |
| The renderer receives only `{ providerId, credentialRef, hasSecret }`                                             | `apps/desktop/src/bridge/protocol.ts`                                                      |
| No schema column is capable of holding a secret                                                                   | `packages/core/migrations/0001_init.sql` (`provider_configs` stores `credential_ref` only) |
| Secrets and `Authorization`/`x-api-key`/`cookie` headers are stripped from every error, log and `details` payload | `packages/providers/src/http.ts`, `credentials.ts`                                         |
| A plaintext `.env` is explicitly not a supported configuration path                                               | [`.env.example`](../.env.example)                                                          |

Tests: the provider contract suite asserts the key is absent from an error's `message`,
`details` **and** `JSON.stringify(error)` after an auth failure. A store test asserts no
`provider_configs` column matches `/key|secret|token|password/i`.

## Native IPC

**Guarantee:** the renderer can only call an allowlisted command, every argument is
validated, and every path is confined to the workspace the user opened.

| Control                                                                                                                | Where                                                                       |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 34-command allowlist; unknown commands are rejected                                                                    | `protocol.ts` (`IPC_COMMANDS`) and `apps/desktop/src-tauri/src/security.rs` |
| Only `core:default`, `dialog:default`, `opener:default` are granted. No `fs:*`, no `shell:*`, no `http:*`              | `apps/desktop/src-tauri/capabilities/default.json`                      |
| Path scoping: rejects `..`, absolute paths, drive letters, UNC prefixes, backslashes, NUL bytes and control characters | `packages/core/src/workspace.ts`, `security.rs`                             |
| Symlink escape is rejected by canonicalising and re-checking, not by string prefix comparison                          | `security.rs`, tested with a symlink pointing outside the workspace         |

Tests: `workspace.test.ts` covers traversal in several spellings; the Rust `security.rs`
tests cover traversal, a NUL byte, an absolute path and a symlink escape.

## Process execution

**Guarantee:** no shell is ever involved, so a filename cannot become a command.

FFmpeg and ffprobe are spawned with an **argument array** in both the TypeScript
(`packages/media/src/exec.ts`) and Rust (`media.rs`) paths. There is no `exec`, no
`shell: true` and no string interpolation of a path into a command line.

Test: an argv round-trip passes `; rm -rf / && $(whoami) \`id\` | tee /tmp/pwned` as a single
argument and asserts it arrives verbatim with nothing executed.

## Network exposure

**Guarantee:** there is no publicly reachable local service. The webview talks to Rust over
Tauri IPC, not HTTP.

Provider calls are made from Rust (`reqwest`) or from the Node sidecar path, and only to
provider endpoints. There is no browser-accessible localhost server, so there is no
renderer-token or CORS surface to get wrong. Per PRD §13, if a loopback service were ever
introduced it must bind `127.0.0.1` with a per-session token.

## Data leaving the device

**Guarantee:** nothing is transmitted unless the user asks for a generation that requires it,
and they are told exactly what would leave.

- Remote-processing disclosure names the specific files and the destination provider before upload.
- Provider retention and usage terms are linked at the point of upload.
- Reference-likeness and voice-cloning flows require an explicit rights confirmation.
- Offline editing and export transmit nothing: `core`, `media` and the export path contain no
  network code at all.
- Generation controls show connectivity and credential state, so a user is never surprised by
  a remote call.

## Local data integrity

| Control                                                                                                         | Where                               |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Atomic temp-file-plus-`fsync`-plus-rename writes; a crash leaves the old or the new file, never a truncated one | `atomicWriteFile` in `workspace.ts` |
| One SQLite transaction per save; a constraint violation rolls back and preserves the previous state             | `SqliteProjectStore.saveDocument`   |
| A migration whose checksum drifted is refused rather than silently applied                                      | `migrations.ts`                     |
| A database written by a newer build is refused rather than misinterpreted                                       | `migrations.ts`                     |
| `Package Project` refuses a non-empty destination instead of merging two projects                               | `ProjectSession.packageProject`     |

## Cost safety

A BYOK product spends the user's money, so the cost controls are treated as a security
property rather than a convenience:

- Per-job cap, rolling daily ceiling and an approval threshold are evaluated **before**
  submission (`packages/core/src/budget.ts`).
- Unparseable or absent pricing yields `null`, never a fabricated `0` — a fabricated zero
  would silently defeat every cap.
- A local submission lock plus an idempotency key collapse a double-clicked Generate into one
  charge.
- A submission whose outcome is unverifiable after a crash is parked in `unknown` and
  **never auto-resubmitted**, because a resend could bill twice.

## Known limitations

Stated plainly, because pretending otherwise would be worse than the gaps themselves:

- **Provider-side handling is out of our control.** Once media is uploaded, the provider's
  retention and training policies apply. The UI discloses this; it cannot enforce it.
- **Protection is only as strong as the OS account.** Anything running as the same user can
  read the keychain entry, exactly as it could read the project folder.
- **Media is not re-encoded for sanitisation.** FFmpeg is used to decode untrusted input; a
  codec vulnerability in FFmpeg is a vulnerability here. The pinned build should be kept
  current, and PRD §18 tracks the packaging and codec risk.
- **Clip effects and keyframes are stored but not yet applied by the renderer** (see
  [TRACEABILITY](./TRACEABILITY.md), FR-12). That is a fidelity limitation, not a security
  one, and it is disclosed in the UI.
- **No third-party security audit has been performed.**
