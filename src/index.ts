#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as code from './code.js';
import * as docs from './docs.js';
import { lensSystem } from './system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single version source: package.json.
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
) as { name: string; version: string };

const SERVER_NAME = 'lens';

const server = new McpServer({ name: SERVER_NAME, version: pkg.version });

// The one shared framing rule (also in AGENTS.md). lens output is a navigation
// map over code AND docs: it tells you WHERE things are, never whether they are
// correct. A signature is not a body; an outline is not a section.
const LENS_CONTRACT =
  'lens is a navigation map over code and docs: use it to LOCATE things, then Read the actual source/section before judging or modifying it. A signature is not the body; an outline is not the section.';

// Merged caps + languages for the info tool.
const ALL_LIMITS = { ...code.LIMITS, ...docs.LIMITS };
const CODE_EXTS = code.SUPPORTED_EXTENSIONS;
const DOC_EXTS = [...docs.MD_EXTENSIONS];

const PATH_CONTRACT =
  `File path. Relative paths resolve against the server's working directory; absolute paths are allowed only inside it (outside is rejected — call info to see the root). Code: ${CODE_EXTS.join(' ')}; docs: ${DOC_EXTS.join(' ')}`;

// ---- shared response plumbing (from the codelens skeleton) ----
interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
function isErr(r: unknown): boolean {
  return typeof r === 'object' && r !== null && 'error' in (r as object);
}
function respond(payload: unknown, isError = false): ToolResponse {
  const res: ToolResponse = { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
  if (isError) res.isError = true;
  return res;
}

// Per-file code tools accept a single path OR a batch (up to the cap).
const codePathParam = z.union([
  z.string(),
  z.array(z.string()).min(1).max(code.LIMITS.maxBatchPaths),
]).describe(`${PATH_CONTRACT}. A single path, or an array of up to ${code.LIMITS.maxBatchPaths} paths (array returns {results, summary}).`);

type ToolFn = (p: string) => Promise<unknown>;
async function runOnPaths(pathOrPaths: string | string[], fn: ToolFn): Promise<ToolResponse> {
  if (typeof pathOrPaths === 'string') {
    const result = await fn(pathOrPaths);
    return respond(result, isErr(result));
  }
  const results = await Promise.all(pathOrPaths.map(p => fn(p)));
  const failed = results.filter(isErr).length;
  return respond(
    { results, summary: { requested: results.length, succeeded: results.length - failed, failed } },
    failed === results.length,
  );
}

// ============================ orientation ============================

server.tool(
  'map',
  'Whole-project surface in ONE call — the orientation tool over a mixed tree of code AND docs. ' +
  'Walks a directory recursively (skipping node_modules, .git, dist, build, venv, __pycache__, target, vendor, hidden dirs) and returns ' +
  'JSON {path, code:{files[{path, language, totalLines, classes[], functions[], hasErrors?, error?}], totalSupportedFiles, filesParsed, truncated}, docs:{docs[{path, title, headingCount, outlinePreview[], bytes}], totalDocs, truncated}, summary:{codeFiles, docFiles}}. ' +
  `Code files (${CODE_EXTS.join(' ')}) report structure; doc files (${DOC_EXTS.join(' ')}) report title + shallow outline. ` +
  `Caps: ${code.LIMITS.maxMapFiles} code files and ${docs.LIMITS.listDocsMaxDocs} docs per call (truncated flags carry the true totals — map a subtree to go deeper). ` +
  'Unparseable files appear with an inline error, never vanish. Use FIRST to decide which files matter, then the drill-down tools (overview/functions for code, outline/heading for docs). ' + LENS_CONTRACT,
  { path: z.string().describe(`Directory to map, relative to the working directory (or absolute inside it). Use "." for the whole workspace.`) },
  async ({ path: p }) => {
    const [codeMap, docList] = await Promise.all([code.mapDirectory(p), docs.listDocs(p, true)]);
    // A bad directory fails both engines -> surface it as a real error.
    if (isErr(codeMap) && isErr(docList)) {
      return respond(codeMap, true);
    }
    const codeOk = !isErr(codeMap) ? (codeMap as code.MapResult) : null;
    const docOk = !isErr(docList) ? (docList as docs.ListDocsResult) : null;
    return respond({
      path: p,
      code: codeOk ?? { error: (codeMap as code.ErrorResult).error },
      docs: docOk
        ? {
            docs: docOk.docs.map(d => ({
              path: d.path, title: d.title, headingCount: d.headingCount,
              outlinePreview: d.outlinePreview, bytes: d.bytes,
            })),
            totalDocs: docOk.totalDocs, truncated: docOk.truncated,
          }
        : { error: (docList as docs.ErrorResult).error },
      summary: { codeFiles: codeOk?.filesParsed ?? 0, docFiles: docOk?.docs.length ?? 0 },
    });
  },
);

server.tool(
  'info',
  'Server self-description: version, working directory (the path sandbox root — every path you pass must resolve inside it), supported code languages and doc extensions, the tool list, and every output cap. ' +
  'Returns JSON {name, version, workingDirectory, code:{languages}, docs:{extensions}, tools[], limits, contract}. Read-only, no parameters. ' +
  'Call this first if a path is rejected or to learn what the server can see.',
  {},
  async () => {
    const languages: Record<string, string[]> = {};
    for (const [ext, lang] of Object.entries(code.EXT_TO_LANG)) (languages[lang] ??= []).push(ext);
    return respond({
      name: 'lens-mcp',
      version: pkg.version,
      workingDirectory: process.cwd(),
      code: { languages },
      docs: { extensions: DOC_EXTS },
      tools: ['map', 'overview', 'functions', 'function_body', 'comments', 'find', 'outline', 'heading', 'links', 'search', 'info', 'lens_system'],
      limits: ALL_LIMITS,
      contract: LENS_CONTRACT,
    });
  },
);

// ============================ code drill-down ============================

server.tool(
  'overview',
  'Structural map of a source file: imports, exports, classes (with method names, incl. class-field arrow methods), and top-level functions — each with 1-based line/endLine to jump straight to a Read. ' +
  'Returns JSON {path, language, totalLines, hasErrors, imports[], exports[], classes[{name,line,endLine,methods[]}], functions[{name,line,endLine,exported}]}. ' +
  'hasErrors:true means syntax errors and items may be missing (parseErrors lists offending ranges). Nested functions are in the functions tool. ' +
  `Lists cap at ${code.LIMITS.maxListEntries} (truncated.<list> holds the true total). Languages: TS/TSX/JS/JSX/Python (Python exports from __all__). ` +
  'For markdown files use outline instead. Use FIRST to orient in an unfamiliar source file. ' + LENS_CONTRACT,
  { path: codePathParam },
  async ({ path: p }) => runOnPaths(p, f => code.overview(f)),
);

server.tool(
  'functions',
  'Every addressable function in a source file — nested functions, class methods, getters/setters, class-field arrows, namespace members, object-literal methods, default-export functions — with reconstructed signatures. ' +
  'NOT listed: anonymous callbacks, TS overload signatures (only implementations), Python lambdas. ' +
  'Returns JSON {path, language, hasErrors, functions[{name, signature, params[{name,type}], returnType, line, endLine, async, exported, kind, parent}]}. ' +
  "kind is function|method|arrow|getter|setter; parent is the enclosing scope, dotted for nesting ('Widget.render'), null at top level; default exports are named 'default'. " +
  `Caps at ${code.LIMITS.maxListEntries} (truncated.functions = true total). Use to pick a line range to Read or read one body with function_body. ` + LENS_CONTRACT,
  { path: codePathParam },
  async ({ path: p }) => runOnPaths(p, f => code.functions(f)),
);

server.tool(
  'function_body',
  "Verbatim source of ONE function — the focused read. Instead of Reading a whole file, get exactly that function's source (signature + decorators + body). " +
  'Returns JSON {path, name, parent, kind, signature, line, endLine, async, exported, hasErrors, body}. ' +
  "name matches the bare or dotted-qualified form from functions/find ('Widget.render'); if ambiguous the call FAILS listing candidates with lines — pass the qualified name or line, it never guesses. " +
  `body is real source, capped at ${code.LIMITS.maxBodyChars} chars (truncated.bodyChars = true length — Read line..endLine for the rest). ` +
  'The body IS the territory for this one function (reason about its internals) — but re-Read before editing. Languages: TS/TSX/JS/JSX/Python.',
  {
    path: z.string().describe(PATH_CONTRACT),
    name: z.string().describe("Function/method name, bare ('render') or dotted ('Widget.render') as reported by functions/find. Default exports are 'default'."),
    line: z.number().optional().describe('Disambiguator: the definition line (from functions/find) when a name has several definitions.'),
  },
  async ({ path: p, name, line }) => {
    const result = await code.functionBody(p, name, undefined, line);
    return respond(result, isErr(result));
  },
);

server.tool(
  'comments',
  'All comments in a source file with 1-based line ranges, kind (line | block | doc — doc covers /** */ and Python docstrings), and marker detection. ' +
  'Returns JSON {path, language, hasErrors, comments[{line, endLine, text, kind, marker}]}. ' +
  'marker is TODO|FIXME|FIX|BUG|HACK|NOTE|XXX when the comment contains that UPPERCASE word (case-sensitive, avoids prose false-positives), else null. ' +
  `markersOnly:true returns only marked comments (the debt list). Text clips at ${code.LIMITS.maxCommentChars} chars; list caps at ${code.LIMITS.maxListEntries}. ` +
  'Languages: TS/TSX/JS/JSX/Python. ' + LENS_CONTRACT,
  {
    path: codePathParam,
    markersOnly: z.boolean().optional().describe('Return only comments carrying a TODO/FIXME/FIX/BUG/HACK/NOTE/XXX marker (default false).'),
  },
  async ({ path: p, markersOnly }) => runOnPaths(p, f => code.comments(f, undefined, markersOnly ?? false)),
);

server.tool(
  'find',
  'Locate a function, method, or class DEFINITION by name across a directory — "where is X defined?" without grepping. (For text inside markdown docs use search.) ' +
  'Returns JSON {query, path, matches[{file, name, kind, line, signature, parent}], filesScanned, totalSupportedFiles, truncated, skipped?}. ' +
  'Matching is case-insensitive substring by default; exact:true for exact-name. Unsearchable files are listed in skipped with the reason. ' +
  `Caps: scans up to ${code.LIMITS.maxFindFiles} files, returns up to ${code.LIMITS.maxFindMatches} matches (truncated:true = more exist). Definitions only, not call sites. Languages: TS/TSX/JS/JSX/Python. ` + LENS_CONTRACT,
  {
    name: z.string().describe('Symbol name (function/method/class). Substring match unless exact:true.'),
    path: z.string().optional().describe('Directory (or single file) to search. Default "." (whole workspace).'),
    exact: z.boolean().optional().describe('Exact, case-sensitive match instead of case-insensitive substring (default false).'),
  },
  async ({ name, path: p, exact }) => {
    const result = await code.findSymbol(name, p ?? '.', undefined, exact ?? false);
    return respond(result, isErr(result));
  },
);

// ============================ docs drill-down ============================

server.tool(
  'outline',
  `Full heading hierarchy of one markdown file with 1-based line numbers — its table of contents. Recognizes ATX (#…) and setext (===/---) headings; skips headings inside fenced code blocks and YAML frontmatter; handles CRLF. Returns {path, totalHeadings, truncated, headings:[{depth, text, line}], totalLines}; capped at ${docs.LIMITS.outlineMaxHeadings}. For source code use overview instead. Pick a section here, then read only it with heading(). ` + LENS_CONTRACT,
  { path: z.string().describe(PATH_CONTRACT) },
  async ({ path: p }) => {
    const result = await docs.outline(p);
    return respond(result, isErr(result));
  },
);

server.tool(
  'heading',
  'Read ONE section of a markdown file instead of the whole file: the referenced heading plus everything under it (subsections included), stopping at the next heading of the same or higher level. ' +
  'ref accepts the exact heading text, its slug ("advanced-usage"), or ANY 1-based line number — a heading line from outline() or a content line from a search hit (resolves to its enclosing section, a note says so). ' +
  'Returns {file, heading, level, startLine, endLine, content}; on multiple matches a note says which was returned and how to pick another. The most token-frugal way to read docs — prefer it over reading whole files.',
  {
    file: z.string().describe(PATH_CONTRACT),
    ref: z.union([z.string(), z.number().int()]).describe('Heading text, slug, or line number identifying the section — from outline() or a search match.'),
  },
  async ({ file: p, ref }) => {
    const result = await docs.heading(p, String(ref));
    return respond(result, isErr(result));
  },
);

server.tool(
  'links',
  `Extract every link from one markdown file: inline [text](url), images ![alt](src) (badge constructs yield both image and outer link), [[wikilinks]], <autolinks>, and reference-style [text][id] resolved via their [id]: url definitions. Skips example links inside fenced code blocks. Returns {path, totalLinks, truncated, links:[{type: markdown|image|wikilink|autolink|reference, text, target, line}]} in document order, capped at ${docs.LIMITS.linksMaxEntries}. Map cross-references or collect URLs without reading the file.`,
  { path: z.string().describe(PATH_CONTRACT) },
  async ({ path: p }) => {
    const result = await docs.links(p);
    return respond(result, isErr(result));
  },
);

server.tool(
  'search',
  `Case-insensitive full-text substring search across MARKDOWN docs (for code symbol definitions use find). Returns matches {path, line, snippet (≤${docs.LIMITS.searchSnippetMaxChars} chars), inHeading}, heading matches ranked first, capped at max_results (default ${docs.LIMITS.searchMaxResultsDefault}, max ${docs.LIMITS.searchMaxResultsMax}) with totalMatches and truncated:true when capped. Empty/whitespace queries are rejected (they would match everything). Locate the right doc, then outline/heading to read it.`,
  {
    query: z.string().describe('Search term — case-insensitive substring, matched per line. Must be non-empty.'),
    dir: z.string().optional().describe('Directory to search, relative to the working directory (default: the working directory).'),
    recursive: z.boolean().optional().describe('Recurse into subdirectories (default: true).'),
    max_results: z.number().int().optional().describe(`Max matches (default ${docs.LIMITS.searchMaxResultsDefault}, clamped to 1–${docs.LIMITS.searchMaxResultsMax}).`),
  },
  async ({ query, dir, recursive, max_results }) => {
    const result = await docs.searchDocs(query, dir, recursive ?? true, max_results ?? docs.LIMITS.searchMaxResultsDefault);
    return respond(result, isErr(result));
  },
);

// ============================ self-maintenance ============================

server.tool(
  'lens_system',
  'Install status, self-update, and the current agent guide — lens\'s self-maintenance tool. ' +
  "action='status' (read-only): running vs on-disk version, git commit, install type, install directory, Node version, and whether an update is available. " +
  "action='agents_md' (read-only): returns the CURRENT AGENTS.md so you can refresh a stale pasted copy of your operating guide. " +
  "action='update': dry-run by default (commits behind + incoming changes); apply=true runs update.sh (git pull + npm ci + build + self-test) — new code loads only after the MCP server restarts, and the response says so. force=true stashes local edits. Managed installs (no .git) refuse with guidance. " +
  'Note: this operates on the lens INSTALL directory, not your project (the code tools\' sandbox). Returns JSON.',
  {
    action: z.enum(['status', 'update', 'agents_md']).optional().describe("status = version/commit/update-check (default); update = check or apply an update; agents_md = fetch the current agent guide"),
    apply: z.boolean().optional().describe("For action='update': actually run the update instead of the dry-run check (default false)."),
    force: z.boolean().optional().describe("For action='update' with apply=true: auto-stash local modifications first (recoverable via `git stash pop`)."),
  },
  async ({ action, apply, force }) => {
    const result = await lensSystem({ action, apply, force });
    return respond(result, isErr(result));
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
