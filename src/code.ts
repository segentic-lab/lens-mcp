import Parser from 'web-tree-sitter';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Limits (every list in every response is capped; truncation is always flagged) ---

export const LIMITS = {
  maxFileBytes: 2_000_000,
  maxBatchPaths: 20,
  maxListEntries: 500,
  maxCommentChars: 600,
  maxMapFiles: 200,
  maxMapNamesPerFile: 100,
  maxFindFiles: 300,
  maxFindMatches: 100,
  maxFindSkipped: 20,
  maxParseErrors: 20,
  maxMethodsPerClass: 100,
  maxParams: 30,
  maxBodyChars: 20_000,
  maxRefFiles: 400,
  maxRefMatches: 300,
  maxRefContextChars: 200,
} as const;

// --- Types ---

export interface ParseErrorRange {
  line: number;
  endLine: number;
}

export interface OverviewResult {
  path: string;
  language: string;
  totalLines: number;
  hasErrors: boolean;
  parseErrors?: ParseErrorRange[];
  imports: string[];
  exports: string[];
  classes: ClassEntry[];
  functions: OverviewFunction[];
  truncated?: Record<string, number>;
}

export interface ClassEntry {
  name: string;
  line: number;
  endLine: number;
  methods: string[];
  truncated?: Record<string, number>;
}

export interface OverviewFunction {
  name: string;
  line: number;
  endLine: number;
  exported: boolean;
}

export interface CommentEntry {
  line: number;
  endLine: number;
  text: string;
  textTruncated?: boolean;
  kind: 'line' | 'block' | 'doc';
  marker: string | null;
}

export interface CommentsResult {
  path: string;
  language: string;
  hasErrors: boolean;
  comments: CommentEntry[];
  truncated?: Record<string, number>;
}

export interface ParamInfo {
  name: string;
  type: string | null;
}

export type FunctionKind = 'function' | 'method' | 'arrow' | 'getter' | 'setter';

export interface FunctionEntry {
  name: string;
  signature: string;
  params: ParamInfo[];
  returnType: string | null;
  line: number;
  endLine: number;
  async: boolean;
  exported: boolean;
  kind: FunctionKind;
  parent: string | null;
  truncated?: Record<string, number>;
}

export interface FunctionsResult {
  path: string;
  language: string;
  hasErrors: boolean;
  parseErrors?: ParseErrorRange[];
  functions: FunctionEntry[];
  truncated?: Record<string, number>;
}

export interface MapFileEntry {
  path: string;
  language: string;
  totalLines: number;
  hasErrors?: boolean;
  classes: string[];
  functions: string[];
  truncated?: Record<string, number>;
  error?: string;
}

export interface MapResult {
  path: string;
  files: MapFileEntry[];
  totalSupportedFiles: number;
  filesParsed: number;
  truncated: boolean;
}

export type SymbolKind =
  | FunctionKind | 'class'
  | 'const' | 'let' | 'var' | 'type' | 'interface' | 'enum' | 'variable';

export interface FindMatch {
  file: string;
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string | null;
  parent: string | null;
}

export interface BindingEntry {
  name: string;
  kind: 'const' | 'let' | 'var' | 'type' | 'interface' | 'enum' | 'variable';
  line: number;
  exported: boolean;
}

export type ReferenceKind = 'call' | 'instantiation' | 'import' | 'type-ref' | 'reference' | 'definition';

export interface ReferenceEntry {
  file: string;
  line: number;
  kind: ReferenceKind;
  context: string;
}

export interface ReferencesResult {
  symbol: string;
  path: string;
  references: ReferenceEntry[];
  filesScanned: number;
  totalSupportedFiles: number;
  truncated: boolean;
  byKind: Record<string, number>;
  skipped?: Array<{ file: string; error: string }>;
  skippedTotal?: number;
}

export interface FindResult {
  query: string;
  path: string;
  matches: FindMatch[];
  filesScanned: number;
  totalSupportedFiles: number;
  truncated: boolean;
  skipped?: Array<{ file: string; error: string }>;
  skippedTotal?: number;
}

export interface FunctionBodyResult {
  path: string;
  name: string;
  parent: string | null;
  kind: FunctionKind;
  signature: string;
  line: number;
  endLine: number;
  async: boolean;
  exported: boolean;
  hasErrors: boolean;
  body: string;
  truncated?: Record<string, number>;
}

export interface ErrorResult {
  error: string;
  path: string;
  hint?: string;
}

export function isErrorResult(r: unknown): r is ErrorResult {
  return typeof r === 'object' && r !== null && 'error' in r;
}

// --- Extension mapping ---

// Reported language per extension.
export const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
};

// Grammar used per extension. `.tsx` needs the dedicated tsx grammar —
// the plain typescript grammar cannot parse JSX and silently drops it.
const EXT_TO_GRAMMAR: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_TO_LANG);

// --- Init ---

let parser: Parser;
const grammars = new Map<string, Parser.Language>();
let initPromise: Promise<void> | null = null;

function findInNodeModules(packageName: string, fileName: string): string {
  let dir = __dirname;
  for (let i = 0; i < 15; i++) {
    const candidate = path.join(dir, 'node_modules', packageName, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find ${packageName}/${fileName} in node_modules`);
}

async function init(): Promise<void> {
  await Parser.init({
    locateFile(scriptName: string) {
      return findInNodeModules('web-tree-sitter', scriptName);
    },
  });

  parser = new Parser();

  const grammarSpecs: Array<[string, string, string]> = [
    ['typescript', 'tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
    ['tsx', 'tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
    ['javascript', 'tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
    ['python', 'tree-sitter-python', 'tree-sitter-python.wasm'],
  ];

  for (const [name, pkg, file] of grammarSpecs) {
    const wasmPath = findInNodeModules(pkg, file);
    const lang = await Parser.Language.load(wasmPath);
    grammars.set(name, lang);
  }
}

export async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

// --- Path validation ---

export function validatePath(rawPath: string, cwd: string = process.cwd()): string {
  const normalizedCwd = path.resolve(cwd);
  const resolved = path.resolve(normalizedCwd, rawPath);
  const escapeError = (kind: string) =>
    new Error(
      `Path escapes the server's working directory${kind}: ${rawPath}. ` +
      `This server can only read files under ${normalizedCwd} — pass a path inside it, ` +
      `or ask the user to launch the server from a directory that contains the file.`,
    );
  if (!resolved.startsWith(normalizedCwd + path.sep) && resolved !== normalizedCwd) {
    throw escapeError('');
  }
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(normalizedCwd + path.sep) && real !== normalizedCwd) {
      throw escapeError(' (symlink)');
    }
    return real;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw e;
  }
}

// --- Core parse ---

interface Parsed {
  tree: Parser.Tree;
  source: string;
  language: string;
}

/**
 * Validate, read, and parse one file. Throws Error (with .hint set where useful)
 * on any failure — callers convert to the error convention.
 */
function checkReadable(filePath: string, rawPath: string): void {
  if (!fs.existsSync(filePath)) {
    throw withHint(new Error(`File not found: ${rawPath}`),
      'Check the path against the map/overview tools, or the server working directory in info.');
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    throw withHint(new Error(`Path is a directory, not a file: ${rawPath}`),
      'Use the map tool for a per-file structural overview of a directory.');
  }
  if (stat.size > LIMITS.maxFileBytes) {
    throw withHint(new Error(
      `File too large: ${rawPath} is ${stat.size} bytes (limit ${LIMITS.maxFileBytes}).`),
      'codelens caps file size to keep responses bounded; Read the file in ranges instead.');
  }
}

function withHint(e: Error, hint: string): Error {
  (e as Error & { hint?: string }).hint = hint;
  return e;
}

async function parseFile(filePath: string, rawPath: string): Promise<Parsed> {
  await ensureInit();

  checkReadable(filePath, rawPath); // existence/directory/size first — clearer errors
  const ext = path.extname(filePath).toLowerCase();
  const language = EXT_TO_LANG[ext];
  if (!language) {
    throw withHint(new Error(`Unsupported file extension: ${ext || '(none)'} (${rawPath})`),
      `Supported code: ${SUPPORTED_EXTENSIONS.join(', ')}. For markdown docs (.md/.markdown/.mdx) use outline / heading / links / search instead.`);
  }

  const grammar = grammars.get(EXT_TO_GRAMMAR[ext]!);
  if (!grammar) throw new Error(`Grammar not loaded: ${EXT_TO_GRAMMAR[ext]}`);

  parser.setLanguage(grammar);
  const source = fs.readFileSync(filePath, 'utf-8');
  const tree = parser.parse(source);
  return { tree, source, language };
}

function countLines(source: string): number {
  if (source === '') return 0;
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

function collectParseErrors(root: Parser.SyntaxNode): { ranges: ParseErrorRange[]; total: number } {
  if (!root.hasError) return { ranges: [], total: 0 };
  const ranges: ParseErrorRange[] = [];
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'ERROR' || node.isMissing) {
      total++;
      if (ranges.length < LIMITS.maxParseErrors) {
        ranges.push({ line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
      }
      continue; // don't descend into an ERROR subtree
    }
    if (node.hasError) {
      for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i)!);
    }
  }
  ranges.sort((a, b) => a.line - b.line);
  return { ranges, total };
}

/** Cap a list in place; returns the true total if capped, else null. */
function cap<T>(list: T[], max: number = LIMITS.maxListEntries): number | null {
  if (list.length <= max) return null;
  const total = list.length;
  list.length = max;
  return total;
}

function toError(e: unknown, rawPath: string): ErrorResult {
  const err = e as Error & { hint?: string };
  const result: ErrorResult = { error: err.message, path: rawPath };
  if (err.hint) result.hint = err.hint;
  return result;
}

// --- Marker parsing ---
// Case-sensitive on purpose: matching `note`/`fix` in prose produced false
// positives; the uppercase convention is the deterministic signal.

const MARKERS = ['TODO', 'FIXME', 'FIX', 'BUG', 'HACK', 'NOTE', 'XXX'] as const;
const MARKER_RE = new RegExp(`\\b(${MARKERS.join('|')})\\b`);

function parseMarker(text: string): string | null {
  const m = MARKER_RE.exec(text);
  return m ? m[1] : null;
}

// --- Tool: overview ---

export async function overview(rawPath: string, cwd?: string): Promise<OverviewResult | ErrorResult> {
  try {
    const filePath = validatePath(rawPath, cwd);
    const { tree, source, language } = await parseFile(filePath, rawPath);
    const root = tree.rootNode;

    const imports: string[] = [];
    const exports: string[] = [];
    const classes: ClassEntry[] = [];
    const functions: OverviewFunction[] = [];

    if (language === 'typescript' || language === 'javascript') {
      extractTSOverview(root, imports, exports, classes, functions);
    } else if (language === 'python') {
      extractPyOverview(root, imports, exports, classes, functions);
    }

    const result: OverviewResult = {
      path: rawPath,
      language,
      totalLines: countLines(source),
      hasErrors: root.hasError,
      imports, exports, classes, functions,
    };
    const truncated: Record<string, number> = {};
    if (root.hasError) {
      const pe = collectParseErrors(root);
      result.parseErrors = pe.ranges;
      if (pe.total > pe.ranges.length) truncated.parseErrors = pe.total;
    }
    for (const [key, list] of Object.entries({ imports, exports, classes, functions })) {
      const total = cap(list as unknown[]);
      if (total !== null) truncated[key] = total;
    }
    if (Object.keys(truncated).length > 0) result.truncated = truncated;
    return result;
  } catch (e: unknown) {
    return toError(e, rawPath);
  }
}

// --- TS/JS overview extraction (top-level structure) ---

function extractTSOverview(
  root: Parser.SyntaxNode,
  imports: string[],
  exports: string[],
  classes: ClassEntry[],
  functions: OverviewFunction[],
): void {
  const reExportedNames = collectTSExportedNames(root);

  for (const child of root.children) {
    if (child.type === 'import_statement') {
      imports.push(child.text.replace(/;$/, '').trim());
      continue;
    }
    if (child.type === 'export_statement') {
      handleTSExportStatement(child, exports, classes, functions, reExportedNames);
      continue;
    }
    if (child.type === 'function_declaration' || child.type === 'generator_function_declaration') {
      const name = child.childForFieldName('name')?.text ?? 'anonymous';
      functions.push({
        name,
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        exported: reExportedNames.has(name),
      });
      continue;
    }
    if (child.type === 'class_declaration') {
      pushClass(child, classes);
      continue;
    }
    if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
      pushArrowsFromDecl(child, functions, reExportedNames, false);
    }
  }
}

function handleTSExportStatement(
  node: Parser.SyntaxNode,
  exports: string[],
  classes: ClassEntry[],
  functions: OverviewFunction[],
  reExportedNames: Set<string>,
): void {
  for (const inner of node.children) {
    if (inner.type === 'function_declaration' || inner.type === 'generator_function_declaration') {
      const name = inner.childForFieldName('name')?.text ?? 'anonymous';
      if (!exports.includes(name)) exports.push(name);
      functions.push({ name, line: inner.startPosition.row + 1, endLine: inner.endPosition.row + 1, exported: true });
    } else if (inner.type === 'class_declaration') {
      const name = inner.childForFieldName('name')?.text ?? 'anonymous';
      if (!exports.includes(name)) exports.push(name);
      pushClass(inner, classes);
    } else if (inner.type === 'lexical_declaration' || inner.type === 'variable_declaration') {
      pushArrowsFromDecl(inner, functions, reExportedNames, true);
      for (const vd of inner.children) {
        if (vd.type === 'variable_declarator') {
          const name = vd.childForFieldName('name')?.text;
          if (name && !exports.includes(name)) exports.push(name);
        }
      }
    } else if (inner.type === 'interface_declaration' || inner.type === 'type_alias_declaration' || inner.type === 'enum_declaration') {
      const name = inner.childForFieldName('name')?.text;
      if (name && !exports.includes(name)) exports.push(name);
    }
  }

  // export { a, b as c }
  const clause = node.children.find(c => c.type === 'export_clause');
  if (clause) {
    for (const spec of clause.children) {
      if (spec.type === 'export_specifier') {
        const name = spec.childForFieldName('name')?.text ?? spec.children[0]?.text;
        if (name && !exports.includes(name)) exports.push(name);
      }
    }
  }

  // export default <expr> (not wrapping a named declaration)
  const hasDefault = node.children.some(c => c.type === 'default' || c.text === 'default');
  const hasNamedDecl = node.children.some(c =>
    ['function_declaration', 'generator_function_declaration', 'class_declaration', 'lexical_declaration', 'variable_declaration'].includes(c.type),
  );
  if (hasDefault && !hasNamedDecl && !exports.includes('default')) {
    exports.push('default');
  }

  // export default () => {} / function () {} — a real function, list it
  const value = node.childForFieldName('value');
  if (value && isFunctionValue(value)) {
    functions.push({
      name: 'default',
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: true,
    });
  }
}

/** Method-like members of a class body: method_definition + class-field arrows + getters/setters. */
function classMethodNames(body: Parser.SyntaxNode): string[] {
  const methods: string[] = [];
  for (const member of body.children) {
    if (member.type === 'method_definition') {
      const mName = member.childForFieldName('name')?.text;
      if (mName) methods.push(mName);
    } else if (member.type === 'public_field_definition' || member.type === 'field_definition') {
      const value = member.childForFieldName('value');
      if (value && isFunctionValue(value)) {
        const mName = member.childForFieldName('name')?.text ?? member.childForFieldName('property')?.text;
        if (mName) methods.push(mName);
      }
    }
  }
  return methods;
}

function isFunctionValue(node: Parser.SyntaxNode): boolean {
  return node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'function' || node.type === 'generator_function';
}

function pushClass(node: Parser.SyntaxNode, classes: ClassEntry[]): void {
  const name = node.childForFieldName('name')?.text ?? 'anonymous';
  const body = node.childForFieldName('body');
  const methods = body ? classMethodNames(body) : [];
  const entry: ClassEntry = {
    name,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    methods,
  };
  const total = cap(methods, LIMITS.maxMethodsPerClass);
  if (total !== null) entry.truncated = { methods: total };
  classes.push(entry);
}

function pushArrowsFromDecl(
  declNode: Parser.SyntaxNode,
  functions: OverviewFunction[],
  reExportedNames: Set<string>,
  isExported: boolean,
): void {
  for (const vd of declNode.children) {
    if (vd.type === 'variable_declarator') {
      const name = vd.childForFieldName('name')?.text;
      const value = vd.childForFieldName('value');
      if (name && value && isFunctionValue(value)) {
        functions.push({
          name,
          line: declNode.startPosition.row + 1,
          endLine: declNode.endPosition.row + 1,
          exported: isExported || reExportedNames.has(name),
        });
      }
    }
  }
}

// --- Python overview extraction ---

function extractPyOverview(
  root: Parser.SyntaxNode,
  imports: string[],
  exports: string[],
  classes: ClassEntry[],
  functions: OverviewFunction[],
): void {
  for (const child of root.children) {
    if (child.type === 'import_statement' || child.type === 'import_from_statement') {
      imports.push(child.text);
      continue;
    }

    // __all__ = ["a", "b"] -> exports
    if (child.type === 'expression_statement') {
      const assign = child.children[0];
      if (assign?.type === 'assignment' && assign.childForFieldName('left')?.text === '__all__') {
        const right = assign.childForFieldName('right');
        if (right && (right.type === 'list' || right.type === 'tuple')) {
          for (const el of right.children) {
            if (el.type === 'string') {
              const name = el.text.replace(/^['"]|['"]$/g, '');
              if (name && !exports.includes(name)) exports.push(name);
            }
          }
        }
      }
      continue;
    }

    const actual = child.type === 'decorated_definition'
      ? (child.children.find(c => c.type === 'function_definition' || c.type === 'class_definition') ?? child)
      : child;

    if (actual.type === 'function_definition') {
      const name = actual.childForFieldName('name')?.text ?? 'anonymous';
      functions.push({ name, line: child.startPosition.row + 1, endLine: child.endPosition.row + 1, exported: false });
    } else if (actual.type === 'class_definition') {
      pushPyClass(actual, classes, child);
    }
  }
}

function pushPyClass(
  node: Parser.SyntaxNode,
  classes: ClassEntry[],
  wrapper?: Parser.SyntaxNode,
): void {
  const ref = wrapper ?? node;
  const name = node.childForFieldName('name')?.text ?? 'anonymous';
  const body = node.childForFieldName('body');
  const methods: string[] = [];
  if (body) {
    for (const member of body.children) {
      const funcDef = member.type === 'decorated_definition'
        ? member.children.find(c => c.type === 'function_definition')
        : (member.type === 'function_definition' ? member : null);
      if (funcDef) {
        const mName = funcDef.childForFieldName('name')?.text;
        if (mName) methods.push(mName);
      }
      // nested classes are surfaced as their own overview entries; keep the
      // decorated_definition wrapper so decorator lines stay in the range
      const nested = member.type === 'decorated_definition'
        ? member.children.find(c => c.type === 'class_definition')
        : (member.type === 'class_definition' ? member : null);
      if (nested) pushPyClass(nested, classes, member.type === 'decorated_definition' ? member : undefined);
    }
  }
  const entry: ClassEntry = { name, line: ref.startPosition.row + 1, endLine: ref.endPosition.row + 1, methods };
  const total = cap(methods, LIMITS.maxMethodsPerClass);
  if (total !== null) entry.truncated = { methods: total };
  classes.push(entry);
}

// --- Tool: comments ---

export async function comments(
  rawPath: string,
  cwd?: string,
  markersOnly = false,
): Promise<CommentsResult | ErrorResult> {
  try {
    const filePath = validatePath(rawPath, cwd);
    const { tree, language } = await parseFile(filePath, rawPath);
    let entries: CommentEntry[] = [];
    walkComments(tree.rootNode, language, entries);
    if (markersOnly) entries = entries.filter(c => c.marker !== null);

    const result: CommentsResult = {
      path: rawPath,
      language,
      hasErrors: tree.rootNode.hasError,
      comments: entries,
    };
    const total = cap(entries);
    if (total !== null) result.truncated = { comments: total };
    return result;
  } catch (e: unknown) {
    return toError(e, rawPath);
  }
}

function clipText(text: string): { text: string; clipped: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= LIMITS.maxCommentChars) return { text: trimmed, clipped: false };
  return { text: trimmed.slice(0, LIMITS.maxCommentChars) + '…', clipped: true };
}

function walkComments(node: Parser.SyntaxNode, language: string, out: CommentEntry[]): void {
  if (node.type === 'comment') {
    const raw = node.text;
    let kind: CommentEntry['kind'];
    if (language === 'python') {
      kind = 'line';
    } else if (raw.startsWith('/**')) {
      kind = 'doc';
    } else if (raw.startsWith('/*')) {
      kind = 'block';
    } else {
      kind = 'line';
    }
    const { text, clipped } = clipText(raw);
    const entry: CommentEntry = {
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      text,
      kind,
      marker: parseMarker(raw),
    };
    if (clipped) entry.textTruncated = true;
    out.push(entry);
  }

  // Python docstrings: a string expression that is the FIRST statement of a
  // module, class body, or function body. Strings elsewhere are just values.
  if (language === 'python' && node.type === 'expression_statement') {
    const child = node.children[0];
    if (child?.type === 'string' && isPyDocstringPosition(node)) {
      const raw = child.text;
      if (raw.startsWith('"""') || raw.startsWith("'''")) {
        const { text, clipped } = clipText(raw);
        const entry: CommentEntry = {
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          text,
          kind: 'doc',
          marker: parseMarker(raw),
        };
        if (clipped) entry.textTruncated = true;
        out.push(entry);
      }
    }
  }

  for (const child of node.children) {
    walkComments(child, language, out);
  }
}

function isPyDocstringPosition(exprStmt: Parser.SyntaxNode): boolean {
  const parent = exprStmt.parent;
  if (!parent) return false;
  // node objects are recreated on each access — compare by id, not reference
  const firstStmt = (n: Parser.SyntaxNode) => n.namedChildren.find(c => c.type !== 'comment')?.id;
  if (parent.type === 'module') {
    return firstStmt(parent) === exprStmt.id;
  }
  if (parent.type === 'block') {
    const grand = parent.parent;
    if (!grand || (grand.type !== 'function_definition' && grand.type !== 'class_definition')) return false;
    return firstStmt(parent) === exprStmt.id;
  }
  return false;
}

// --- Tool: functions ---

export async function functions(rawPath: string, cwd?: string): Promise<FunctionsResult | ErrorResult> {
  try {
    const filePath = validatePath(rawPath, cwd);
    const { tree, source, language } = await parseFile(filePath, rawPath);
    const root = tree.rootNode;
    const entries: FunctionEntry[] = [];

    if (language === 'typescript' || language === 'javascript') {
      collectTSFunctions(root, entries, collectTSExportedNames(root));
    } else if (language === 'python') {
      collectPyFunctions(root, entries, source, null, null);
    }

    const result: FunctionsResult = {
      path: rawPath,
      language,
      hasErrors: root.hasError,
      functions: entries,
    };
    const truncated: Record<string, number> = {};
    if (root.hasError) {
      const pe = collectParseErrors(root);
      result.parseErrors = pe.ranges;
      if (pe.total > pe.ranges.length) truncated.parseErrors = pe.total;
    }
    const total = cap(entries);
    if (total !== null) truncated.functions = total;
    if (Object.keys(truncated).length > 0) result.truncated = truncated;
    return result;
  } catch (e: unknown) {
    return toError(e, rawPath);
  }
}

function collectTSExportedNames(root: Parser.SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (const child of root.children) {
    if (child.type !== 'export_statement') continue;
    const clause = child.children.find(c => c.type === 'export_clause');
    if (clause) {
      for (const spec of clause.children) {
        if (spec.type === 'export_specifier') {
          const name = spec.childForFieldName('name')?.text ?? spec.children[0]?.text;
          if (name) names.add(name);
        }
      }
    }
    for (const inner of child.children) {
      if (inner.type === 'function_declaration' || inner.type === 'generator_function_declaration' || inner.type === 'class_declaration') {
        const name = inner.childForFieldName('name')?.text;
        if (name) names.add(name);
      } else if (inner.type === 'lexical_declaration' || inner.type === 'variable_declaration') {
        for (const vd of inner.children) {
          if (vd.type === 'variable_declarator') {
            const name = vd.childForFieldName('name')?.text;
            if (name) names.add(name);
          }
        }
      }
    }
  }
  return names;
}

interface SourceSpan {
  start: number;
  end: number;
}

/**
 * Recursive TS/JS function collector. Walks the WHOLE tree (nested functions,
 * namespaces, object-literal methods, class-field arrows), tracking the
 * enclosing scope in `parent` (dotted for nesting: "Widget.render").
 * When `spans` is given, it receives the source span of each entry (aligned
 * by index) — used by function_body to extract verbatim source.
 */
function collectTSFunctions(
  root: Parser.SyntaxNode,
  out: FunctionEntry[],
  exportedNames: Set<string>,
  spans?: SourceSpan[],
): void {
  const emit = (entry: FunctionEntry, node: Parser.SyntaxNode): void => {
    out.push(entry);
    spans?.push({ start: node.startIndex, end: node.endIndex });
  };
  const walk = (node: Parser.SyntaxNode, parent: string | null, exportedHere: boolean): void => {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text ?? 'anonymous';
        emit(tsEntry(node, name, 'function', parent,
          exportedHere || (parent === null && exportedNames.has(name))), node);
        walkBody(node, qual(parent, name));
        return;
      }
      case 'method_definition': {
        const name = node.childForFieldName('name')?.text ?? 'anonymous';
        const kind: FunctionKind = node.children.some(c => c.type === 'get') ? 'getter'
          : node.children.some(c => c.type === 'set') ? 'setter'
          : 'method';
        emit(tsEntry(node, name, kind, parent, false), node);
        walkBody(node, qual(parent, name));
        return;
      }
      case 'public_field_definition':
      case 'field_definition': {
        const value = node.childForFieldName('value');
        if (value && isFunctionValue(value)) {
          const name = node.childForFieldName('name')?.text ?? node.childForFieldName('property')?.text ?? 'anonymous';
          emit(tsFieldEntry(node, value, name, parent), node);
          walkBody(value, qual(parent, name));
        } else if (value) {
          walk(value, parent, false);
        }
        return;
      }
      case 'variable_declarator': {
        const name = node.childForFieldName('name')?.text;
        const value = node.childForFieldName('value');
        if (name && value && isFunctionValue(value)) {
          emit(tsValueEntry(node, value, name, parent,
            exportedHere || (parent === null && exportedNames.has(name))), node);
          walkBody(value, qual(parent, name));
        } else if (value) {
          // e.g. const api = { handler(a) {...} } — methods get parent "api"
          walk(value, name ? qual(parent, name) : parent, false);
        }
        return;
      }
      case 'class_declaration':
      case 'class': {
        // named class -> methods get "Class" as parent; class expressions
        // (const Foo = class {...}) inherit the variable's qualified name
        const nameNode = node.childForFieldName('name');
        const classParent = nameNode ? qual(parent, nameNode.text) : parent;
        const body = node.childForFieldName('body');
        if (body) for (const member of body.children) walk(member, classParent, false);
        return;
      }
      case 'internal_module': { // namespace NS { ... }
        const name = node.childForFieldName('name')?.text ?? 'anonymous';
        const body = node.childForFieldName('body');
        if (body) for (const child of body.children) walk(child, qual(parent, name), false);
        return;
      }
      case 'export_statement': {
        // export default <arrow/function expression> — the function sits in
        // the `value` field with no declaration wrapper; name it 'default'
        const value = node.childForFieldName('value');
        if (value && isFunctionValue(value)) {
          emit(tsValueEntry(node, value, 'default', parent, true), node);
          walkBody(value, qual(parent, 'default'));
          return;
        }
        for (const child of node.children) walk(child, parent, true);
        return;
      }
      case 'pair': {
        // object-literal property with a function value: { onClick: () => {} }
        const key = node.childForFieldName('key')?.text;
        const value = node.childForFieldName('value');
        if (key && value && isFunctionValue(value)) {
          emit(tsValueEntry(node, value, key, parent, false), node);
          walkBody(value, qual(parent, key));
          return;
        }
        for (const child of node.children) walk(child, parent, false);
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const child of node.children) walk(child, parent, exportedHere);
        return;
      }
      default: {
        for (const child of node.children) walk(child, parent, false);
      }
    }
  };

  const walkBody = (fnNode: Parser.SyntaxNode, newParent: string): void => {
    const body = fnNode.childForFieldName('body');
    if (body) for (const child of body.children) walk(child, newParent, false);
  };

  for (const child of root.children) walk(child, null, false);
}

function qual(parent: string | null, name: string): string {
  return parent ? `${parent}.${name}` : name;
}

function tsEntry(
  node: Parser.SyntaxNode,
  name: string,
  kind: FunctionKind,
  parent: string | null,
  exported: boolean,
): FunctionEntry {
  return finishEntry({
    name,
    params: extractTSParams(node.childForFieldName('parameters')),
    returnType: extractReturnType(node),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    async: node.children.some(c => c.type === 'async'),
    exported,
    kind,
    parent,
  });
}

/** Cap params, build the signature from the capped list, flag the cap. */
function finishEntry(e: Omit<FunctionEntry, 'signature' | 'truncated'>): FunctionEntry {
  const paramsTotal = cap(e.params, LIMITS.maxParams);
  const entry: FunctionEntry = {
    ...e,
    signature: buildSignature(e.name, e.params, e.returnType, paramsTotal !== null),
  };
  if (paramsTotal !== null) entry.truncated = { params: paramsTotal };
  return entry;
}

/** Entry for `name = <arrow/function>` class fields — reported as methods. */
function tsFieldEntry(
  fieldNode: Parser.SyntaxNode,
  value: Parser.SyntaxNode,
  name: string,
  parent: string | null,
): FunctionEntry {
  return finishEntry({
    name,
    params: extractTSParams(value.childForFieldName('parameters')),
    returnType: extractReturnType(value),
    line: fieldNode.startPosition.row + 1,
    endLine: fieldNode.endPosition.row + 1,
    async: value.children.some(c => c.type === 'async'),
    exported: false,
    kind: 'method',
    parent,
  });
}

/** Entry for `const name = <arrow/function>` declarators. */
function tsValueEntry(
  declaratorNode: Parser.SyntaxNode,
  value: Parser.SyntaxNode,
  name: string,
  parent: string | null,
  exported: boolean,
): FunctionEntry {
  return finishEntry({
    name,
    params: extractTSParams(value.childForFieldName('parameters')),
    returnType: extractReturnType(value),
    line: declaratorNode.startPosition.row + 1,
    endLine: declaratorNode.endPosition.row + 1,
    async: value.children.some(c => c.type === 'async'),
    exported,
    kind: value.type === 'arrow_function' ? 'arrow' : 'function',
    parent,
  });
}

function extractTSParams(paramsNode: Parser.SyntaxNode | null): ParamInfo[] {
  if (!paramsNode) return [];
  const params: ParamInfo[] = [];
  for (const child of paramsNode.children) {
    if (child.type === '(' || child.type === ')' || child.type === ',') continue;

    if (child.type === 'required_parameter' || child.type === 'optional_parameter') {
      const pattern = child.childForFieldName('pattern');
      const name = pattern?.text ?? child.children.find(c => c.type === 'identifier')?.text ?? 'unknown';
      const typeAnnotation = child.childForFieldName('type');
      const type = typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, '') : null;
      params.push({ name: child.type === 'optional_parameter' ? `${name}?` : name, type });
    } else if (child.type === 'rest_parameter') {
      const ident = child.children.find(c => c.type === 'identifier');
      const name = ident ? `...${ident.text}` : child.text;
      const typeAnnotation = child.childForFieldName('type');
      const type = typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, '') : null;
      params.push({ name, type });
    } else if (child.type === 'identifier') {
      params.push({ name: child.text, type: null });
    } else if (child.type === 'assignment_pattern') {
      const left = child.childForFieldName('left') ?? child.children[0];
      params.push({ name: left?.text ?? 'unknown', type: null });
    } else if (child.type === 'object_pattern' || child.type === 'array_pattern') {
      params.push({ name: child.text, type: null });
    }
  }
  return params;
}

function extractReturnType(node: Parser.SyntaxNode): string | null {
  const rt = node.childForFieldName('return_type');
  if (!rt) return null;
  return rt.text.replace(/^:\s*/, '').replace(/^\s*->\s*/, '');
}

// --- Python functions ---

function collectPyFunctions(
  node: Parser.SyntaxNode,
  out: FunctionEntry[],
  source: string,
  parent: string | null,
  parentKind: 'class' | 'function' | null,
  spans?: SourceSpan[],
): void {
  for (const child of node.children) {
    let target = child;
    let wrapper = child;
    if (child.type === 'decorated_definition') {
      const inner = child.children.find(c => c.type === 'function_definition' || c.type === 'class_definition');
      if (!inner) continue;
      target = inner;
    }

    if (target.type === 'function_definition') {
      const name = target.childForFieldName('name')?.text ?? 'anonymous';
      out.push(buildPyFunctionEntry(target, source, parent, parentKind, wrapper));
      spans?.push({ start: wrapper.startIndex, end: wrapper.endIndex });
      const body = target.childForFieldName('body');
      if (body) collectPyFunctions(body, out, source, qual(parent, name), 'function', spans);
    } else if (target.type === 'class_definition') {
      const name = target.childForFieldName('name')?.text ?? 'anonymous';
      const body = target.childForFieldName('body');
      if (body) collectPyFunctions(body, out, source, qual(parent, name), 'class', spans);
    } else if (child.childCount > 0) {
      // recurse into compound statements (if/try/with/for at any level)
      collectPyFunctions(child, out, source, parent, parentKind, spans);
    }
  }
}

function buildPyFunctionEntry(
  node: Parser.SyntaxNode,
  source: string,
  parent: string | null,
  parentKind: 'class' | 'function' | null,
  outerNode: Parser.SyntaxNode,
): FunctionEntry {
  const name = node.childForFieldName('name')?.text ?? 'anonymous';
  const nodeText = source.slice(node.startIndex, Math.min(node.startIndex + 20, node.endIndex));
  const isAsync = nodeText.trimStart().startsWith('async');

  return finishEntry({
    name,
    params: extractPyParams(node.childForFieldName('parameters')),
    returnType: extractReturnType(node),
    line: outerNode.startPosition.row + 1,
    endLine: outerNode.endPosition.row + 1,
    async: isAsync,
    exported: false,
    kind: parentKind === 'class' ? 'method' : 'function',
    parent,
  });
}

function extractPyParams(paramsNode: Parser.SyntaxNode | null): ParamInfo[] {
  if (!paramsNode) return [];
  const params: ParamInfo[] = [];
  for (const child of paramsNode.children) {
    if (child.type === '(' || child.type === ')' || child.type === ',' || child.type === ':') continue;

    if (child.type === 'identifier') {
      params.push({ name: child.text, type: null });
    } else if (child.type === 'typed_parameter') {
      const ident = child.children.find(c => c.type === 'identifier');
      const typeNode = child.childForFieldName('type');
      params.push({ name: ident?.text ?? 'unknown', type: typeNode?.text ?? null });
    } else if (child.type === 'default_parameter') {
      const nameNode = child.childForFieldName('name') ?? child.children[0];
      params.push({ name: nameNode?.text ?? 'unknown', type: null });
    } else if (child.type === 'typed_default_parameter') {
      const nameNode = child.childForFieldName('name') ?? child.children[0];
      const typeNode = child.childForFieldName('type');
      params.push({ name: nameNode?.text ?? 'unknown', type: typeNode?.text ?? null });
    } else if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern') {
      params.push({ name: child.text, type: null });
    } else if (child.type === 'keyword_separator' || child.type === 'positional_separator') {
      params.push({ name: child.text, type: null });
    }
  }
  return params;
}

// --- Directory walking (shared by map + find) ---

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor',
  'venv', '.venv', 'env', '__pycache__', '.git', '.next', '.nuxt',
  '.cache', 'target', 'egg-info',
]);

export interface WalkResult {
  files: string[]; // relative to the walked root
  total: number;   // total supported files found (may exceed files.length)
}

export function walkSupportedFiles(rootDir: string, maxFiles: number): WalkResult {
  const files: string[] = [];
  let total = 0;
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EXT_TO_LANG[ext]) {
          total++;
          if (files.length < maxFiles) files.push(relPath);
        }
      }
    }
  };
  walk(rootDir, '');
  return { files, total };
}

// --- Tool: map ---

export async function mapDirectory(rawPath: string, cwd?: string): Promise<MapResult | ErrorResult> {
  try {
    const dirPath = validatePath(rawPath, cwd);
    if (!fs.existsSync(dirPath)) {
      return toError(withHint(new Error(`Directory not found: ${rawPath}`),
        'Pass a directory under the server working directory (see info).'), rawPath);
    }
    if (!fs.statSync(dirPath).isDirectory()) {
      return toError(withHint(new Error(`Path is a file, not a directory: ${rawPath}`),
        'Use overview for single files; map takes a directory.'), rawPath);
    }

    const { files, total } = walkSupportedFiles(dirPath, LIMITS.maxMapFiles);
    const out: MapFileEntry[] = [];
    for (const rel of files) {
      out.push(await mapOneFile(dirPath, rel));
    }
    return {
      path: rawPath,
      files: out,
      totalSupportedFiles: total,
      filesParsed: out.filter(f => !f.error).length,
      truncated: total > files.length,
    };
  } catch (e: unknown) {
    return toError(e, rawPath);
  }
}

async function mapOneFile(dirPath: string, rel: string): Promise<MapFileEntry> {
  const abs = path.join(dirPath, rel);
  const ext = path.extname(rel).toLowerCase();
  const language = EXT_TO_LANG[ext] ?? 'unknown';
  try {
    const { tree, source, language: lang } = await parseFile(abs, rel);
    const imports: string[] = [];
    const exports: string[] = [];
    const classes: ClassEntry[] = [];
    const fns: OverviewFunction[] = [];
    if (lang === 'python') extractPyOverview(tree.rootNode, imports, exports, classes, fns);
    else extractTSOverview(tree.rootNode, imports, exports, classes, fns);

    const classNames = classes.map(c => c.name);
    const fnNames = fns.map(f => f.name);
    const entry: MapFileEntry = {
      path: rel,
      language: lang,
      totalLines: countLines(source),
      classes: classNames,
      functions: fnNames,
    };
    if (tree.rootNode.hasError) entry.hasErrors = true;
    const truncated: Record<string, number> = {};
    const ct = cap(classNames, LIMITS.maxMapNamesPerFile);
    if (ct !== null) truncated.classes = ct;
    const ft = cap(fnNames, LIMITS.maxMapNamesPerFile);
    if (ft !== null) truncated.functions = ft;
    if (Object.keys(truncated).length > 0) entry.truncated = truncated;
    return entry;
  } catch (e: unknown) {
    return { path: rel, language, totalLines: 0, classes: [], functions: [], error: (e as Error).message };
  }
}

// --- Tool: find ---

export async function findSymbol(
  name: string,
  rawPath: string,
  cwd?: string,
  exact = false,
): Promise<FindResult | ErrorResult> {
  try {
    if (!name || name.trim() === '') {
      return toError(withHint(new Error('Empty search name.'),
        'Pass the function/class/method name to look for (substring match by default, exact=true for exact).'), rawPath);
    }
    const dirPath = validatePath(rawPath, cwd);
    if (!fs.existsSync(dirPath)) {
      return toError(withHint(new Error(`Path not found: ${rawPath}`),
        'Pass a directory (or file) under the server working directory (see info).'), rawPath);
    }

    const isFile = fs.statSync(dirPath).isFile();
    const { files, total } = isFile
      ? { files: [path.basename(dirPath)], total: 1 }
      : walkSupportedFiles(dirPath, LIMITS.maxFindFiles);
    const baseDir = isFile ? path.dirname(dirPath) : dirPath;

    const needle = name.trim();
    const matches: FindMatch[] = [];
    const skipped: Array<{ file: string; error: string }> = [];
    let skippedTotal = 0;
    let scanned = 0;
    let matchesTruncated = false;

    for (const rel of files) {
      if (matches.length >= LIMITS.maxFindMatches) {
        matchesTruncated = true;
        break;
      }
      const abs = path.join(baseDir, rel);
      try {
        const { tree, source, language } = await parseFile(abs, rel);
        const fns: FunctionEntry[] = [];
        const classes: ClassEntry[] = [];
        if (language === 'python') {
          collectPyFunctions(tree.rootNode, fns, source, null, null);
          const imports: string[] = []; const exports: string[] = []; const ofns: OverviewFunction[] = [];
          extractPyOverview(tree.rootNode, imports, exports, classes, ofns);
        } else {
          collectTSFunctions(tree.rootNode, fns, collectTSExportedNames(tree.rootNode));
          const imports: string[] = []; const exports: string[] = []; const ofns: OverviewFunction[] = [];
          extractTSOverview(tree.rootNode, imports, exports, classes, ofns);
        }
        for (const f of fns) {
          if (matchName(f.name, needle, exact)) {
            matches.push({ file: rel, name: f.name, kind: f.kind, line: f.line, signature: f.signature, parent: f.parent });
            if (matches.length >= LIMITS.maxFindMatches) break;
          }
        }
        for (const c of classes) {
          if (matches.length >= LIMITS.maxFindMatches) break;
          if (matchName(c.name, needle, exact)) {
            matches.push({ file: rel, name: c.name, kind: 'class', line: c.line, signature: null, parent: null });
          }
        }
        // Non-callable bindings: const/let/var, type aliases, interfaces, enums
        // (issue #2). Function-valued declarators are excluded by the collectors.
        const bindings = language === 'python' ? collectPyBindings(tree.rootNode) : collectTSBindings(tree.rootNode);
        for (const b of bindings) {
          if (matches.length >= LIMITS.maxFindMatches) break;
          if (matchName(b.name, needle, exact)) {
            matches.push({ file: rel, name: b.name, kind: b.kind, line: b.line, signature: null, parent: null });
          }
        }
        scanned++;
      } catch (e: unknown) {
        // an unsearched file must never look searched — list it as skipped
        skippedTotal++;
        if (skipped.length < LIMITS.maxFindSkipped) {
          skipped.push({ file: rel, error: (e as Error).message });
        }
      }
    }

    const result: FindResult = {
      query: needle,
      path: rawPath,
      matches,
      filesScanned: scanned,
      totalSupportedFiles: total,
      truncated: matchesTruncated || total > files.length || scanned + skippedTotal < files.length,
    };
    if (skippedTotal > 0) {
      result.skipped = skipped;
      if (skippedTotal > skipped.length) result.skippedTotal = skippedTotal;
    }
    return result;
  } catch (e: unknown) {
    return toError(e, rawPath);
  }
}

function matchName(candidate: string, needle: string, exact: boolean): boolean {
  if (exact) return candidate === needle;
  return candidate.toLowerCase().includes(needle.toLowerCase());
}

// --- Non-callable top-level bindings (issue #2: const/let/type/enum/…) ---
// find covered functions/classes only, but a codebase's source-of-truth often
// lives in `export const ALL_MODULES = [...]`, type aliases, and enums. These
// collectors surface those as findable symbols. Functions-valued bindings are
// left to the function collectors (they carry signatures) to avoid duplicates.

function tsDeclKind(declNode: Parser.SyntaxNode): 'const' | 'let' | 'var' {
  const kw = declNode.children[0]?.text;
  return kw === 'let' ? 'let' : kw === 'var' ? 'var' : 'const';
}

function collectTSBindingsFrom(node: Parser.SyntaxNode, exported: boolean, out: BindingEntry[]): void {
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const kind = tsDeclKind(node);
    for (const vd of node.children) {
      if (vd.type !== 'variable_declarator') continue;
      const nameNode = vd.childForFieldName('name');
      const value = vd.childForFieldName('value');
      // functions-valued declarators are handled by the function collectors
      if (nameNode && nameNode.type === 'identifier' && !(value && isFunctionValue(value))) {
        out.push({ name: nameNode.text, kind, line: node.startPosition.row + 1, exported });
      }
    }
  } else if (node.type === 'type_alias_declaration') {
    const n = node.childForFieldName('name')?.text;
    if (n) out.push({ name: n, kind: 'type', line: node.startPosition.row + 1, exported });
  } else if (node.type === 'interface_declaration') {
    const n = node.childForFieldName('name')?.text;
    if (n) out.push({ name: n, kind: 'interface', line: node.startPosition.row + 1, exported });
  } else if (node.type === 'enum_declaration') {
    const n = node.childForFieldName('name')?.text;
    if (n) out.push({ name: n, kind: 'enum', line: node.startPosition.row + 1, exported });
  }
}

function collectTSBindings(root: Parser.SyntaxNode): BindingEntry[] {
  const out: BindingEntry[] = [];
  for (const child of root.children) {
    if (child.type === 'export_statement') {
      for (const inner of child.children) collectTSBindingsFrom(inner, true, out);
    } else {
      collectTSBindingsFrom(child, false, out);
    }
  }
  return out;
}

function collectPyBindings(root: Parser.SyntaxNode): BindingEntry[] {
  const out: BindingEntry[] = [];
  for (const child of root.children) {
    if (child.type !== 'expression_statement') continue;
    const assign = child.children[0];
    if (assign?.type !== 'assignment') continue;
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (!left || left.type !== 'identifier' || left.text === '__all__') continue;
    if (right && (right.type === 'lambda')) continue; // lambda is function-ish
    out.push({ name: left.text, kind: 'variable', line: child.startPosition.row + 1, exported: false });
  }
  return out;
}

// --- Tool: references (issue #1: who calls / imports / type-refs X) ---

function classifyReference(node: Parser.SyntaxNode): ReferenceKind | null {
  const parent = node.parent;
  if (!parent) return 'reference';
  const pt = parent.type;
  // web-tree-sitter recreates node objects per access — compare .id, NEVER ===
  // (this exact gotcha silently mislabels every reference otherwise).
  const isField = (n: Parser.SyntaxNode, field: string) => parent.childForFieldName(field)?.id === n.id;
  // Definition sites: the identifier is the 'name'/'left' of a declaration.
  if (['function_declaration', 'generator_function_declaration', 'class_declaration',
    'method_definition', 'variable_declarator', 'type_alias_declaration', 'interface_declaration',
    'enum_declaration', 'function_definition', 'class_definition'].includes(pt)
    && (isField(node, 'name') || isField(node, 'left'))) {
    return 'definition';
  }
  // Imports.
  if (['import_specifier', 'namespace_import', 'import_clause', 'import_statement',
    'import_from_statement', 'dotted_name', 'aliased_import'].includes(pt)) return 'import';
  // Calls: identifier is the callee (function field of a call).
  if ((pt === 'call_expression' || pt === 'call') && isField(node, 'function')) return 'call';
  if (pt === 'member_expression' && parent.parent?.type === 'call_expression'
    && parent.parent.childForFieldName('function')?.id === parent.id) return 'call';
  if (pt === 'new_expression') return 'instantiation';
  // Type positions.
  if (node.type === 'type_identifier') return 'type-ref';
  if (['type_annotation', 'type_arguments', 'generic_type', 'extends_clause', 'implements_clause'].includes(pt)) return 'type-ref';
  return 'reference';
}

function collectReferences(
  node: Parser.SyntaxNode, name: string, source: string, file: string, out: ReferenceEntry[], seenLines: Set<number>,
): void {
  const REF_NODE_TYPES = new Set(['identifier', 'type_identifier', 'property_identifier', 'shorthand_property_identifier']);
  const walk = (n: Parser.SyntaxNode) => {
    if (REF_NODE_TYPES.has(n.type) && n.text === name) {
      const line = n.startPosition.row + 1;
      const key = line * 8 + Math.min(n.startPosition.column, 7);
      if (!seenLines.has(key)) {
        seenLines.add(key);
        const kind = classifyReference(n);
        if (kind) {
          const raw = (source.split('\n')[n.startPosition.row] ?? '').trim();
          out.push({ file, line, kind, context: raw.length > LIMITS.maxRefContextChars ? raw.slice(0, LIMITS.maxRefContextChars) + '…' : raw });
        }
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
}

/**
 * Every reference to a symbol across a directory — call sites, imports, type
 * references, and the definition — tree-sitter-backed so a same-named string or
 * comment is never a false positive. Exact name match (references need
 * precision). The inverse of find (which locates definitions).
 */
export async function findReferences(
  name: string, rawPath: string, cwd?: string,
): Promise<ReferencesResult | ErrorResult> {
  try {
    if (!name || name.trim() === '') {
      return toError(withHint(new Error('Empty symbol name.'),
        'Pass the exact symbol name to find references for (e.g. a function/class/const from find or overview).'), rawPath);
    }
    const needle = name.trim();
    const dirPath = validatePath(rawPath, cwd);
    if (!fs.existsSync(dirPath)) {
      return toError(withHint(new Error(`Path not found: ${rawPath}`),
        'Pass a directory (or file) under the server working directory (see info).'), rawPath);
    }
    const isFile = fs.statSync(dirPath).isFile();
    const { files, total } = isFile
      ? { files: [path.basename(dirPath)], total: 1 }
      : walkSupportedFiles(dirPath, LIMITS.maxRefFiles);
    const baseDir = isFile ? path.dirname(dirPath) : dirPath;

    const references: ReferenceEntry[] = [];
    const skipped: Array<{ file: string; error: string }> = [];
    let skippedTotal = 0, scanned = 0, refsTruncated = false;

    for (const rel of files) {
      if (references.length >= LIMITS.maxRefMatches) { refsTruncated = true; break; }
      const abs = path.join(baseDir, rel);
      try {
        const { tree, source } = await parseFile(abs, rel);
        collectReferences(tree.rootNode, needle, source, rel, references, new Set());
        scanned++;
        if (references.length > LIMITS.maxRefMatches) {
          references.length = LIMITS.maxRefMatches; refsTruncated = true; break;
        }
      } catch (e: unknown) {
        skippedTotal++;
        if (skipped.length < LIMITS.maxFindSkipped) skipped.push({ file: rel, error: (e as Error).message });
      }
    }

    const byKind: Record<string, number> = {};
    for (const r of references) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

    const result: ReferencesResult = {
      symbol: needle,
      path: rawPath,
      references,
      filesScanned: scanned,
      totalSupportedFiles: total,
      truncated: refsTruncated || total > files.length || scanned + skippedTotal < files.length,
      byKind,
    };
    if (skippedTotal > 0) {
      result.skipped = skipped;
      if (skippedTotal > skipped.length) result.skippedTotal = skippedTotal;
    }
    return result;
  } catch (e: unknown) {
    return toError(e, rawPath);
  }
}

// --- Tool: function_body ---

/**
 * Return the verbatim source of ONE function — the focused-read tool. Name
 * matches the bare name or the dotted qualified form ("Widget.render");
 * ambiguity is an error listing the candidates, never a guess.
 */
export async function functionBody(
  rawPath: string,
  name: string,
  cwd?: string,
  line?: number,
): Promise<FunctionBodyResult | ErrorResult> {
  try {
    if (!name || name.trim() === '') {
      return toError(withHint(new Error('Empty function name.'),
        'Pass the function/method name; nested names use the dotted form from functions() (e.g. Widget.render).'), rawPath);
    }
    const filePath = validatePath(rawPath, cwd);
    const { tree, source, language } = await parseFile(filePath, rawPath);
    const entries: FunctionEntry[] = [];
    const spans: SourceSpan[] = [];

    if (language === 'typescript' || language === 'javascript') {
      collectTSFunctions(tree.rootNode, entries, collectTSExportedNames(tree.rootNode), spans);
    } else if (language === 'python') {
      collectPyFunctions(tree.rootNode, entries, source, null, null, spans);
    }

    const needle = name.trim();
    let candidates = entries
      .map((e, i) => ({ e, span: spans[i] }))
      .filter(({ e }) => e.name === needle || (e.parent !== null && `${e.parent}.${e.name}` === needle));
    if (line !== undefined) candidates = candidates.filter(({ e }) => e.line === line);

    if (candidates.length === 0) {
      const near = entries
        .filter(e => matchName(e.name, needle, false))
        .slice(0, 10)
        .map(e => (e.parent ? `${e.parent}.${e.name}` : e.name) + `:${e.line}`);
      return toError(withHint(new Error(`Function not found: ${needle} (${rawPath})`),
        near.length > 0
          ? `Similar names in this file: ${near.join(', ')}. Nested names use the dotted form.`
          : 'Call functions(path) to list this file\'s function names; nested names use the dotted form (e.g. Widget.render).'), rawPath);
    }
    if (candidates.length > 1) {
      const list = candidates.slice(0, 10)
        .map(({ e }) => `${e.parent ? `${e.parent}.${e.name}` : e.name} (line ${e.line})`).join(', ');
      return toError(withHint(new Error(`Ambiguous name: ${needle} has ${candidates.length} definitions in ${rawPath}`),
        `Candidates: ${list}. Pass the qualified dotted name or line to pick one.`), rawPath);
    }

    const { e, span } = candidates[0];
    let body = source.slice(span.start, span.end);
    const bodyTotal = body.length;
    const clipped = bodyTotal > LIMITS.maxBodyChars;
    if (clipped) body = body.slice(0, LIMITS.maxBodyChars) + '…';

    const result: FunctionBodyResult = {
      path: rawPath,
      name: e.name,
      parent: e.parent,
      kind: e.kind,
      signature: e.signature,
      line: e.line,
      endLine: e.endLine,
      async: e.async,
      exported: e.exported,
      hasErrors: tree.rootNode.hasError,
      body,
    };
    if (clipped) result.truncated = { bodyChars: bodyTotal };
    return result;
  } catch (e: unknown) {
    return toError(e, rawPath);
  }
}

// --- Shared helpers ---

function buildSignature(name: string, params: ParamInfo[], returnType: string | null, paramsTruncated = false): string {
  let paramStr = params.map(p => p.type ? `${p.name}: ${p.type}` : p.name).join(', ');
  if (paramsTruncated) paramStr += ', …';
  return returnType ? `${name}(${paramStr}): ${returnType}` : `${name}(${paramStr})`;
}
