[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/spikip/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/spikip/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format. AI models write edits in four formats — unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON. mend reads all four to one written specification (`SPEC.md`), finds the lines
each edit names even when the model drifted their whitespace or indentation, and changes every
file or none.

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22 and its standard library alone; there is nothing to install. The working directory is
the root of the tree of text files; `PATCH` is the patch file (standard input when it is absent
or `-`). `--format` is one of `unified`, `search-replace`, `v4a`, `json` or `auto` (the default,
which detects the format). `--check` reports what would change without writing; `--strict`
matches lines exactly.

mend prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and a
final `ok: <n> files`; when an edit fails it prints one `error: <code> <path>` line per failed
edit and writes nothing.

## How it works

- Lines an edit names are looked for at the first of three matching tiers: exact, then ignoring
  trailing spaces and tabs, then ignoring leading whitespace too — with re-indentation of the
  replacement lines at the third tier, exactly as `SPEC.md` section 5 says.
- Unified hunks choose the occurrence nearest the line number the hunk claims, drift included;
  V4A chunks walk a forward cursor with anchors and end-of-file chunks; SEARCH/REPLACE blocks
  must match exactly once; JSON edits match exactly.
- Edits apply in the patch's order, each to the tree as the earlier ones left it, and the whole
  patch is all-or-nothing.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the trial runner the grader uses beside `main.ts` (from the bounty kit, unchanged).
- `check.ts` — runs `main.ts` against the kit's public practice checks.
- `SPEC.md` — the specification mend implements.
- `LICENSE` — MIT.

---
<sub>Entered on [make.fun](https://make.fun/?ref=kpffwrhk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
