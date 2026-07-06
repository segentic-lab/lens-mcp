# lens-mcp

**Deterministic navigation maps over code AND markdown — for AI agents.** One
MCP server, two lenses: tree-sitter for source (TypeScript / JavaScript /
Python) and a markdown lens for docs. It answers *"where is X and what's the
shape of this project?"* in one cheap call — so an agent spends context on
thinking, not on browsing files.

> Speaks the [Model Context Protocol](https://modelcontextprotocol.io); works
> with any MCP client — Claude Code, Cursor, Codex, or your own agent.

## Why

An agent orienting in an unfamiliar repo otherwise burns tokens `ls`-ing,
`grep`-ing, and Reading whole files to find the *one* function or the *right*
doc. lens returns the map instead of the territory:

- **`function_body` reads one function** — often ~99% less context than Reading
  the file it lives in.
- **`heading` reads one doc section** — the referenced heading and its
  subsections, nothing else.
- **`map` returns the whole project's surface** — every code file's structure
  **and** every doc's outline — in a single call.

Every output is deterministic (real parsing, not a model summarizing), capped
with an honest `truncated` flag, and framed by one contract:

> **lens is a navigation map. Use it to *locate*, then Read the real
> source/section before judging or modifying it. A signature is not the body;
> an outline is not the section.**

## Tools (13)

### Orientation
| Tool | What it does |
|---|---|
| `map` | Whole-tree surface in one call: per code file → structure; per doc → title + outline. Both families, one response. |
| `info` | Version, sandbox root, supported languages/extensions, tool list, every output cap, and the lens contract. |
| `lens_system` | Install status, self-update (`update.sh` under the hood), and fetch the current AGENTS.md — lens's self-maintenance tool. |

### Code (tree-sitter — `.ts .tsx .mts .cts .js .jsx .mjs .cjs .py`) + Prisma (`.prisma`)
| Tool | What it does |
|---|---|
| `overview` | One file's imports, exports, classes (+ methods), top-level functions, with line ranges. |
| `functions` | Every function incl. nested — signatures, params/types, `parent` scope, kind. |
| `function_body` | Verbatim source of ONE function — the focused read. |
| `comments` | Comments + `TODO/FIXME/BUG/HACK/…` markers (`markersOnly` for the debt list). |
| `find` | Locate a **definition** by name — functions, classes, and now `const`/`type`/`enum`/exports — across a directory. |
| `references` | The inverse: who **uses** a symbol — call sites, imports, type-refs — tree-sitter-precise, no grep false positives. |

### Docs (markdown — `.md .markdown .mdx`)
| Tool | What it does |
|---|---|
| `outline` | Full heading hierarchy (the TOC) with line numbers. |
| `heading` | Read ONE section by heading text / slug / line number. |
| `links` | Extract inline / image / wikilink / autolink / reference links. |
| `search` | Case-insensitive full-text search across docs (heading hits ranked first). |

`overview`/`find`/`map` also cover **Prisma schemas** (`schema.prisma` → models, enums, fields, relations). JSON config/i18n isn't structurally mapped — lens says so honestly and points you to grep.

Call a code tool on a `.md` (or a doc tool on a `.ts`) and it fails with a
helpful pointer to the right tool — no silent confusion.

## Honest by construction

- **Never silent data loss** — a file with syntax errors returns `hasErrors` +
  `parseErrors`, still extracting what it can; unparseable files in `map`/`find`
  appear with an inline `error`, never vanish.
- **Caps everywhere** — every list is bounded (see `info.limits`) and every cap
  is reported with the true total. A context-saving tool with unbounded output
  is self-refuting.
- **Path sandbox** — only files under the server's working directory are
  readable; escaping symlinks are rejected. `info` reports the root.
- **Errors name the fix** — `{error, path, hint}`, with `isError` set.

## Install

One line clones, installs, and writes a ready-to-paste MCP config with this
install's absolute path:

```bash
git clone https://github.com/segentic-lab/lens-mcp && cd lens-mcp && ./install.sh
```

No system packages and no native build — tree-sitter runs as WebAssembly, so it
works anywhere **Node 18+** runs (Linux, macOS, Windows via WSL/Git Bash). The
installer checks Node, runs `npm ci`, builds (`tsc → dist/`), self-tests the full
suite (143 tests), and generates `mcp-config.json`.

**Register it with your client** — the generated `mcp-config.json` looks like:

```json
{
  "mcpServers": {
    "lens": { "command": "node", "args": ["/abs/path/lens-mcp/dist/index.js"] }
  }
}
```

- **Claude Code:** `claude mcp add lens -- node /abs/path/lens-mcp/dist/index.js`
  (or copy `mcp-config.json` into a project as `.mcp.json`)
- **Cursor / Windsurf:** merge `mcp-config.json` into `~/.cursor/mcp.json`
- **Codex CLI:** add `[mcp_servers.lens]` with the same command/args to `~/.codex/config.toml`

lens reads files under its **working directory** — the project your client
launches it in. Point it at a project and call `map(".")`. Nothing outside the
working directory is readable.

**Update** later, in place:

```bash
./update.sh          # git pull --ff-only + reinstall + self-test
```

<sub>Prefer to do it by hand? `npm install && npm run build && npm test`, then
run `node dist/index.js`.</sub>

## Lineage

lens-mcp **supersedes** the earlier split servers `codelens-mcp` (code) and
`docslens-mcp` (docs) — same engines, one server, one pipeline. Sibling of
[periscope-mcp](https://github.com/segentic-lab/periscope-mcp) (web-app QA);
built to the same standard: honest errors, caps + truncated flags everywhere,
docs == behavior, tests before release.

Built by **[Segentic Lab](https://lab.segentic.dev)**. AGPL-3.0.
