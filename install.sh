#!/usr/bin/env sh
# wtr installer - adds a line to your shell rc file(s) that sources the wtr
# shell shim, making the `wtr` command available in new shells.
#
# Usage:
#   ./install.sh              # auto-detect ~/.zshrc and ~/.bashrc
#   ./install.sh ~/.zshrc     # install into specific rc file(s)
set -eu

# Absolute path to the directory holding this script (and wtr.sh).
script_dir="$(cd "$(dirname "$0")" && pwd)"
shim="$script_dir/wtr.sh"
marker="# wtr shell shim - added by install.sh"

if [ ! -f "$shim" ]; then
  printf 'install.sh: wtr.sh not found next to this script (%s)\n' "$shim" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'install.sh: warning: node not found on PATH (wtr needs Node >= 23.6)\n' >&2
fi

installed_any=0

inject() {
  rc="$1"
  if [ -f "$rc" ] && grep -qF "$shim" "$rc" 2>/dev/null; then
    printf 'wtr: already installed in %s\n' "$rc"
    return 0
  fi
  {
    printf '\n%s\n' "$marker"
    printf '[ -f "%s" ] && source "%s"\n' "$shim" "$shim"
  } >>"$rc" || {
    printf 'install.sh: failed to write %s\n' "$rc" >&2
    return 1
  }
  printf 'wtr: added shim to %s\n' "$rc"
  installed_any=1
}

if [ "$#" -gt 0 ]; then
  for rc in "$@"; do
    inject "$rc"
  done
else
  found=0
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ]; then
      inject "$rc"
      found=1
    fi
  done
  if [ "$found" -eq 0 ]; then
    case "${SHELL:-}" in
      *bash*) inject "$HOME/.bashrc" ;;
      *) inject "$HOME/.zshrc" ;;
    esac
  fi
fi

if [ "$installed_any" -eq 1 ]; then
  printf '\nwtr installed. Restart your shell (or re-source your rc file) to use it.\n'
  printf 'Try:  wtr help\n'
fi
