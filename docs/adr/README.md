# Architecture Decision Records

Short records of the decisions that shape this codebase, and — more usefully — the
alternatives that were rejected and why. Requirement references (`PRD §n`) point at
[`../PRD.md`](../PRD.md).

| ADR                                                  | Decision                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| [0001](./0001-local-first-storage.md)                | SQLite as the working store, `project.json` as the portable manifest            |
| [0002](./0002-integer-frames-as-time.md)             | Integer frames (and exact rationals) as the only canonical time                 |
| [0003](./0003-capability-based-provider-adapters.md) | Capability-based provider adapters with an explicit unsupported-feature channel |
| [0004](./0004-ffmpeg-filter-graph-export.md)         | FFmpeg filter graphs for export, not browser playback or Remotion               |
| [0005](./0005-immutable-edits-and-snapshot-undo.md)  | Pure edit functions and snapshot undo instead of mutation plus inverse commands |

## Adding a new ADR

Copy [`template.md`](./template.md), give it the next number, and add a row to the table
above. Record decisions that are expensive to reverse; do not record routine choices.
