<div align="center">

# Local-First AI Creative Studio

**Desktop video, image, audio and voice generation with a professional non-destructive
editor and entirely local project ownership.**

AI creates assets and proposes edits. **The local timeline is the source of truth.**

[![CI](https://github.com/dancaldera/creativelab/actions/workflows/ci.yml/badge.svg)](https://github.com/dancaldera/creativelab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![PRD](https://img.shields.io/badge/spec-docs%2FPRD.md-informational)](./docs/PRD.md)

</div>

---

## What this is

A macOS-first desktop creative studio (Tauri 2 + React + Rust) that takes a creator from a
prompt — or imported footage — to an editable, exported video. Every project, media file,
timeline state, cache, export and credential stays on the machine. No cloud account, no
hosted database, no mandatory backend.

Generation runs through **swappable, capability-based provider adapters** (Vercel AI Gateway,
ElevenLabs, Cloudflare Workers AI, and direct REST adapters). You can always edit, replace,
trim, regenerate, export and reopen your work without depending on any one provider.

The specification is [`docs/PRD.md`](./docs/PRD.md). This repository is its implementation.

## Architecture at a glance

```
packages/core        @creativelab/core        timebase · project document · timeline algebra ·
                                             job queue · budgets · migrations · workspace · session
packages/media       @creativelab/media       ffprobe · thumbnails · waveforms · proxies ·
                                             FFmpeg filter-graph export
packages/providers   @creativelab/providers   adapter contract · capability validation · model
                                             catalog · cost estimation · HTTP with retry/redaction
apps/desktop         @creativelab/desktop     Tauri 2 shell + React webview UI
apps/desktop/src-tauri                       Rust host: allowlisted IPC · OS keychain ·
                                             rusqlite · process spawning
tools/cli                                    headless end-to-end driver
```

Full detail, including the frozen module contracts and the IPC allowlist, is in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). The reasoning behind the load-bearing
decisions is in [`docs/adr/`](./docs/adr/).

### Design invariants

These are not style preferences; each one prevents a specific class of bug.

| Invariant                                                              | Prevents                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| Integer frames and exact rationals are the only canonical time         | Audio drift at 29.97/59.94 fps                 |
| Every timeline edit is a pure function returning a new document        | Undo restoring the wrong clip identity         |
| Timeline invariants are validated _before_ an edit is applied          | An editor that can reach an inconsistent state |
| Every filesystem path is resolved through a workspace scope            | Traversal and symlink escape                   |
| Child processes are spawned with argument arrays, never a shell string | Shell injection via filenames                  |
| API keys exist only in the OS keychain, referenced by opaque handle    | Credential leakage into logs or exports        |
| A job whose submission outcome is unknown is never auto-retried        | Being billed twice for one prompt              |

## Quick start

**Requirements:** Node ≥ 22.5 (for the built-in `node:sqlite`), pnpm 12, and FFmpeg/ffprobe on
`PATH` (or pointed at by `FFMPEG_PATH` / `FFPROBE_PATH`). Rust stable is required only for the
desktop shell.

```bash
pnpm install

# Run the whole verification suite: typecheck, lint, tests
pnpm verify

# Headless: create a project, generate assets, edit the timeline, export a real MP4
pnpm e2e

# Desktop app (requires the Rust toolchain)
pnpm --filter @creativelab/desktop run tauri:dev
```

### All scripts

| Script                                             | What it does                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm verify`                                      | typecheck + lint + tests                                         |
| `pnpm test`                                        | Vitest across every package                                      |
| `pnpm build`                                       | Compile the packages and bundle the webview                      |
| `pnpm e2e`                                         | Headless brief → generation → timeline → export MP4              |
| `pnpm cli --help`                                  | The headless project driver                                      |
| `pnpm backlog:plan`                                | Print the PRD-derived GitHub backlog and its dependency graph    |
| `pnpm backlog:apply`                               | Create the milestones, labels, issues and dependencies on GitHub |
| `pnpm --filter @creativelab/desktop run tauri:dev` | Run the desktop app                                              |

## Project layout on disk

A project is a folder you own (PRD §11). Nothing outside it is required to reopen it.

```
MyProject/
├── project.json                 portable manifest — project-relative media references
├── project.db                   SQLite working store (timeline, jobs, ledger, settings)
├── assets/
│   ├── originals/               imported media, copied in by default
│   └── generated/{image,video,audio}
├── cache/{proxies,thumbnails,waveforms}    rebuildable; excluded from backups
├── exports/                     rendered MP4s
└── backups/                     timestamped backups and crash snapshots
```

`Package Project` copies the project without caches or backups and then **validates the copy**
for relinking, so a packaged project opens cleanly on a machine that has never seen it.

## Security posture

- API keys are written to the **OS keychain** (macOS Keychain) and referenced by opaque
  handle. There is no column in the schema capable of holding a secret, keys are stripped
  from every error and log line, and they never enter the webview.
- Native IPC is an **allowlist**; unknown commands are rejected and every argument is
  validated Rust-side.
- File access is scoped to an approved workspace root, with `..` traversal and symlink
  escapes rejected.
- There is no publicly reachable local HTTP server. Offline editing and export transmit
  nothing.
- Remote processing is disclosed before upload: the UI names the exact files leaving the
  device and the destination provider.

See [PRD §13](./docs/PRD.md) and the [`.env.example`](./.env.example) header, which explains
why provider keys deliberately cannot be configured through a `.env` file.

## Cost controls (BYOK)

Bring your own keys; there is no application billing. Because a runaway loop spends _your_
money, four gates run before any paid submission:

1. Per-job cost cap.
2. Rolling daily ceiling.
3. Explicit approval above a threshold.
4. Unknown pricing is surfaced as a warning — and can be blocked outright.

A local submission lock plus an idempotency key collapse a double-clicked **Generate** into a
single charge. If the process dies mid-submission the job is parked in `unknown` for manual
reconciliation rather than resent, because a resend could bill twice.

## Status and roadmap

See the [milestones](https://github.com/dancaldera/creativelab/milestones) and
[issues](https://github.com/dancaldera/creativelab/issues), which are generated from the PRD
by [`tools/github/create-backlog.mjs`](./tools/github/create-backlog.mjs). Every issue cites
the PRD §/FR it comes from, and blocking relationships are recorded as real GitHub issue
dependencies. `pnpm backlog:plan` prints the graph without touching GitHub.

Delivery phases (PRD §15):

| Phase             | Deliverable                                                                               | Release gate                                            |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 0 — foundation    | Tauri shell, workspace, migrations, project serialization, media probe, provider contract | create-save-reopen and media ingestion reliable         |
| 1 — usable editor | Timeline, preview, inspector, import, undo/redo, proxies, MP4 render                      | edit an imported 60-second project and export correctly |
| 2 — AI creation   | Gateway, ElevenLabs, first video adapter, generation queue, capabilities                  | all core modalities generate and persist                |
| 3 — polished MVP  | Storyboards, voice-over, captions, budgets, templates, packaging                          | brief-to-export demo and recovery tests pass            |
| 4 — advanced      | Keyframes, transitions, smarter AI editing, more providers, local inference               | post-MVP, feedback-driven                               |

## Contributing

Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) first; it documents the module
boundaries that keep the privileged surface small. Then:

```bash
pnpm verify   # must pass before a pull request
```

Two rules that reviewers enforce:

- **Nothing privileged in the renderer.** Filesystem, keychain and process access go through
  the `StudioBridge` interface, never directly from React.
- **No test touches the network.** Adapters take an injectable `fetch`; HTTP is always mocked.

## Licensing

MIT for this repository — see [`LICENSE`](./LICENSE), which also records the third-party
obligations that a packaged build must satisfy. Two matter before any distribution:

- **FFmpeg/x264** — H.264 output requires a GPL-licensed x264 build.
- **Remotion** — named in the PRD as the intended composition engine for deterministic titles.
  It has separate commercial terms and is **not** on the current export path (which uses
  FFmpeg filter graphs), so its review is not on the critical path. Tracked by the
  "Encoder availability and licensing review" issue.

## Acknowledgements

Built to the _Local-First AI Creative Studio_ PRD v1.0. Provider model names, pricing,
capabilities and availability change frequently and are re-validated at runtime from each
provider's live catalog rather than hard-coded here.
