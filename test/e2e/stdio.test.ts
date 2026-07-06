// End-to-end: spawn the BUILT lens server and drive it over JSON-RPC like a
// real MCP client — proving the merged code+docs surface works through stdio.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'dist', 'index.js');
// The server sandboxes to its cwd; run it rooted at the repo so it can see both
// test/fixtures (code) and test/fixtures-md (docs).
const CWD = ROOT;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

let proc: ChildProcessWithoutNullStreams;
let buf = '';
const pending = new Map<number, (m: any) => void>();
let nextId = 1;

function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name: string, args: Record<string, unknown>) {
  const res = await rpc('tools/call', { name, arguments: args });
  expect(res.error, `RPC error for ${name}: ${JSON.stringify(res.error)}`).toBeUndefined();
  const isError = res.result.isError === true;
  return { body: JSON.parse(res.result.content[0].text), isError };
}

beforeAll(async () => {
  expect(fs.existsSync(SERVER), 'dist/index.js missing — run `npm run build`').toBe(true);
  proc = spawn('node', [SERVER], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
    }
  });
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'e2e', version: '0.0.0' },
  });
  expect(init.result.serverInfo.name).toBe('lens');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

afterAll(() => { proc?.kill(); });

describe('lens stdio e2e — unified code + docs', () => {
  test('exposes all 12 tools, each with a rich description', async () => {
    const res = await rpc('tools/list', {});
    const names = res.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'comments', 'find', 'function_body', 'functions', 'heading',
      'info', 'lens_system', 'links', 'map', 'outline', 'overview', 'search',
    ]);
    for (const t of res.result.tools) expect(t.description.length).toBeGreaterThan(120);
  });

  test('lens_system status reports version + the install dir (not the sandbox cwd)', async () => {
    const { body, isError } = await call('lens_system', { action: 'status' });
    expect(isError).toBe(false);
    expect(body.name).toBe('lens-mcp');
    expect(body.versionRunning).toBe(pkg.version);
    expect(body.installDir).toBe(ROOT);          // the lens repo, resolved from import.meta.url
    expect(body.installType).toBe('git');
    expect(body.update).toBeDefined();           // present even if offline
  });

  test('lens_system agents_md returns the current guide', async () => {
    const { body, isError } = await call('lens_system', { action: 'agents_md' });
    expect(isError).toBe(false);
    expect(body.content).toContain('navigation map');
    expect(body.note).toContain('persistent config');
  });

  test('lens_system update defaults to a dry run', async () => {
    const { body } = await call('lens_system', { action: 'update' });
    expect(body.mode).toBe('dry_run');
    expect(body.note).toContain('apply=true');
  });

  test('info reports the merged surface', async () => {
    const { body, isError } = await call('info', {});
    expect(isError).toBe(false);
    expect(body.name).toBe('lens-mcp');
    expect(body.version).toBe(pkg.version);
    expect(body.workingDirectory).toBe(CWD);
    expect(body.code.languages.python).toContain('.py');
    expect(body.docs.extensions).toContain('.md');
    expect(body.tools).toHaveLength(12);
  });

  test('map returns BOTH code files and docs in one call', async () => {
    const { body, isError } = await call('map', { path: '.' });
    expect(isError).toBe(false);
    expect(body.code.filesParsed).toBeGreaterThan(0);
    expect(body.docs.docs.length).toBeGreaterThan(0);
    expect(body.summary.codeFiles).toBeGreaterThan(0);
    expect(body.summary.docFiles).toBeGreaterThan(0);
  });

  test('code drill-down works (functions on a .ts fixture)', async () => {
    const { body, isError } = await call('functions', { path: 'test/fixtures/sample.ts' });
    expect(isError).toBe(false);
    expect(body.functions.length).toBeGreaterThan(0);
  });

  test('doc drill-down works (heading reads one section)', async () => {
    const { body, isError } = await call('heading', {
      file: 'test/fixtures-md/docs/guide.md', ref: 'Getting Started Guide',
    });
    expect(isError).toBe(false);
    expect(body.content.length).toBeGreaterThan(0);
    expect(body.startLine).toBeGreaterThan(0);
  });

  test('cross-type guidance: code tool on a .md names the doc tools', async () => {
    const { body, isError } = await call('overview', { path: 'test/fixtures-md/README.md' });
    expect(isError).toBe(true);
    expect(body.hint).toContain('outline');
  });

  test('cross-type guidance: doc tool on a .ts names the code tools', async () => {
    const { body, isError } = await call('outline', { path: 'test/fixtures/sample.ts' });
    expect(isError).toBe(true);
    expect(body.error).toContain('overview');
  });

  test('search rejects an empty query', async () => {
    const { isError } = await call('search', { query: '' });
    expect(isError).toBe(true);
  });
});
