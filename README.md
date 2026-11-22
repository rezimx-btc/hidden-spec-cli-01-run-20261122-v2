# mend v2

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rezimx-btc/hidden-spec-cli-01-run-20261122-v2/rank.svg)](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rezimx-btc/hidden-spec-cli-01-run-20261122-v2/rank.svg)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rezimx-btc/hidden-spec-cli-01-run-20261122-v2/reward.svg)](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rezimx-btc/hidden-spec-cli-01-run-20261122-v2/reward.svg)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
Each format is read as `SPEC.md` says, and every file is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory. When
  it is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without
  it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 2 is a usage, no-patch, format or parse error (one line on stdout).
Exit 1 lists one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, and nothing is written. Exit 0 lists one line per
path whose state changed (`A`, `D`, `M`, or `R <old> -> <new>` for a move),
then `ok: <n> files`.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone.
- `SPEC.md` — the whole specification.
- `runner.ts`, `check.ts` — the kit's trial runner and practice checker, verbatim.

## Checks

    node check.ts <practice.json>

v2 fixes two deviations found by auditing v1 against `SPEC.md`:

- **D31 (V4A):** a blank line (empty or only whitespace) after a chunk closed by
  `*** End of File` is ignored — before the next section, before
  `*** End Patch`, or before the next `@@` chunk. A non-blank body line after
  `*** End of File` without a new `@@` is still a parse error, and a blank line
  before the first chunk is still an empty context line.
- **D9 (unified):** a `diff --git` path may contain spaces
  (`^diff --git a\/(.+) b\/(.+)$`, greedy).

One behaviour is deliberately unchanged: at matching tier 2, a non-context new
line that does not start with the old lines' leading whitespace is written
with the file's leading whitespace put in front of it — that is what the house
reference does (practice check `v-indent 6b3a9d`), even though a literal
reading of the spec's "any other line is written as it is" suggests otherwise.

## License

MIT — see `LICENSE`.
