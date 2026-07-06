#!/usr/bin/env bash
# lens-mcp updater: pull the latest source, then reinstall (deps + build +
# self-test + regenerated mcp-config.json).
#
# Usage:
#   ./update.sh [--force]
#
# Options:
#   --force   Stash local modifications to tracked files before updating
#             (recover them later with `git stash pop`)
#   -h, --help

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force)    FORCE=1 ;;
        -h|--help)  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg (see --help)" >&2; exit 1 ;;
    esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || fail "git is required."
[ -d .git ] || fail "This is not a git checkout, so it can't be updated in place.
Re-install fresh:
  git clone https://github.com/segentic-lab/lens-mcp.git && cd lens-mcp && ./install.sh"

# Local modifications would make the pull fail halfway.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    if [ "$FORCE" -eq 1 ]; then
        info "Stashing local modifications (recover later with 'git stash pop')"
        git stash push --quiet -m "update.sh auto-stash"
    else
        fail "You have local modifications to tracked files:
$(git status --porcelain --untracked-files=no | sed 's/^/  /')
Commit or stash them first, or re-run with --force to stash automatically."
    fi
fi

BEFORE="$(git rev-parse HEAD)"
info "Fetching latest from $(git remote get-url origin)"
git pull --ff-only || fail "Your branch has diverged from origin — resolve manually (git status, git pull --rebase)."
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
    info "Source already up to date ($(git rev-parse --short HEAD))"
else
    info "Updated $(git rev-parse --short "$BEFORE") -> $(git rev-parse --short "$AFTER"):"
    git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/      /'
fi

# Reinstall: deps + build + self-test + regenerated mcp-config.json.
info "Refreshing install: ./install.sh --refresh"
exec ./install.sh --refresh
