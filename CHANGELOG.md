# Changelog

All notable changes to lens-mcp are documented here. Format: [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org).
Version lives once in `package.json` and is reported in the MCP handshake and by `info`.

## [0.1.2] - 2026-07-06

Three feature requests from the dogfooding agent (issues #1–#3), against a real
TS / NestJS / Prisma monorepo — all shipped.

### Added
- **`references` tool (#1)** — the inverse of `find`: who *uses* a symbol —
  call sites, imports, type references — with the definition labelled.
  tree-sitter-backed, so a same-named string or comment is never a false
  positive (grep can't tell them apart). Returns `byKind` counts.
- **Prisma schema lens (#3)** — `overview`/`find`/`map` now cover
  `schema.prisma`: models, enums, composite types, fields, and relations
  (a field's type is classified scalar / relation / enum). `map` gains a
  `schemas` section. A large share of a TS backend's edits live here.

### Changed
- **`find` now locates non-callable symbols (#2)** — `const`/`let`/`var`
  bindings, `type` aliases, `interface`s, and `enum`s, not just
  functions/classes. A codebase's source-of-truth often lives in
  `export const …`; it's now findable. `kind` distinguishes them.
- JSON files get an honest "not structurally mapped — read it or grep for a
  key" note instead of a bare unsupported-extension error.

### Fixed
- Reference classification used `node === node` identity, which silently fails
  under web-tree-sitter (nodes are recreated per access) — now compares
  `node.id`. Found live-testing; every reference was mislabelled `reference`.

## [0.1.1] - 2026-07-06

### Added
- **`lens_system` — self-maintenance tool** (mirrors periscope's). `status`:
  running vs on-disk version, git commit, install type, Node version, and an
  update-availability check. `agents_md`: returns the current AGENTS.md so an
  agent can refresh a stale pasted copy of its operating guide. `update`:
  dry-run by default; `apply=true` runs `update.sh` (git pull + npm ci + build
  + self-test), reports `restartRequired` honestly (a Node stdio server can't
  hot-reload), stashes local edits on `force=true`, and refuses managed
  (no-.git) installs. Crucially operates on the lens INSTALL directory
  (resolved from the module URL), not the code tools' sandbox (`process.cwd()`
  = the user's project).
- **One-line `install.sh` + `update.sh`** — no system packages, no native build
  (tree-sitter is WebAssembly): checks Node 18+, `npm ci`, build, self-test, and
  writes a per-machine `mcp-config.json`. README gains the one-line
  clone+install and per-client registration.

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

[0.1.2]: https://github.com/segentic-lab/lens-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/segentic-lab/lens-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/segentic-lab/lens-mcp/releases/tag/v0.1.0
