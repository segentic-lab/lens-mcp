// Prisma schema lens (issue #3). A large share of a TS backend's edits land in
// schema.prisma — clean block structure (models/enums/types/fields/relations)
// that maps beautifully. Line-based parser (no extra grammar dependency, same
// spirit as the markdown lens). Shares the code lens's path sandbox + caps.
import * as fs from 'node:fs';
import { validatePath, LIMITS } from './code.js';

export const PRISMA_EXTENSIONS = ['.prisma'] as const;

const SCALARS = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes',
]);

export interface PrismaField {
  name: string;
  type: string;         // as written, e.g. "Post[]", "Role", "String?"
  line: number;
  kind: 'scalar' | 'relation' | 'enum' | 'unknown';
  attributes: string;   // trailing @attrs, trimmed (e.g. "@id @default(cuid())")
}
export interface PrismaBlock {
  name: string;
  line: number;
  fields?: PrismaField[];
  values?: string[];       // for enums
  truncated?: Record<string, number>;
}
export interface PrismaOverview {
  path: string;
  language: 'prisma';
  totalLines: number;
  models: PrismaBlock[];
  enums: PrismaBlock[];
  types: PrismaBlock[];
  datasources: string[];
  generators: string[];
  truncated?: Record<string, number>;
}
export interface ErrorResult { error: string; path: string; hint?: string }

function readSchema(rawPath: string, cwd?: string): { lines: string[] } | ErrorResult {
  let filePath: string;
  try { filePath = validatePath(rawPath, cwd); }
  catch (e) { return { error: (e as Error).message, path: rawPath, hint: (e as { hint?: string }).hint }; }
  if (!fs.existsSync(filePath)) return { error: `File not found: ${rawPath}`, path: rawPath };
  const stat = fs.statSync(filePath);
  if (stat.size > LIMITS.maxFileBytes) return { error: `File too large (${stat.size} bytes > ${LIMITS.maxFileBytes})`, path: rawPath };
  return { lines: fs.readFileSync(filePath, 'utf-8').split(/\r?\n/) };
}

const BLOCK_RE = /^\s*(model|enum|type|datasource|generator)\s+([A-Za-z_]\w*)\s*\{/;
const FIELD_RE = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_][\w.]*(?:\[\])?\??)\s*(.*)$/;

function closeBlock(block: { kind: string; entry: PrismaBlock }, models: PrismaBlock[], enums: PrismaBlock[], types: PrismaBlock[]): void {
  if (block.kind === 'model') models.push(block.entry);
  else if (block.kind === 'type') types.push(block.entry);
  else if (block.kind === 'enum') enums.push(block.entry);
  // datasource/generator: name already recorded on open; nothing to push.
}

/** Structural overview of a schema.prisma — the code-lens `overview` for Prisma. */
export function overviewPrisma(rawPath: string, cwd?: string): PrismaOverview | ErrorResult {
  const read = readSchema(rawPath, cwd);
  if ('error' in read) return read;
  const { lines } = read;

  const models: PrismaBlock[] = [], enums: PrismaBlock[] = [], types: PrismaBlock[] = [];
  const datasources: string[] = [], generators: string[] = [];

  // First pass: names of models/enums, to classify field types as relation/enum.
  const modelNames = new Set<string>(), enumNames = new Set<string>();
  for (const l of lines) {
    const m = BLOCK_RE.exec(l);
    if (m?.[1] === 'model' || m?.[1] === 'type') modelNames.add(m[2]);
    else if (m?.[1] === 'enum') enumNames.add(m[2]);
  }

  let block: { kind: string; entry: PrismaBlock } | null = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!block) {
      const m = BLOCK_RE.exec(line);
      if (!m) continue;
      const [, kind, name] = m;
      // datasource/generator: record the name; still enter the block so we
      // consume its body until the matching brace (don't collect fields).
      if (kind === 'datasource') datasources.push(name);
      else if (kind === 'generator') generators.push(name);
      const entry: PrismaBlock = kind === 'enum'
        ? { name, line: i + 1, values: [] }
        : (kind === 'model' || kind === 'type') ? { name, line: i + 1, fields: [] }
        : { name, line: i + 1 };
      block = { kind, entry };
      // account for braces opened AND closed on the same line (single-line blocks)
      depth = (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (depth <= 0) { closeBlock(block, models, enums, types); block = null; }
      continue;
    }
    // inside a block
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    if (depth <= 0) { closeBlock(block, models, enums, types); block = null; continue; }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
    if (block.kind === 'enum') {
      const ev = /^([A-Za-z_]\w*)/.exec(trimmed);
      if (ev && block.entry.values) block.entry.values.push(ev[1]);
    } else if (block.kind === 'model' || block.kind === 'type') {
      const f = FIELD_RE.exec(line);
      if (f && block.entry.fields) {
        const [, name, type, rest] = f;
        const base = type.replace(/[[\]?]/g, '');
        const kind: PrismaField['kind'] = SCALARS.has(base) ? 'scalar'
          : enumNames.has(base) ? 'enum'
          : modelNames.has(base) ? 'relation' : 'unknown';
        block.entry.fields.push({ name, type, line: i + 1, kind, attributes: rest.trim() });
      }
    }
  }

  const out: PrismaOverview = {
    path: rawPath, language: 'prisma', totalLines: lines.length,
    models, enums, types, datasources, generators,
  };
  for (const b of [...out.models, ...out.types]) {
    if (b.fields && b.fields.length > LIMITS.maxListEntries) {
      b.truncated = { fields: b.fields.length };
      b.fields = b.fields.slice(0, LIMITS.maxListEntries);
    }
  }
  return out;
}

export interface PrismaSymbolMatch {
  file: string; name: string; kind: 'model' | 'enum' | 'prisma-type' | 'field'; line: number; parent: string | null;
}

/** Find models/enums/composite-types/fields by name across schema files. */
export function findPrismaSymbols(files: string[], baseDir: string, needle: string, exact: boolean): {
  matches: PrismaSymbolMatch[]; scanned: number;
} {
  const matches: PrismaSymbolMatch[] = [];
  let scanned = 0;
  const match = (n: string) => exact ? n === needle : n.toLowerCase().includes(needle.toLowerCase());
  for (const rel of files) {
    const ov = overviewPrisma(rel, baseDir);
    if ('error' in ov) continue;
    scanned++;
    for (const m of ov.models) {
      if (match(m.name)) matches.push({ file: rel, name: m.name, kind: 'model', line: m.line, parent: null });
      for (const f of m.fields ?? []) if (match(f.name)) matches.push({ file: rel, name: f.name, kind: 'field', line: f.line, parent: m.name });
    }
    for (const e of ov.enums) if (match(e.name)) matches.push({ file: rel, name: e.name, kind: 'enum', line: e.line, parent: null });
    for (const t of ov.types) if (match(t.name)) matches.push({ file: rel, name: t.name, kind: 'prisma-type', line: t.line, parent: null });
  }
  return { matches, scanned };
}

/** List .prisma files under a dir with model/enum counts (for map). */
export function listSchemas(dir: string): Array<{ path: string; models: number; enums: number; types: number }> {
  const results: Array<{ path: string; models: number; enums: number; types: number }> = [];
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'venv', '__pycache__', 'target', 'vendor', '.next', 'coverage']);
  const walk = (abs: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= LIMITS.maxMapFiles) return;
      if (e.isDirectory()) { if (!IGNORE.has(e.name) && !e.name.startsWith('.')) walk(`${abs}/${e.name}`, rel ? `${rel}/${e.name}` : e.name); }
      else if (e.name.endsWith('.prisma')) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const ov = overviewPrisma(r, dir);
        if (!('error' in ov)) results.push({ path: r, models: ov.models.length, enums: ov.enums.length, types: ov.types.length });
      }
    }
  };
  try { if (fs.statSync(dir).isDirectory()) walk(dir, ''); } catch { /* ignore */ }
  return results;
}
