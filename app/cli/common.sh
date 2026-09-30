#!/usr/bin/env bash
# ============================================================
# cli/common.sh — Shared helpers for the Whisplay CLI
# ============================================================

# ── Version from git tag ─────────────────────────────────────
_resolve_version() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if command -v git &>/dev/null && git -C "$root" rev-parse --git-dir &>/dev/null; then
    local tag
    tag="$(git -C "$root" describe --tags --abbrev=0 2>/dev/null || true)"
    if [ -n "$tag" ]; then
      # Strip leading 'v' if present
      echo "${tag#v}"
      return
    fi
  fi
  # Fallback: read from package.json
  if [ -f "$root/package.json" ]; then
    grep -o '"version": *"[^"]*"' "$root/package.json" | head -1 | sed 's/.*"\([^"]*\)"/\1/'
    return
  fi
  echo "unknown"
}
VERSION="$(_resolve_version)"

# ── Resolve project root ─────────────────────────────────────
# Walk up from the caller script's real location to find the project root.
# Expects to be sourced from bin/whisplay which lives in <project>/bin/.
resolve_project_root() {
  local source="${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}"
  # Resolve symlinks
  while [ -L "$source" ]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done
  local script_dir
  script_dir="$(cd -P "$(dirname "$source")" && pwd)"

  # Try <script_dir>/.. (bin/whisplay → project root)
  local root="$(cd "$script_dir/.." && pwd)"
  if [ -f "$root/package.json" ]; then
    echo "$root"
    return
  fi

  # Try <script_dir>/../.. (cli/common.sh → project root)
  root="$(cd "$script_dir/../.." 2>/dev/null && pwd)"
  if [ -f "$root/package.json" ]; then
    echo "$root"
    return
  fi

  # Fallback: current working directory
  if [ -f "$PWD/package.json" ] && grep -q '"ai-node"' "$PWD/package.json" 2>/dev/null; then
    echo "$PWD"
    return
  fi

  echo ""
}

# ── Git repo root for `whisplay update` ──────────────────────
# PROJECT_ROOT (app/) is the git repo root on a standalone
# whisplay-ai-chatbot checkout (upstream layout), but on akbal-pi it's a
# subdirectory of the monorepo (README.md/docs/setup/app/ all under one
# clone) — `git pull` has to run at the actual repo root either way, or a
# nested checkout would never see it as a git command at all.
resolve_update_git_root() {
  if ! git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree &>/dev/null; then
    echo ""
    return
  fi
  git -C "$PROJECT_ROOT" rev-parse --show-toplevel
}

# ── Terminal colors ──────────────────────────────────────────

_green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
_yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
_red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
_bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
_dim()    { printf '\033[2m%s\033[0m\n' "$*"; }

# ── Package manager helpers ──────────────────────────────────

use_npm() {
  [ -f "${PROJECT_ROOT}/use_npm" ]
}

pkg_run() {
  if use_npm; then
    require_cmd npm
    npm run "$@"
  elif command -v yarn &>/dev/null; then
    yarn run "$@"
  else
    require_cmd npm
    _yellow "Warning: yarn not found. Falling back to npm."
    npm run "$@"
  fi
}

# ── Utility functions ────────────────────────────────────────

ensure_plugins_dir() {
  if [ ! -d "$PLUGINS_DIR" ]; then
    mkdir -p "$PLUGINS_DIR"
  fi
}

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    _red "Error: '$1' is required but not found. Please install it first."
    exit 1
  fi
}

# Derive directory name from a GitHub URL
# e.g. https://github.com/user/whisplay-plugin-foo.git → whisplay-plugin-foo
repo_to_dirname() {
  local url="$1"
  local base
  base="$(basename "$url")"
  echo "${base%.git}"
}
