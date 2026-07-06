import * as path from 'node:path';
import * as fs from 'node:fs';

// --- Limits (single source of truth; reported by server_info, enforced below) ---

export const LIMITS = {
  /** Default number of search matches returned when max_results is omitted. */
  searchMaxResultsDefault: 50,
  /** Hard ceiling for max_results. */
  searchMaxResultsMax: 200,
  /** Max characters per search snippet. */
  searchSnippetMaxChars: 200,
  /** Max docs returned by list_docs before truncation. */
  listDocsMaxDocs: 200,
  /** Max outlinePreview entries per doc in list_docs. */
  outlinePreviewMaxEntries: 8,
  /** Max characters in a doc summary. */
  summaryMaxChars: 200,
  /** Max headings returned by outline. */
  outlineMaxHeadings: 500,
  /** Max links returned by links. */
  linksMaxEntries: 200,
} as const;

/** File extensions treated as markdown docs. */
export const MD_EXTENSIONS = ['.md', '.markdown', '.mdx'] as const;

// --- Types ---

export interface DocSummary {
  path: string;
  title: string | null;
  summary: string | null;
  headingCount: number;
  outlinePreview: { depth: number; text: string }[];
  /** Present (true) only when outlinePreview was capped at LIMITS.outlinePreviewMaxEntries. */
  outlinePreviewTruncated?: boolean;
  bytes: number;
  mtime: string;
}

export interface ListDocsResult {
  dir: string;
  recursive: boolean;
  totalDocs: number;
  /** True when docs was capped at LIMITS.listDocsMaxDocs; totalDocs holds the real count. */
  truncated: boolean;
  docs: DocSummary[];
}

export interface HeadingEntry {
  depth: number;
  text: string;
  line: number;
}

export interface OutlineResult {
  path: string;
  totalHeadings: number;
  /** True when headings was capped at LIMITS.outlineMaxHeadings; totalHeadings holds the real count. */
  truncated: boolean;
  headings: HeadingEntry[];
  totalLines: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
  inHeading: boolean;
}

export interface SearchResult {
  query: string;
  dir: string;
  totalMatches: number;
  /** True when matches was capped at max_results; totalMatches holds the real count. */
  truncated: boolean;
  matches: SearchMatch[];
  /** Present only when there are zero matches; suggests how to proceed. */
  hint?: string;
}

export interface LinkEntry {
  type: 'markdown' | 'image' | 'wikilink' | 'autolink' | 'reference';
  text: string;
  target: string;
  line: number;
}

export interface LinksResult {
  path: string;
  totalLinks: number;
  /** True when links was capped at LIMITS.linksMaxEntries; totalLinks holds the real count. */
  truncated: boolean;
  links: LinkEntry[];
}

export interface HeadingResult {
  file: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  content: string;
  /** Present only when several headings matched ref; explains which one was returned. */
  note?: string;
}

export interface ServerInfoResult {
  name: string;
  version: string;
  workingDirectory: string;
  pathContract: string;
  extensions: string[];
  limits: typeof LIMITS;
}

export interface ErrorResult {
  error: string;
  path: string;
}

// --- Path validation (family contract, shared with code-lens) ---
// All paths must resolve inside the working directory (sandbox root). Errors
// name the root and the fix, because the agent on the other end cannot see cwd.
// The root itself is symlink-resolved so a cwd reached through a symlink
// (bind mounts, ~/dev -> /mnt/... checkouts) accepts its own files.

function inside(p: string, base: string): boolean {
  return p === base || p.startsWith(base + path.sep);
}

/** The sandbox root: cwd, symlink-resolved when it exists. */
export function resolveRoot(cwd: string = process.cwd()): string {
  const normalized = path.resolve(cwd);
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

export function validatePath(rawPath: string, cwd: string = process.cwd()): string {
  const normalizedCwd = path.resolve(cwd);
  const realRoot = resolveRoot(cwd);
  const resolved = path.resolve(cwd, rawPath);
  const contract = `working directory is ${realRoot}; pass a path under it (relative, or absolute within it). Call server_info to see this root and the server's limits`;
  if (!inside(resolved, normalizedCwd) && !inside(resolved, realRoot)) {
    throw new Error(`Path escapes working directory: ${rawPath} — ${contract}.`);
  }
  try {
    const real = fs.realpathSync(resolved);
    if (!inside(real, realRoot)) {
      throw new Error(`Path escapes working directory (symlink): ${rawPath} resolves to ${real} — ${contract}.`);
    }
    return real;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw e;
  }
}

// --- Ignore patterns ---

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'venv', '.venv',
  '__pycache__', 'build', '.next', 'coverage',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox',
  '.cache', '.turbo', '.svelte-kit', 'target', 'vendor',
  '.idea', '.vscode',
]);

// --- File walking ---

function isMdFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MD_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Symlinks are followed only while their target stays inside the sandbox
// root (same contract as validatePath); a visited-set breaks symlink cycles.
function walkMdFiles(dir: string, recursive: boolean, root: string): string[] {
  const results: string[] = [];
  const visited = new Set<string>();

  function walk(currentDir: string): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(currentDir);
    } catch {
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = fs.realpathSync(fullPath);
        } catch {
          continue; // broken link
        }
        if (!inside(real, root)) continue; // points outside the sandbox
        try {
          const st = fs.statSync(fullPath);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (recursive && !IGNORE_DIRS.has(entry.name)) {
          walk(fullPath);
        }
      } else if (isFile && isMdFile(entry.name)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results.sort();
}

// --- Markdown structure parsing ---
// One pass produces CRLF-normalized lines plus headings that are aware of
// YAML frontmatter, fenced code blocks (``` / ~~~), ATX (#) and setext
// (=== / ---) headings. Everything downstream shares this parse.

interface ParsedDoc {
  /** Lines with trailing \r stripped (CRLF-normalized). */
  lines: string[];
  /** Line count as an editor shows it (a trailing newline does not add a line; empty file = 0). */
  totalLines: number;
  headings: HeadingEntry[];
  /** 1-based line numbers that are headings (or setext underlines). */
  headingLines: Set<number>;
  /** 1-based line numbers occupied by YAML frontmatter (including delimiters). */
  frontmatterLines: Set<number>;
  /** 1-based line numbers inside fenced code blocks (including fences). */
  fencedLines: Set<number>;
}

const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
// Lines that end a paragraph, so the next ===/--- cannot be a setext underline.
const NON_PARAGRAPH_RE = /^(#{1,6}\s|>|\s*([-*+]\s|\d+[.)]\s)|\||\s*$)/;

export function parseDoc(content: string): ParsedDoc {
  const lines = content.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const totalLines = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const headings: HeadingEntry[] = [];
  const headingLines = new Set<number>();
  const frontmatterLines = new Set<number>();
  const fencedLines = new Set<number>();

  // YAML frontmatter: only when line 1 is exactly '---' and a closing '---'/'...' exists.
  let bodyStart = 0;
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '---' || t === '...') {
        bodyStart = i + 1;
        for (let j = 0; j <= i; j++) frontmatterLines.add(j + 1);
        break;
      }
    }
  }

  let fence: { char: string; len: number } | null = null;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { char: marker[0], len: marker.length };
        fencedLines.add(i + 1);
        continue;
      }
      if (marker[0] === fence.char && marker.length >= fence.len && line.trim() === marker) {
        fencedLines.add(i + 1);
        fence = null;
        continue;
      }
    }
    if (fence) {
      fencedLines.add(i + 1);
      continue;
    }

    const atx = ATX_HEADING_RE.exec(line);
    if (atx) {
      headings.push({ depth: atx[1].length, text: atx[2].trim(), line: i + 1 });
      headingLines.add(i + 1);
      continue;
    }

    // Setext: ===/--- underlining a plain paragraph line directly above.
    if (i > bodyStart && SETEXT_UNDERLINE_RE.test(line)) {
      const prev = lines[i - 1];
      const prevLineNo = i; // 1-based number of the line above
      if (
        !NON_PARAGRAPH_RE.test(prev) &&
        !headingLines.has(prevLineNo) &&
        !fencedLines.has(prevLineNo) &&
        !frontmatterLines.has(prevLineNo)
      ) {
        headings.push({
          depth: line.trim().startsWith('=') ? 1 : 2,
          text: prev.trim(),
          line: prevLineNo,
        });
        headingLines.add(prevLineNo);
        headingLines.add(i + 1); // the underline belongs to the heading
      }
    }
  }

  return { lines, totalLines, headings, headingLines, frontmatterLines, fencedLines };
}

// --- Markdown-only guard for single-file tools ---
// list_docs/search_docs filter by extension while walking; the single-file
// tools must enforce the same contract or a Dockerfile's # comments become H1s.

function notMarkdownError(rawPath: string): ErrorResult | null {
  if (isMdFile(path.basename(rawPath))) return null;
  return {
    error: `Not a markdown file: ${rawPath} — the doc tools (outline/heading/links/search) only read ${MD_EXTENSIONS.join('/')} files. For source code (.ts/.js/.py) use overview / functions / function_body / find instead.`,
    path: rawPath,
  };
}

// --- First paragraph extraction (skips frontmatter, headings, fenced code, HTML comments) ---

function extractFirstParagraph(doc: ParsedDoc): string | null {
  const paragraphLines: string[] = [];
  let foundStart = false;
  let inComment = false;

  for (let i = 0; i < doc.lines.length; i++) {
    const lineNo = i + 1;
    if (doc.frontmatterLines.has(lineNo) || doc.fencedLines.has(lineNo)) {
      if (foundStart) break;
      continue;
    }
    if (doc.headingLines.has(lineNo)) {
      if (foundStart) break;
      continue;
    }

    let text = doc.lines[i];
    let visible = '';
    while (text !== '') {
      if (inComment) {
        const end = text.indexOf('-->');
        if (end < 0) { text = ''; break; }
        text = text.slice(end + 3);
        inComment = false;
      } else {
        const start = text.indexOf('<!--');
        if (start < 0) { visible += text; break; }
        visible += text.slice(0, start);
        text = text.slice(start + 4);
        inComment = true;
      }
    }

    const trimmed = visible.trim();
    if (!foundStart && trimmed === '') continue;
    if (foundStart && trimmed === '') break;

    foundStart = true;
    paragraphLines.push(trimmed);
  }

  if (paragraphLines.length === 0) return null;

  const text = paragraphLines.join(' ');
  return text.length > LIMITS.summaryMaxChars
    ? text.slice(0, LIMITS.summaryMaxChars) + '…'
    : text;
}

// --- Tool: server_info ---

export function serverInfo(
  name: string,
  version: string,
  cwd: string = process.cwd(),
): ServerInfoResult {
  const root = resolveRoot(cwd);
  return {
    name,
    version,
    workingDirectory: root,
    pathContract:
      `All file/dir paths must resolve inside ${root} (relative to it, or absolute within it); ` +
      'paths outside it are rejected. Symlinks that point outside are rejected too.',
    extensions: [...MD_EXTENSIONS],
    limits: LIMITS,
  };
}

// --- Tool: list_docs ---

export async function listDocs(
  dir?: string,
  recursive: boolean = true,
  cwd: string = process.cwd(),
): Promise<ListDocsResult | ErrorResult> {
  try {
    const targetDir = dir ? validatePath(dir, cwd) : path.resolve(cwd);

    if (!fs.existsSync(targetDir)) {
      return {
        error: `Directory not found: ${dir ?? '.'} (working directory: ${path.resolve(cwd)}) — omit dir to scan the whole tree, or pass a directory that exists under the working directory.`,
        path: dir ?? '.',
      };
    }
    if (!fs.statSync(targetDir).isDirectory()) {
      return {
        error: `Not a directory: ${dir ?? '.'} — list_docs takes a directory; if you meant to inspect that file, call outline("${dir}") instead.`,
        path: dir ?? '.',
      };
    }

    const files = walkMdFiles(targetDir, recursive, resolveRoot(cwd));
    const totalDocs = files.length;
    const truncated = totalDocs > LIMITS.listDocsMaxDocs;
    const docs: DocSummary[] = [];

    for (const filePath of files.slice(0, LIMITS.listDocsMaxDocs)) {
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = parseDoc(content);
        const title = doc.headings.find(h => h.depth === 1)?.text ?? null;
        const summary = extractFirstParagraph(doc);
        const preview = doc.headings.filter(h => h.depth <= 2);
        const outlinePreview = preview
          .slice(0, LIMITS.outlinePreviewMaxEntries)
          .map(h => ({ depth: h.depth, text: h.text }));

        const entry: DocSummary = {
          path: path.relative(cwd, filePath),
          title,
          summary,
          headingCount: doc.headings.length,
          outlinePreview,
          bytes: stat.size,
          mtime: stat.mtime.toISOString(),
        };
        if (preview.length > LIMITS.outlinePreviewMaxEntries) {
          entry.outlinePreviewTruncated = true;
        }
        docs.push(entry);
      } catch {
        // skip unreadable files
      }
    }

    return { dir: dir ?? '.', recursive, totalDocs, truncated, docs };
  } catch (e: unknown) {
    return { error: (e as Error).message, path: dir ?? '.' };
  }
}

// --- Tool: outline ---

export async function outline(
  rawPath: string,
  cwd: string = process.cwd(),
): Promise<OutlineResult | ErrorResult> {
  try {
    const filePath = validatePath(rawPath, cwd);
    const notMd = notMarkdownError(rawPath);
    if (notMd) return notMd;
    if (!fs.existsSync(filePath)) {
      return {
        error: `File not found: ${rawPath} (working directory: ${path.resolve(cwd)}) — call list_docs() to see the markdown files that exist.`,
        path: rawPath,
      };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const doc = parseDoc(content);
    const totalHeadings = doc.headings.length;
    const truncated = totalHeadings > LIMITS.outlineMaxHeadings;

    return {
      path: rawPath,
      totalHeadings,
      truncated,
      headings: doc.headings.slice(0, LIMITS.outlineMaxHeadings),
      totalLines: doc.totalLines,
    };
  } catch (e: unknown) {
    return { error: (e as Error).message, path: rawPath };
  }
}

// --- Tool: search_docs ---

export async function searchDocs(
  query: string,
  dir?: string,
  recursive: boolean = true,
  maxResults: number = LIMITS.searchMaxResultsDefault,
  cwd: string = process.cwd(),
): Promise<SearchResult | ErrorResult> {
  try {
    if (query.trim() === '') {
      return {
        error: 'Query is empty — an empty query would match every line of every doc and flood your context. Pass a word or phrase, e.g. search_docs("install"); to browse docs instead, call list_docs().',
        path: dir ?? '.',
      };
    }
    const cap = Math.max(1, Math.min(Math.floor(maxResults), LIMITS.searchMaxResultsMax));

    const targetDir = dir ? validatePath(dir, cwd) : path.resolve(cwd);

    if (!fs.existsSync(targetDir)) {
      return {
        error: `Directory not found: ${dir ?? '.'} (working directory: ${path.resolve(cwd)}) — omit dir to search the whole tree, or pass a directory that exists under the working directory.`,
        path: dir ?? '.',
      };
    }

    const files = walkMdFiles(targetDir, recursive, resolveRoot(cwd));
    const matches: SearchMatch[] = [];
    const queryLower = query.toLowerCase();

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const doc = parseDoc(content);
        const relPath = path.relative(cwd, filePath);

        for (let i = 0; i < doc.lines.length; i++) {
          if (doc.lines[i].toLowerCase().includes(queryLower)) {
            matches.push({
              path: relPath,
              line: i + 1,
              snippet: doc.lines[i].trim().slice(0, LIMITS.searchSnippetMaxChars),
              inHeading: doc.headingLines.has(i + 1),
            });
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    // heading matches first, then by path + line
    matches.sort((a, b) => {
      if (a.inHeading !== b.inHeading) return a.inHeading ? -1 : 1;
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) return pathCmp;
      return a.line - b.line;
    });

    const totalMatches = matches.length;
    const truncated = totalMatches > cap;

    const result: SearchResult = {
      query,
      dir: dir ?? '.',
      totalMatches,
      truncated,
      matches: matches.slice(0, cap),
    };
    if (totalMatches === 0) {
      result.hint = 'No lines contain this substring — try a shorter or different term, drop the dir filter, or call list_docs() to browse titles and summaries.';
    }
    return result;
  } catch (e: unknown) {
    return { error: (e as Error).message, path: dir ?? '.' };
  }
}

// --- Slug helper ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- Tool: heading ---

export async function heading(
  rawPath: string,
  ref: string,
  cwd: string = process.cwd(),
): Promise<HeadingResult | ErrorResult> {
  try {
    const filePath = validatePath(rawPath, cwd);
    const notMd = notMarkdownError(rawPath);
    if (notMd) return notMd;
    if (!fs.existsSync(filePath)) {
      return {
        error: `File not found: ${rawPath} (working directory: ${path.resolve(cwd)}) — call list_docs() to see the markdown files that exist.`,
        path: rawPath,
      };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const doc = parseDoc(content);
    const { lines, headings } = doc;

    if (headings.length === 0) {
      const n = doc.totalLines;
      return {
        error: `No headings found in ${rawPath} — the file has no markdown headings, so there is no section to address. Read the whole file instead (it is ${n} line${n === 1 ? '' : 's'}).`,
        path: rawPath,
      };
    }

    let candidates: HeadingEntry[] = [];
    let lineResolutionNote: string | undefined;

    const refNum = /^\d+$/.test(ref) ? parseInt(ref, 10) : null;

    if (refNum === null) {
      const refSlug = slugify(ref);
      const refLower = ref.toLowerCase();
      candidates = headings.filter(
        h => slugify(h.text) === refSlug || h.text.toLowerCase() === refLower,
      );
    } else {
      candidates = headings.filter(h => h.line === refNum);
      if (candidates.length === 0) {
        // Not a heading line (e.g. a search_docs hit) — resolve to the
        // innermost section containing it.
        if (refNum < 1 || refNum > doc.totalLines) {
          return {
            error: `Line ${refNum} is out of range — ${rawPath} has ${doc.totalLines} lines. Call outline("${rawPath}") for its headings.`,
            path: rawPath,
          };
        }
        const enclosing = headings.filter(h => h.line < refNum).pop();
        if (!enclosing) {
          return {
            error: `Line ${refNum} precedes the first heading (line ${headings[0].line}) of ${rawPath} — there is no section containing it. Call outline("${rawPath}") for the ${headings.length} headings.`,
            path: rawPath,
          };
        }
        candidates = [enclosing];
        lineResolutionNote = `Line ${refNum} is not a heading; returned its enclosing section "${enclosing.text}" (line ${enclosing.line}).`;
      }
    }

    const target = candidates[0];
    if (!target) {
      return {
        error: `Heading not found: "${ref}" in ${rawPath} — call outline("${rawPath}") to list its ${headings.length} headings, then pass the exact text, its slug, or a line number.`,
        path: rawPath,
      };
    }

    const startLine = target.line;
    let endLine = doc.totalLines;

    const targetIdx = headings.indexOf(target);
    for (let i = targetIdx + 1; i < headings.length; i++) {
      if (headings[i].depth <= target.depth) {
        endLine = headings[i].line - 1;
        break;
      }
    }

    const sectionContent = lines.slice(startLine - 1, endLine).join('\n');

    const result: HeadingResult = {
      file: rawPath,
      heading: target.text,
      level: target.depth,
      startLine,
      endLine,
      content: sectionContent,
    };
    if (candidates.length > 1) {
      result.note = `${candidates.length} headings match "${ref}"; returned the first (line ${target.line}). Pass a line number from outline("${rawPath}") to select another.`;
    } else if (lineResolutionNote) {
      result.note = lineResolutionNote;
    }
    return result;
  } catch (e: unknown) {
    return { error: (e as Error).message, path: rawPath };
  }
}

// --- Link regexes ---

const IMG_LINK_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const AUTOLINK_RE = /<(https?:\/\/[^>]+)>/g;
const REF_LINK_RE = /\[([^\]]+)\]\[([^\]]*)\]/g;
const REF_DEF_RE = /^ {0,3}\[([^\]]+)\]:\s*(\S+)/;

// --- Tool: links ---

export async function links(
  rawPath: string,
  cwd: string = process.cwd(),
): Promise<LinksResult | ErrorResult> {
  try {
    const filePath = validatePath(rawPath, cwd);
    const notMd = notMarkdownError(rawPath);
    if (notMd) return notMd;
    if (!fs.existsSync(filePath)) {
      return {
        error: `File not found: ${rawPath} (working directory: ${path.resolve(cwd)}) — call list_docs() to see the markdown files that exist.`,
        path: rawPath,
      };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const doc = parseDoc(content);
    const result: LinkEntry[] = [];

    // First pass: reference definitions ([id]: url) so [text][id] resolves to the URL.
    const refDefs = new Map<string, string>();
    for (let i = 0; i < doc.lines.length; i++) {
      if (doc.fencedLines.has(i + 1)) continue;
      const def = REF_DEF_RE.exec(doc.lines[i]);
      if (def) refDefs.set(def[1].toLowerCase(), def[2]);
    }

    for (let i = 0; i < doc.lines.length; i++) {
      const lineNum = i + 1;
      // Code blocks contain example syntax, not real links.
      if (doc.fencedLines.has(lineNum)) continue;
      if (REF_DEF_RE.test(doc.lines[i])) continue; // definitions resolve refs; not links themselves
      let match;

      // Images first: record them, then remove so the outer link of a badge
      // construct [![alt](img)](url) is seen by MD_LINK_RE.
      const line = doc.lines[i].replace(IMG_LINK_RE, (_m, alt: string, src: string) => {
        result.push({ type: 'image', text: alt, target: src, line: lineNum });
        return alt;
      });

      MD_LINK_RE.lastIndex = 0;
      while ((match = MD_LINK_RE.exec(line)) !== null) {
        result.push({ type: 'markdown', text: match[1], target: match[2], line: lineNum });
      }

      WIKILINK_RE.lastIndex = 0;
      while ((match = WIKILINK_RE.exec(line)) !== null) {
        result.push({ type: 'wikilink', text: match[1], target: match[1], line: lineNum });
      }

      AUTOLINK_RE.lastIndex = 0;
      while ((match = AUTOLINK_RE.exec(line)) !== null) {
        result.push({ type: 'autolink', text: match[1], target: match[1], line: lineNum });
      }

      REF_LINK_RE.lastIndex = 0;
      while ((match = REF_LINK_RE.exec(line)) !== null) {
        const id = (match[2] || match[1]).toLowerCase();
        result.push({
          type: 'reference',
          text: match[1],
          target: refDefs.get(id) ?? (match[2] || match[1]),
          line: lineNum,
        });
      }
    }

    const totalLinks = result.length;
    const truncated = totalLinks > LIMITS.linksMaxEntries;

    return {
      path: rawPath,
      totalLinks,
      truncated,
      links: result.slice(0, LIMITS.linksMaxEntries),
    };
  } catch (e: unknown) {
    return { error: (e as Error).message, path: rawPath };
  }
}
