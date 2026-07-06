#!/usr/bin/env bash
# lens-mcp installer.
#
# Cross-platform: no system packages, no native build (tree-sitter runs as
# WebAssembly). Anything Node 18+ runs on works — Linux, macOS, Windows (WSL/
# Git Bash). Installs deps, builds, self-tests, and writes a ready-to-paste
# mcp-config.json with this install's absolute path.
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   --skip-test   Don't run the test suite after building
#   --refresh     Re-install an existing checkout (deps + build + config).
#                 Used by update.sh; identical here, kept for symmetry.
#   -h, --help    Show this help

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"
MCP_CONFIG="$REPO_DIR/mcp-config.json"
MIN_NODE_MAJOR=18

SKIP_TEST=0
for arg in "$@"; do
    case "$arg" in
        --skip-test) SKIP_TEST=1 ;;
        --refresh)   : ;;  # accepted for symmetry with update.sh
        -h|--help)   sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg (see --help)" >&2; exit 1 ;;
    esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null || fail "Node.js is required (>= ${MIN_NODE_MAJOR}). Install it from https://nodejs.org and re-run."
command -v npm  >/dev/null || fail "npm is required (ships with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || fail "Node ${NODE_MAJOR} is too old — lens needs Node >= ${MIN_NODE_MAJOR}. Upgrade and re-run."
info "Node $(node -v), npm $(npm -v)"

# --- install + build ---------------------------------------------------------
info "Installing dependencies (npm)"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

info "Building (tsc -> dist/)"
npm run build

if [ "$SKIP_TEST" -eq 0 ]; then
    info "Running the test suite (self-test)"
    npm test
fi

[ -f "$REPO_DIR/dist/index.js" ] || fail "Build produced no dist/index.js — check the npm output above."

# --- write per-machine MCP config (absolute paths; gitignored) ---------------
cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "lens": {
      "command": "node",
      "args": ["$REPO_DIR/dist/index.js"]
    }
  }
}
EOF
info "Wrote MCP config for this install: $MCP_CONFIG"

cat <<EOF

-------------------------------------------------------------------
 lens-mcp is installed. The config below (also in mcp-config.json)
 works with most MCP clients — Claude Code, Cursor, Windsurf, Codex:

$(sed 's/^/  /' "$MCP_CONFIG")

 lens reads files under its WORKING DIRECTORY — the project your MCP
 client launches it in. Point your client at a project and call
 map(".") to see it. Nothing outside the working directory is readable.

 Examples:
   Claude Code:  claude mcp add lens -- node "$REPO_DIR/dist/index.js"
                 (or copy mcp-config.json into a project as .mcp.json)
   Cursor:       merge mcp-config.json into ~/.cursor/mcp.json
   Codex CLI:    add [mcp_servers.lens] with the same command/args
                 to ~/.codex/config.toml

 Update later with:  ./update.sh
-------------------------------------------------------------------
EOF
