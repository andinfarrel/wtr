# wtr

A small git-worktree shortcut: create, switch, list, and remove worktrees with a single command.
Worktrees live at `~/worktrees/<repo>/<folder>` (branch `feat/foo` maps to folder `feat-foo`).

## Layout

- `src/wtr.ts` - the CLI logic, run directly by Node (>= 23.6) via native TypeScript type-stripping. No build step.
- `wtr.sh` - a thin zsh/bash shim. It exists only so `wtr switch` / `wtr add` can change the _current shell's_ directory (a child process cannot `cd` its parent). The CLI prints the target path to stdout; the shim `cd`s there.
- `install.sh` - wires the shim into your shell rc file(s).

## Install

Requires Node >= 23.6 (and zsh or bash). From the repo directory:

```sh
./install.sh
```

This auto-detects `~/.zshrc` and `~/.bashrc` and appends a line that sources `wtr.sh` (idempotent - safe to run again). Pass explicit rc files to target them instead, e.g. `./install.sh ~/.zshrc`. Then restart your shell.

To install by hand instead, add this to your shell rc file:

```sh
source /path/to/wtr/wtr.sh
```

`fzf` is used for the interactive picker when present; otherwise a built-in picker is shown: ↑/↓ to move, type to filter by branch name, enter to select, esc to cancel.

## Usage

```
wtr switch                     Pick a worktree and cd into it   (alias: s, default)
wtr add <branch>               Create a worktree for <branch> and cd into it
wtr add <branch> -b <base>     Branch off <base> instead of current HEAD
wtr list                       List worktrees for the current repo   (alias: ls)
wtr remove [-f]                Pick a worktree to remove   (alias: rm)
wtr help
```

`WTR_ROOT` overrides the worktree root (default `~/worktrees`).

## Development

```
yarn install       # install dev deps
yarn dev -- list   # run the CLI via tsx (args after --)
yarn typecheck     # tsc --noEmit
yarn format        # prettier --write .
```
