# Changelog

All notable changes to lens-mcp are documented here. Format: [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org).
Version lives once in `package.json` and is reported in the MCP handshake and by `info`.

## [0.1.0] - 2026-07-06

First release of **lens-mcp** — the merge of two servers into one.

Supersedes `codelens-mcp` 0.2.0 (code) and the unreleased `docslens-mcp` (docs):
same battle-tested engines, now a single MCP server with one release pipeline,
one Glama listing, and a unified surface.

### Added
- **Unified `map`** — one call returns the whole project's surface: per code
  file → structure (classes/functions), per markdown doc → title + outline.
  Replaces codelens `map` + docslens `list_docs`.
- **11 tools under one contract:** orientation (`map`, `info`); code
  (`overview`, `functions`, `function_body`, `comments`, `find`); docs
  (`outline`, `heading`, `links`, `search`).
- **Cross-type guidance** — a code tool called on a `.md` (or a doc tool on a
  `.ts`) fails with a hint naming the correct tool family, instead of a bare
  unsupported-extension error.

### Carried over (unchanged engines)
- Code lens: tree-sitter (TS/TSX/JS/JSX/Python), `hasErrors`/`parseErrors`
  honesty, nested-function scoping, batch paths, caps + truncated flags.
- Docs lens: ATX/setext heading parsing (skips fenced code & frontmatter),
  section reads, link extraction, capped full-text search (empty query
  rejected).
- Shared skeleton from codelens: `{error, path, hint}` + `isError` convention,
  path sandbox, the single-version-source + tag-synced registry publish.

### Notes
- `search` is the renamed `search_docs` (searches markdown text; for code
  symbols use `find`).
- Each engine keeps its own path guard and `LIMITS` for now (both hardened
  independently); a shared `paths`/`limits` module is a future refactor.

[0.1.0]: https://github.com/segentic-lab/lens-mcp/releases/tag/v0.1.0
