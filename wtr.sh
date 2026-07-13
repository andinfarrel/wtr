# wtr - git worktree shortcut (shell shim)
#
# The logic lives in src/wtr.ts (run natively by Node >= 23.6, which strips TS
# types on the fly - no build step). This shim exists only so `wtr switch` /
# `wtr add` can change the *current shell's* directory - a child process cannot
# cd its parent. src/wtr.ts prints the resolved worktree path to stdout; this
# function captures it and performs the cd. Everything else the tool prints goes
# to stderr / the terminal.
#
# Install: run `./install.sh` (adds a source line to your ~/.zshrc / ~/.bashrc),
# or add `source /path/to/wtr.sh` to your shell rc file yourself.
#
# Usage: run `wtr help`

wtr() {
  local dir
  if [ -n "${ZSH_VERSION:-}" ]; then
    dir="${${(%):-%x}:A:h}"
  else
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  local script="$dir/src/wtr.ts"
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' "wtr: node not found (install Node >= 23.6)" >&2
    return 1
  fi
  local target
  target="$(WTR_PWD="$PWD" node "$script" "$@")" || return
  [ -n "$target" ] && [ -d "$target" ] && cd "$target"
}
