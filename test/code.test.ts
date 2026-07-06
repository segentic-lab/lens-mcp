import { describe, test, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  overview,
  comments,
  functions,
  mapDirectory,
  findSymbol,
  functionBody,
  ensureInit,
  validatePath,
  LIMITS,
  type OverviewResult,
  type CommentsResult,
  type FunctionsResult,
  type MapResult,
  type FindResult,
  type FunctionBodyResult,
  type ErrorResult,
} from '../src/code.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

beforeAll(async () => {
  await ensureInit();
});

const ov = (f: string) => overview(f, FIXTURES) as Promise<OverviewResult>;
const fn = (f: string) => functions(f, FIXTURES) as Promise<FunctionsResult>;
const cm = (f: string, markersOnly = false) => comments(f, FIXTURES, markersOnly) as Promise<CommentsResult>;

// ---- overview ----

describe('overview', () => {
  test('TS: language, imports, exports, classes, functions', async () => {
    const o = await ov('sample.ts');
    expect(o.language).toBe('typescript');
    expect(o.hasErrors).toBe(false);
    expect(o.totalLines).toBeGreaterThan(10);
    expect(o.imports).toEqual(
      expect.arrayContaining([expect.stringContaining('EventEmitter'), expect.stringContaining('path')]),
    );
    expect(o.exports).toEqual(expect.arrayContaining(['Application', 'processData', 'helperFunction']));
    expect(o.classes).toEqual([
      expect.objectContaining({ name: 'Application', methods: expect.arrayContaining(['constructor', 'start', 'stop']) }),
    ]);
    expect(o.functions.find(f => f.name === 'helperFunction')).toMatchObject({ exported: true });
    expect(o.functions.find(f => f.name === 'processData')).toMatchObject({ exported: true });
  });

  test('JS: classes and functions', async () => {
    const o = await ov('sample.js');
    expect(o.language).toBe('javascript');
    expect(o.classes).toEqual([expect.objectContaining({ name: 'FileProcessor' })]);
    expect(o.functions.map(f => f.name)).toEqual(expect.arrayContaining(['readConfig', 'transform']));
  });

  test('Python: imports, classes, functions', async () => {
    const o = await ov('sample.py');
    expect(o.language).toBe('python');
    expect(o.imports.length).toBeGreaterThanOrEqual(3);
    expect(o.classes).toEqual([
      expect.objectContaining({
        name: 'DataProcessor',
        methods: expect.arrayContaining(['__init__', 'process', 'validate']),
      }),
    ]);
    expect(o.functions.map(f => f.name)).toEqual(expect.arrayContaining(['load_config', 'fetch_data']));
  });

  test('Python: __all__ becomes exports; nested classes surface', async () => {
    const o = await ov('nested.py');
    expect(o.exports).toEqual(['outer', 'A']);
    expect(o.classes.map(c => c.name)).toEqual(expect.arrayContaining(['A', 'Inner']));
  });

  test('TSX: JSX components are seen (tsx grammar, not typescript)', async () => {
    const o = await ov('component.tsx');
    expect(o.hasErrors).toBe(false);
    expect(o.functions.map(f => f.name)).toEqual(expect.arrayContaining(['Header', 'Footer']));
    expect(o.exports).toEqual(expect.arrayContaining(['Header', 'Footer']));
  });

  test('class-field arrows count as methods', async () => {
    const o = await ov('tricky.ts');
    const widget = o.classes.find(c => c.name === 'Widget')!;
    expect(widget.methods).toEqual(expect.arrayContaining(['onClick', 'create', 'value', '#hidden']));
  });

  test(`class methods cap at ${LIMITS.maxMethodsPerClass} with truncated flag`, async () => {
    const file = path.join(FIXTURES, 'bigclass.ts');
    const n = LIMITS.maxMethodsPerClass + 10;
    const methods = Array.from({ length: n }, (_, i) => `  m${i}(): void {}`).join('\n');
    fs.writeFileSync(file, `class Big {\n${methods}\n}\n`);
    try {
      const o = await ov('bigclass.ts');
      const big = o.classes[0];
      expect(big.methods).toHaveLength(LIMITS.maxMethodsPerClass);
      expect(big.truncated).toEqual({ methods: n });
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('decorated nested Python class keeps decorator line in range', async () => {
    const file = path.join(FIXTURES, 'decnested.py');
    fs.writeFileSync(file, 'class Outer:\n    @decorator\n    class Inner:\n        def m(self):\n            pass\n');
    try {
      const o = await ov('decnested.py');
      const inner = o.classes.find(c => c.name === 'Inner')!;
      expect(inner.line).toBe(2); // the @decorator line, not "class Inner:"
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('syntax errors are flagged, never silent', async () => {
    const o = await ov('broken.ts');
    expect(o.hasErrors).toBe(true);
    expect(o.parseErrors!.length).toBeGreaterThanOrEqual(1);
    expect(o.parseErrors![0]).toMatchObject({ line: expect.any(Number), endLine: expect.any(Number) });
  });

  test('line numbers are 1-based and endLine >= line', async () => {
    const o = await ov('sample.ts');
    for (const cls of o.classes) {
      expect(cls.line).toBeGreaterThanOrEqual(1);
      expect(cls.endLine).toBeGreaterThanOrEqual(cls.line);
    }
    for (const f of o.functions) {
      expect(f.line).toBeGreaterThanOrEqual(1);
      expect(f.endLine).toBeGreaterThanOrEqual(f.line);
    }
  });

  test('empty file: totalLines 0, empty lists, no errors', async () => {
    const empty = path.join(FIXTURES, 'empty.ts');
    fs.writeFileSync(empty, '');
    try {
      const o = await ov('empty.ts');
      expect(o.totalLines).toBe(0);
      expect(o.hasErrors).toBe(false);
      expect(o.functions).toEqual([]);
    } finally {
      fs.unlinkSync(empty);
    }
  });
});

// ---- functions ----

describe('functions', () => {
  test('TS: function, method, arrow with types and endLine', async () => {
    const f = await fn('sample.ts');
    const helper = f.functions.find(x => x.name === 'helperFunction')!;
    expect(helper.kind).toBe('function');
    expect(helper.params).toEqual([
      { name: 'a', type: 'string' },
      { name: 'b', type: 'number' },
    ]);
    expect(helper.returnType).toBe('boolean');
    expect(helper.signature).toBe('helperFunction(a: string, b: number): boolean');
    expect(helper.endLine).toBeGreaterThanOrEqual(helper.line);
    expect(helper.parent).toBeNull();

    const arrow = f.functions.find(x => x.name === 'processData')!;
    expect(arrow.kind).toBe('arrow');
    expect(arrow.async).toBe(true);
    expect(arrow.exported).toBe(true);

    const start = f.functions.find(x => x.name === 'start')!;
    expect(start.kind).toBe('method');
    expect(start.async).toBe(true);
    expect(start.parent).toBe('Application');
  });

  test('JS: plain + arrow + method with parent', async () => {
    const f = await fn('sample.js');
    expect(f.functions.find(x => x.name === 'readConfig')).toMatchObject({ kind: 'function', params: [{ name: 'configPath', type: null }] });
    expect(f.functions.find(x => x.name === 'transform')).toMatchObject({ kind: 'arrow' });
    expect(f.functions.find(x => x.name === 'process')).toMatchObject({ kind: 'method', parent: 'FileProcessor' });
  });

  test('Python: sync, async, method with types', async () => {
    const f = await fn('sample.py');
    expect(f.functions.find(x => x.name === 'load_config')).toMatchObject({ kind: 'function', returnType: 'dict' });
    expect(f.functions.find(x => x.name === 'fetch_data')).toMatchObject({ async: true, returnType: 'List[dict]' });
    expect(f.functions.find(x => x.name === '__init__')).toMatchObject({ kind: 'method', parent: 'DataProcessor' });
    expect(f.functions.find(x => x.name === 'validate')).toMatchObject({ kind: 'method' });
  });

  test('Python: nested defs, conditional defs, and deep methods all found', async () => {
    const f = await fn('nested.py');
    expect(f.functions.find(x => x.name === 'inner')).toMatchObject({ parent: 'outer', kind: 'function' });
    expect(f.functions.find(x => x.name === 'local_helper')).toMatchObject({ parent: 'A.method' });
    expect(f.functions.find(x => x.name === 'conditional_fn')).toBeDefined();
    expect(f.functions.find(x => x.name === 'deep_method')).toMatchObject({ parent: 'A.Inner', kind: 'method' });
  });

  test('TSX: arrow component returning JSX is found', async () => {
    const f = await fn('component.tsx');
    const footer = f.functions.find(x => x.name === 'Footer')!;
    expect(footer).toBeDefined();
    expect(footer.kind).toBe('arrow');
    expect(footer.exported).toBe(true);
  });

  test('TS: class-field arrows, getters, unicode, generators, namespace', async () => {
    const f = await fn('tricky.ts');
    expect(f.functions.find(x => x.name === 'onClick')).toMatchObject({ kind: 'method', parent: 'Widget' });
    expect(f.functions.find(x => x.name === 'value')).toMatchObject({ kind: 'getter', parent: 'Widget' });
    expect(f.functions.find(x => x.name === 'défaultFn')).toMatchObject({ params: [{ name: 'ünïcode', type: 'string' }] });
    expect(f.functions.find(x => x.name === 'gen')).toMatchObject({ kind: 'function', async: true });
    expect(f.functions.find(x => x.name === 'inNamespace')).toMatchObject({ parent: 'NS' });
    expect(f.functions.find(x => x.name === 'methodInObject')).toMatchObject({ kind: 'method', parent: 'obj' });
    // overload signatures without bodies are not listed; the implementation is
    expect(f.functions.filter(x => x.name === 'overloaded')).toHaveLength(1);
  });

  test('nested TS functions get dotted parent', async () => {
    const nested = path.join(FIXTURES, 'nestfn.ts');
    fs.writeFileSync(nested, 'export function outer() {\n  function inner() {\n    const deep = () => 1;\n  }\n}\n');
    try {
      const f = await fn('nestfn.ts');
      expect(f.functions.find(x => x.name === 'inner')).toMatchObject({ parent: 'outer' });
      expect(f.functions.find(x => x.name === 'deep')).toMatchObject({ parent: 'outer.inner', kind: 'arrow' });
    } finally {
      fs.unlinkSync(nested);
    }
  });

  test('syntax errors flagged on functions too', async () => {
    const f = await fn('broken.ts');
    expect(f.hasErrors).toBe(true);
    expect(f.functions.find(x => x.name === 'good')).toBeDefined();
  });

  test('export default arrow / anonymous function is listed as "default"', async () => {
    const file = path.join(FIXTURES, 'defexp.ts');
    fs.writeFileSync(file, "export default async (req: string): Promise<string> => req;\n");
    const file2 = path.join(FIXTURES, 'defexp2.js');
    fs.writeFileSync(file2, 'export default function () { return 1; }\n');
    try {
      const f = await fn('defexp.ts');
      expect(f.functions).toEqual([
        expect.objectContaining({ name: 'default', kind: 'arrow', async: true, exported: true, returnType: 'Promise<string>' }),
      ]);
      const o = await ov('defexp.ts');
      expect(o.exports).toContain('default');
      expect(o.functions).toEqual([expect.objectContaining({ name: 'default', exported: true })]);

      const f2 = await fn('defexp2.js');
      expect(f2.functions).toEqual([
        expect.objectContaining({ name: 'default', kind: 'function', exported: true }),
      ]);
    } finally {
      fs.unlinkSync(file);
      fs.unlinkSync(file2);
    }
  });

  test('object-literal function properties are listed with parent', async () => {
    const file = path.join(FIXTURES, 'objprops.ts');
    fs.writeFileSync(file, 'const handlers = {\n  onClick: (e: Event) => {},\n  run: function (n: number) { return n; },\n};\n');
    try {
      const f = await fn('objprops.ts');
      expect(f.functions.find(x => x.name === 'onClick')).toMatchObject({ kind: 'arrow', parent: 'handlers' });
      expect(f.functions.find(x => x.name === 'run')).toMatchObject({ kind: 'function', parent: 'handlers' });
    } finally {
      fs.unlinkSync(file);
    }
  });

  test(`params cap at ${LIMITS.maxParams} with truncated flag and … in signature`, async () => {
    const file = path.join(FIXTURES, 'manyparams.ts');
    const n = LIMITS.maxParams + 5;
    const params = Array.from({ length: n }, (_, i) => `p${i}: number`).join(', ');
    fs.writeFileSync(file, `function wide(${params}): void {}\n`);
    try {
      const f = await fn('manyparams.ts');
      const wide = f.functions[0];
      expect(wide.params).toHaveLength(LIMITS.maxParams);
      expect(wide.truncated).toEqual({ params: n });
      expect(wide.signature).toContain('…');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test(`caps at ${LIMITS.maxListEntries} with true total in truncated`, async () => {
    const big = path.join(FIXTURES, 'big.ts');
    const n = LIMITS.maxListEntries + 100;
    fs.writeFileSync(big, Array.from({ length: n }, (_, i) => `function f${i}(): void {}`).join('\n'));
    try {
      const f = await fn('big.ts');
      expect(f.functions).toHaveLength(LIMITS.maxListEntries);
      expect(f.truncated).toEqual({ functions: n });
    } finally {
      fs.unlinkSync(big);
    }
  });
});

// ---- comments ----

describe('comments', () => {
  test('TS: line, doc, markers', async () => {
    const c = await cm('sample.ts');
    expect(c.comments.length).toBeGreaterThanOrEqual(2);
    expect(c.comments.find(x => x.marker === 'TODO')).toMatchObject({ kind: 'line' });
    expect(c.comments.find(x => x.kind === 'doc')).toBeDefined();
    expect(c.comments.find(x => x.marker === 'HACK')).toBeDefined();
  });

  test('JS: line, block, markers', async () => {
    const c = await cm('sample.js');
    expect(c.comments.find(x => x.marker === 'NOTE')).toMatchObject({ kind: 'line' });
    expect(c.comments.find(x => x.marker === 'BUG')).toMatchObject({ kind: 'block' });
    expect(c.comments.find(x => x.marker === 'FIXME')).toBeDefined();
  });

  test('Python: line markers + docstrings', async () => {
    const c = await cm('sample.py');
    expect(c.comments.find(x => x.marker === 'TODO')).toMatchObject({ kind: 'line' });
    expect(c.comments.find(x => x.marker === 'XXX')).toBeDefined();
    expect(c.comments.filter(x => x.kind === 'doc').length).toBeGreaterThanOrEqual(1);
  });

  test('markers are case-sensitive: prose does not false-positive', async () => {
    const prose = path.join(FIXTURES, 'prose.ts');
    fs.writeFileSync(prose, '// note that we fix this elsewhere, todo lists aside\n// TODO: real marker\n');
    try {
      const c = await cm('prose.ts');
      expect(c.comments[0].marker).toBeNull();
      expect(c.comments[1].marker).toBe('TODO');
    } finally {
      fs.unlinkSync(prose);
    }
  });

  test('markersOnly filters to marked comments', async () => {
    const c = await cm('sample.py', true);
    expect(c.comments.length).toBeGreaterThanOrEqual(2);
    expect(c.comments.every(x => x.marker !== null)).toBe(true);
  });

  test('Python: triple-quoted strings outside docstring position are not doc', async () => {
    const f = path.join(FIXTURES, 'strings.py');
    fs.writeFileSync(f, 'def g():\n    """real docstring"""\n    x = 1\n    """not a docstring"""\n    return x\n');
    try {
      const c = await cm('strings.py');
      const docs = c.comments.filter(x => x.kind === 'doc');
      expect(docs).toHaveLength(1);
      expect(docs[0].text).toContain('real docstring');
    } finally {
      fs.unlinkSync(f);
    }
  });

  test(`long comments clip at ${LIMITS.maxCommentChars} chars with textTruncated`, async () => {
    const f = path.join(FIXTURES, 'long.ts');
    fs.writeFileSync(f, `/* ${'x'.repeat(2000)} */\n`);
    try {
      const c = await cm('long.ts');
      expect(c.comments[0].text.length).toBeLessThanOrEqual(LIMITS.maxCommentChars + 1);
      expect(c.comments[0].textTruncated).toBe(true);
    } finally {
      fs.unlinkSync(f);
    }
  });
});

// ---- map ----

describe('map', () => {
  test('walks fixtures dir with per-file structure', async () => {
    const m = (await mapDirectory('.', FIXTURES)) as MapResult;
    expect(m.truncated).toBe(false);
    expect(m.totalSupportedFiles).toBe(m.files.length);
    const ts = m.files.find(f => f.path === 'sample.ts')!;
    expect(ts.language).toBe('typescript');
    expect(ts.classes).toContain('Application');
    expect(ts.functions).toEqual(expect.arrayContaining(['helperFunction', 'processData']));
    const broken = m.files.find(f => f.path === 'broken.ts')!;
    expect(broken.hasErrors).toBe(true);
  });

  test('file path is rejected with a hint', async () => {
    const m = (await mapDirectory('sample.ts', FIXTURES)) as ErrorResult;
    expect(m.error).toContain('not a directory');
    expect(m.hint).toContain('overview');
  });

  test('ignored dirs are skipped', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-map-'));
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'node_modules', 'dep.js'), 'function hidden() {}');
    fs.writeFileSync(path.join(tmp, 'app.js'), 'function visible() {}');
    try {
      const m = (await mapDirectory('.', tmp)) as MapResult;
      expect(m.files.map(f => f.path)).toEqual(['app.js']);
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });
});

// ---- find ----

describe('find', () => {
  test('substring match across fixtures', async () => {
    const r = (await findSymbol('helper', '.', FIXTURES)) as FindResult;
    expect(r.matches.map(m => m.name)).toEqual(expect.arrayContaining(['helperFunction', 'local_helper']));
    expect(r.filesScanned).toBeGreaterThanOrEqual(5);
  });

  test('exact match finds classes too', async () => {
    const r = (await findSymbol('Application', '.', FIXTURES, true)) as FindResult;
    expect(r.matches).toEqual([
      expect.objectContaining({ file: 'sample.ts', name: 'Application', kind: 'class' }),
    ]);
  });

  test('empty name is an error with hint', async () => {
    const r = (await findSymbol('', '.', FIXTURES)) as ErrorResult;
    expect(r.error).toContain('Empty');
    expect(r.hint).toBeDefined();
  });

  test('unsearchable files are listed in skipped, not silently ignored', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-find-'));
    fs.writeFileSync(path.join(tmp, 'ok.ts'), 'export function target(): void {}\n');
    fs.writeFileSync(path.join(tmp, 'toobig.ts'), `// ${'x'.repeat(LIMITS.maxFileBytes + 10)}\nfunction target2() {}\n`);
    try {
      const r = (await findSymbol('target', '.', tmp)) as FindResult;
      expect(r.matches.map(m => m.name)).toEqual(['target']);
      expect(r.filesScanned).toBe(1);
      expect(r.skipped).toEqual([expect.objectContaining({ file: 'toobig.ts', error: expect.stringContaining('too large') })]);
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });
});

// ---- function_body ----

describe('function_body', () => {
  test('returns verbatim source of a named function', async () => {
    const r = (await functionBody('sample.ts', 'helperFunction', FIXTURES)) as FunctionBodyResult;
    expect(r.body).toContain('return a.length > b');
    expect(r.body).toContain('function helperFunction');
    expect(r.kind).toBe('function');
    expect(r.line).toBeGreaterThan(1);
    expect(r.truncated).toBeUndefined();
  });

  test('methods work by bare and dotted-qualified name', async () => {
    const bare = (await functionBody('sample.ts', 'start', FIXTURES)) as FunctionBodyResult;
    expect(bare.body).toContain('Starting...');
    expect(bare.parent).toBe('Application');
    const dotted = (await functionBody('sample.ts', 'Application.start', FIXTURES)) as FunctionBodyResult;
    expect(dotted.body).toBe(bare.body);
  });

  test('Python decorated method body includes the decorator', async () => {
    const r = (await functionBody('sample.py', 'DataProcessor.validate', FIXTURES)) as FunctionBodyResult;
    expect(r.body).toContain('@staticmethod');
    expect(r.body).toContain('def validate');
  });

  test('default export is addressable as "default"', async () => {
    const file = path.join(FIXTURES, 'defbody.ts');
    fs.writeFileSync(file, 'export default (a: number) => a * 2;\n');
    try {
      const r = (await functionBody('defbody.ts', 'default', FIXTURES)) as FunctionBodyResult;
      expect(r.body).toContain('a * 2');
      expect(r.exported).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('ambiguous name fails listing candidates — never guesses', async () => {
    const file = path.join(FIXTURES, 'ambig.ts');
    fs.writeFileSync(file, 'class A { run() { return 1; } }\nclass B { run() { return 2; } }\n');
    try {
      const e = (await functionBody('ambig.ts', 'run', FIXTURES)) as ErrorResult;
      expect(e.error).toContain('Ambiguous');
      expect(e.hint).toContain('A.run');
      expect(e.hint).toContain('B.run');
      // qualified name resolves it
      const r = (await functionBody('ambig.ts', 'B.run', FIXTURES)) as FunctionBodyResult;
      expect(r.body).toContain('return 2');
      // line disambiguator resolves it too
      const r2 = (await functionBody('ambig.ts', 'run', FIXTURES, 1)) as FunctionBodyResult;
      expect(r2.body).toContain('return 1');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('not found suggests similar names', async () => {
    const e = (await functionBody('sample.ts', 'helper', FIXTURES)) as ErrorResult;
    expect(e.error).toContain('not found');
    expect(e.hint).toContain('helperFunction');
  });

  test(`body caps at ${LIMITS.maxBodyChars} chars with true length flagged`, async () => {
    const file = path.join(FIXTURES, 'bigbody.ts');
    fs.writeFileSync(file, `function big() {\n  const s = "${'x'.repeat(LIMITS.maxBodyChars)}";\n}\n`);
    try {
      const r = (await functionBody('bigbody.ts', 'big', FIXTURES)) as FunctionBodyResult;
      expect(r.body.length).toBe(LIMITS.maxBodyChars + 1); // + ellipsis
      expect(r.truncated!.bodyChars).toBeGreaterThan(LIMITS.maxBodyChars);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

// ---- error contract ----

describe('errors', () => {
  test('nonexistent file: error + hint', async () => {
    const e = (await overview('does_not_exist.ts', FIXTURES)) as ErrorResult;
    expect(e.error).toContain('not found');
    expect(e.hint).toBeDefined();
  });

  test('unsupported extension names supported ones', async () => {
    const txt = path.join(FIXTURES, 'dummy.txt');
    fs.writeFileSync(txt, 'hello');
    try {
      const e = (await overview('dummy.txt', FIXTURES)) as ErrorResult;
      expect(e.error).toContain('Unsupported');
      expect(e.hint).toContain('.py');
    } finally {
      fs.unlinkSync(txt);
    }
  });

  test('directory path says so and points at map', async () => {
    const e = (await overview('.', FIXTURES)) as ErrorResult;
    expect(e.error).toContain('directory');
    expect(e.hint).toContain('map');
  });

  test('path escape names the sandbox root and the fix', async () => {
    const e = (await overview('../../../etc/passwd', FIXTURES)) as ErrorResult;
    expect(e.error).toMatch(/escapes/);
    expect(e.error).toContain(FIXTURES);
    expect(e.error).toContain('launch the server');
  });

  test('oversized file is refused honestly', async () => {
    const big = path.join(FIXTURES, 'huge.py');
    fs.writeFileSync(big, '# padding\n'.repeat(220_000)); // > 2MB
    try {
      const e = (await functions('huge.py', FIXTURES)) as ErrorResult;
      expect(e.error).toContain('too large');
      expect(e.error).toContain(String(LIMITS.maxFileBytes));
    } finally {
      fs.unlinkSync(big);
    }
  });
});

describe('validatePath', () => {
  test('rejects symlink pointing outside cwd', () => {
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codelens-'));
    const outside = path.join(os.tmpdir(), 'codelens-outside-target');
    fs.writeFileSync(outside, 'secret');
    const link = path.join(tmpCwd, 'escape.ts');
    fs.symlinkSync(outside, link);
    try {
      expect(() => validatePath('escape.ts', tmpCwd)).toThrow(/escapes.*symlink/s);
    } finally {
      fs.unlinkSync(link);
      fs.unlinkSync(outside);
      fs.rmdirSync(tmpCwd);
    }
  });

  test('absolute path inside cwd is accepted', () => {
    const abs = path.join(FIXTURES, 'sample.ts');
    expect(validatePath(abs, FIXTURES)).toBe(fs.realpathSync(abs));
  });
});
