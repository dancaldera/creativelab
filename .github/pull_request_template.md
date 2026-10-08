<!--
Thanks for contributing. Two rules reviewers enforce, because they are hard to
retrofit later:

  1. Nothing privileged in the renderer — filesystem, keychain and process access go
     through the StudioBridge IPC interface, never directly from React.
  2. No test touches the network — provider adapters take an injectable `fetch`.

If this change alters a load-bearing decision (time representation, storage, the
provider contract, the render path, or undo), add or supersede an ADR in docs/adr/.
-->

## What and why

<!-- One or two sentences. Link the issue: "Closes #123". -->

Closes #

## PRD traceability

Which requirement does this satisfy? (e.g. `FR-03`, `PRD §12`)

## How it was verified

<!-- Real commands and real results. "Should work" is not verification. -->

```
pnpm verify
```

## Checklist

- [ ] `pnpm verify` passes (typecheck + lint + tests)
- [ ] New behaviour has tests, and tests assert real output rather than restating the implementation
- [ ] No API key, secret or `.env` value is logged, serialized or committed
- [ ] Any new filesystem path goes through the workspace scope helper
- [ ] Any new child process is spawned with an argument array, never a shell string
- [ ] Timeline changes keep coordinates as integer frames
- [ ] An ADR was added or superseded if a load-bearing decision changed
- [ ] `docs/ARCHITECTURE.md` updated if a module contract or IPC command changed

## Risk and rollback

<!-- What could this break, and how do we undo it? Note any migration or schema change. -->
