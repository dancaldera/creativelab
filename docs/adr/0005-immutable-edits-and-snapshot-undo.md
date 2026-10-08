# ADR 0005 — Pure edit functions and snapshot undo instead of mutation plus inverse commands

- **Status:** accepted
- **Date:** 2026-10-07
- **Requirements:** PRD §10 (immutable media assets, versioned migrations), PRD §14
  (autosave, crash snapshots), FR-01 (undo/redo survives during session), FR-03

## Context

A non-linear editor is a state machine with an undo stack as a first-class feature. The two
conventional implementations are:

1. **Mutable document plus inverse commands.** Each edit records how to undo itself.
2. **Immutable document plus snapshots.** Each edit produces a new document; undo restores a
   previous reference.

Option 1 is memory-efficient but every operation needs a correct inverse, and the inverse
must be updated whenever the operation changes. Split-then-undo must restore the _original_
clip identity, not two clips stitched back together; overwrite must remember the exact
pieces it destroyed. In practice these inverses are where undo bugs live.

The editor also needs autosave and crash snapshots (PRD §14), and a save path that "never
overwrite[s] healthy project [state] with a partial write".

## Decision

**Every timeline operation is a pure function** over `readonly Clip[]` (or the whole
`EditorDocument`) that returns a new object. State is never mutated in place.

- `History<T>` is a bounded stack of document snapshots with labels, coalescing for rapid
  same-label edits (a slider drag is one undo step), redo invalidation on new edits, and a
  configurable depth limit (default 200).
- `ProjectSession.applyEdit(label, mutator)` is the **only** way the UI mutates state, and it
  validates `assertTimelineInvariants` _before_ the change becomes visible. A mutator that
  returns the same reference is treated as a no-op and records no history step.
- Immutability extends to undo/redo: because untouched clips, tracks and assets are the same
  object references between snapshots, a 200-entry history of a large project costs 200
  copies of the _changed_ structures, not 200 copies of the media library.

## Consequences

- Undo and redo are correct by construction. There is no inverse-command bookkeeping, so
  there is no class of bug where undo restores the wrong clip identity.
- Validation is centralised. A bug in an edit function cannot corrupt the document into an
  overlapping or non-integer state, because the invariant check runs before it is applied —
  and the thrown error leaves the previous document untouched.
- Autosave is trivial: "is there unsaved work" is a boolean flag, and a crash snapshot is
  just the current document serialized. There is no partial-mutation state to reason about.
- Save is a transactional full replace of the timeline tables. At the target scale this is
  single-digit milliseconds inside one transaction, which is both faster and safer than a
  per-row diff.
- Memory is the cost. Structural sharing keeps it modest in practice, and the depth limit
  bounds the worst case. A project that is genuinely too large for snapshot undo would need
  persistent data structures; that is a deliberate post-MVP trade-off, not an oversight.
- Coalescing is time-windowed and label-keyed. This is a heuristic, so the window is
  configurable and coalescing is opt-in per edit — a structural change like "split clip"
  never coalesces, while "drag opacity" always does.

## Alternatives considered

- **Mutable state plus inverse commands.** Rejected: the inverse of overwrite is not a single
  operation, and correctness would depend on every future edit author getting it right.
- **A patch/diff library (JSON Patch, Immer patches).** Rejected for now: patches are compact
  but add a dependency and a serialization format, and they make "validate before applying"
  harder because the invalid intermediate state is constructed first. Immer's `produce` would
  reduce boilerplate inside the edit functions but would not change the architecture;
  it remains a drop-in option for ergonomics later.
- **Persisting every undo step to SQLite.** Rejected: undo is session state (FR-01 says
  "survives during session"), and writing to disk on every interaction would make dragging a
  clip I/O-bound.
- **Event sourcing.** Rejected as premature: it solves multi-writer collaboration, which PRD
  §4 places explicitly out of scope for the MVP.
