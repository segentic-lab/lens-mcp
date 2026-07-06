import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  listDocs,
  outline,
  searchDocs,
  links,
  heading,
  serverInfo,
  validatePath,
  resolveRoot,
  parseDoc,
  LIMITS,
  MD_EXTENSIONS,
  type LinksResult,
  type ListDocsResult,
  type OutlineResult,
  type SearchResult,
  type HeadingResult,
  type ErrorResult,
} from '../src/docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures-md');

describe('fenced code blocks (classic false positive)', () => {
  test('outline excludes #-lines inside ```, ~~~, and nested ```` fences', async () => {
    const o = await outline('edge.md', FIXTURES) as OutlineResult;
    const texts = o.headings.map(h => h.text);
    expect(texts).not.toContain('not a heading');
    expect(texts).not.toContain('also not a heading');
    expect(texts).not.toContain('tilde fence heading');
    expect(texts).not.toContain('nested fence heading');
    expect(texts).toContain('Edge Cases');
    expect(texts).toContain('Real Section');
  });

  test('search_docs marks fence lines as inHeading: false', async () => {
    const s = await searchDocs('not a heading', undefined, true, 50, FIXTURES) as SearchResult;
    expect(s.matches.length).toBeGreaterThanOrEqual(2);
    for (const m of s.matches.filter(m => m.path === 'edge.md')) {
      expect(m.inHeading).toBe(false);
    }
  });

  test('heading section spans across fenced blocks without splitting', async () => {
    const h = await heading('edge.md', 'Real Section', FIXTURES) as HeadingResult;
    expect(h.level).toBe(2);
    expect(h.startLine).toBe(10);
    expect(h.content).toContain('tilde fence heading');
    expect(h.content).not.toContain('Setext Title');
  });
});

describe('setext headings', () => {
  test('=== underline is H1, --- underline is H2, line number points at the text', async () => {
    const o = await outline('edge.md', FIXTURES) as OutlineResult;
    const title = o.headings.find(h => h.text === 'Setext Title');
    const subtitle = o.headings.find(h => h.text === 'Setext Subtitle');
    expect(title).toMatchObject({ depth: 1, line: 24 });
    expect(subtitle).toMatchObject({ depth: 2, line: 29 });
  });

  test('thematic break (--- after blank line) and table separators are not headings', async () => {
    const o = await outline('edge.md', FIXTURES) as OutlineResult;
    expect(o.headings.length).toBe(4);
  });

  test('heading() resolves a setext section', async () => {
    const h = await heading('edge.md', 'Setext Subtitle', FIXTURES) as HeadingResult;
    expect(h.level).toBe(2);
    expect(h.content).toContain('Setext body two.');
    expect(h.content).toContain('thematic break');
  });

  test('frontmatter delimiters are not setext underlines', () => {
    const doc = parseDoc('---\ntitle: X\ntags: [a]\n---\n\n# Real\n\nbody\n');
    expect(doc.headings).toEqual([{ depth: 1, text: 'Real', line: 6 }]);
  });
});

describe('CRLF line endings', () => {
  test('outline detects headings in CRLF files', async () => {
    const o = await outline('crlf.md', FIXTURES) as OutlineResult;
    expect(o.headings.map(h => h.text)).toEqual(['CRLF Doc', 'CRLF Section', 'Another Section']);
  });

  test('heading() returns a CRLF section with LF-normalized content', async () => {
    const h = await heading('crlf.md', 'CRLF Section', FIXTURES) as HeadingResult;
    expect(h.startLine).toBe(5);
    expect(h.content).toContain('CRLF body text.');
    expect(h.content).not.toContain('\r');
  });
});

describe('unicode and duplicate headings', () => {
  test('emoji heading found by exact text', async () => {
    const h = await heading('unicode.md', 'Emoji 🚀 Heading', FIXTURES) as HeadingResult;
    expect(h.level).toBe(1);
  });

  test('duplicate headings: first wins, note explains disambiguation', async () => {
    const h = await heading('unicode.md', 'Dup', FIXTURES) as HeadingResult;
    expect(h.startLine).toBe(5);
    expect(h.content).toContain('first duplicate body');
    expect(h.note).toMatch(/2 headings match/);
    expect(h.note).toMatch(/line number/);
  });

  test('line-number ref disambiguates duplicates', async () => {
    const h = await heading('unicode.md', '9', FIXTURES) as HeadingResult;
    expect(h.content).toContain('second duplicate body');
    expect(h.note).toBeUndefined();
  });
});

describe('search_docs caps and query validation', () => {
  test('empty query is rejected with an actionable error', async () => {
    const r = await searchDocs('', undefined, true, 50, FIXTURES) as ErrorResult;
    expect(r.error).toMatch(/empty/i);
    expect(r.error).toMatch(/list_docs/);
  });

  test('whitespace-only query is rejected', async () => {
    const r = await searchDocs('   ', undefined, true, 50, FIXTURES) as ErrorResult;
    expect(r.error).toMatch(/empty/i);
  });

  test('max_results caps output and sets truncated + totalMatches', async () => {
    const all = await searchDocs('e', undefined, true, LIMITS.searchMaxResultsMax, FIXTURES) as SearchResult;
    const capped = await searchDocs('e', undefined, true, 3, FIXTURES) as SearchResult;
    expect(capped.matches.length).toBe(3);
    expect(capped.truncated).toBe(true);
    expect(capped.totalMatches).toBe(all.totalMatches);
    expect(capped.totalMatches).toBeGreaterThan(3);
  });

  test('uncapped result reports truncated: false', async () => {
    const s = await searchDocs('CRLF body text', undefined, true, 50, FIXTURES) as SearchResult;
    expect(s.truncated).toBe(false);
    expect(s.totalMatches).toBe(s.matches.length);
  });

  test('max_results is clamped to the hard ceiling', async () => {
    const s = await searchDocs('e', undefined, true, 10_000, FIXTURES) as SearchResult;
    expect(s.matches.length).toBeLessThanOrEqual(LIMITS.searchMaxResultsMax);
  });

  test('heading matches still rank first under a cap', async () => {
    const s = await searchDocs('section', undefined, true, 5, FIXTURES) as SearchResult;
    expect(s.matches.length).toBeGreaterThan(0);
    expect(s.matches[0].inHeading).toBe(true);
  });
});

describe('extensions', () => {
  test('list_docs picks up .markdown and .mdx alongside .md', async () => {
    const r = await listDocs(undefined, true, FIXTURES) as ListDocsResult;
    const paths = r.docs.map(d => d.path);
    expect(paths).toContain('alt.markdown');
    expect(paths).toContain('alt.mdx');
    expect(MD_EXTENSIONS).toEqual(['.md', '.markdown', '.mdx']);
  });
});

describe('list_docs caps', () => {
  let bigDir: string;

  beforeAll(() => {
    bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docslens-big-'));
    for (let i = 0; i < LIMITS.listDocsMaxDocs + 5; i++) {
      fs.writeFileSync(path.join(bigDir, `doc-${String(i).padStart(3, '0')}.md`), `# Doc ${i}\n\nbody\n`);
    }
    const manyHeadings = ['# Big'];
    for (let i = 0; i < LIMITS.outlinePreviewMaxEntries + 4; i++) manyHeadings.push(`\n## H${i}\n`);
    fs.writeFileSync(path.join(bigDir, 'aaa-many-headings.md'), manyHeadings.join('\n'));
  });

  afterAll(() => {
    fs.rmSync(bigDir, { recursive: true, force: true });
  });

  test('docs list truncates at the cap with truncated + totalDocs', async () => {
    const r = await listDocs(undefined, true, bigDir) as ListDocsResult;
    expect(r.docs.length).toBe(LIMITS.listDocsMaxDocs);
    expect(r.truncated).toBe(true);
    expect(r.totalDocs).toBe(LIMITS.listDocsMaxDocs + 6);
  });

  test('outlinePreview caps per doc with outlinePreviewTruncated flag', async () => {
    const r = await listDocs(undefined, true, bigDir) as ListDocsResult;
    const many = r.docs.find(d => d.path === 'aaa-many-headings.md')!;
    expect(many.outlinePreview.length).toBe(LIMITS.outlinePreviewMaxEntries);
    expect(many.outlinePreviewTruncated).toBe(true);
    const small = r.docs.find(d => d.path === 'doc-000.md')!;
    expect(small.outlinePreviewTruncated).toBeUndefined();
  });
});

describe('huge file', () => {
  let hugeDir: string;

  beforeAll(() => {
    hugeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docslens-huge-'));
    const parts: string[] = ['# Huge Doc', ''];
    for (let s = 0; s < 100; s++) {
      parts.push(`## Section ${s}`, '');
      for (let l = 0; l < 500; l++) parts.push(`line ${s}-${l} filler text`);
      parts.push('');
    }
    fs.writeFileSync(path.join(hugeDir, 'huge.md'), parts.join('\n'));
  });

  afterAll(() => {
    fs.rmSync(hugeDir, { recursive: true, force: true });
  });

  test('outline and heading() handle a ~50k-line file', async () => {
    const o = await outline('huge.md', hugeDir) as OutlineResult;
    expect(o.headings.length).toBe(101);
    expect(o.totalLines).toBeGreaterThan(50_000);
    const h = await heading('huge.md', 'Section 42', hugeDir) as HeadingResult;
    expect(h.content).toContain('line 42-0 filler text');
    expect(h.content).not.toContain('Section 43');
  });
});

describe('errors name cause AND fix', () => {
  test('path escape names the working directory and server_info', () => {
    try {
      validatePath('../outside.md', FIXTURES);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain(`working directory is ${FIXTURES}`);
      expect((e as Error).message).toContain('server_info');
    }
  });

  test('heading not found points to outline() and heading count', async () => {
    const r = await heading('README.md', 'No Such Heading', FIXTURES) as ErrorResult;
    expect(r.error).toContain('outline("README.md")');
    expect(r.error).toMatch(/\d+ headings/);
  });

  test('file not found points to list_docs()', async () => {
    const r = await outline('missing.md', FIXTURES) as ErrorResult;
    expect(r.error).toContain('list_docs()');
    expect(r.error).toContain(FIXTURES);
  });

  test('no-headings file explains and gives the file length', async () => {
    const r = await heading('no-heading.md', 'anything', FIXTURES) as ErrorResult;
    expect(r.error).toMatch(/no markdown headings/);
    expect(r.error).toMatch(/\d+ lines/);
  });

  test('list_docs on a file suggests outline()', async () => {
    const r = await listDocs('README.md', true, FIXTURES) as ErrorResult;
    expect(r.error).toContain('Not a directory');
    expect(r.error).toContain('outline("README.md")');
  });
});

describe('symlinks', () => {
  let realDir: string;
  let linkCwd: string;
  let outsideDir: string;

  beforeAll(() => {
    realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docslens-real-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docslens-outside-'));
    fs.writeFileSync(path.join(realDir, 'inside.md'), '# Inside\n\nbody\n');
    fs.mkdirSync(path.join(realDir, 'sub'));
    fs.writeFileSync(path.join(realDir, 'sub', 'nested.md'), '# Nested\n\nbody\n');
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), '# Secret\n\nout of bounds\n');
    // cwd reached through a symlink (bind mounts, ~/dev -> /mnt/... checkouts)
    linkCwd = path.join(os.tmpdir(), `docslens-cwdlink-${process.pid}`);
    fs.symlinkSync(realDir, linkCwd);
    // symlinked doc + dir inside the tree, and links pointing outside
    fs.symlinkSync(path.join(realDir, 'inside.md'), path.join(realDir, 'linked-doc.md'));
    fs.symlinkSync(path.join(realDir, 'sub'), path.join(realDir, 'linked-dir'));
    fs.symlinkSync(path.join(outsideDir, 'secret.md'), path.join(realDir, 'escape-doc.md'));
    fs.symlinkSync(outsideDir, path.join(realDir, 'escape-dir'));
  });

  afterAll(() => {
    fs.unlinkSync(linkCwd);
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  test('a cwd reached through a symlink accepts its own files (containerized deployments)', async () => {
    expect(() => validatePath('inside.md', linkCwd)).not.toThrow();
    const o = await outline('inside.md', linkCwd) as OutlineResult;
    expect(o.headings[0].text).toBe('Inside');
    expect(resolveRoot(linkCwd)).toBe(fs.realpathSync(realDir));
  });

  test('symlinked docs and dirs inside the sandbox are visible to list_docs', async () => {
    const r = await listDocs(undefined, true, realDir) as ListDocsResult;
    const paths = r.docs.map(d => d.path);
    expect(paths).toContain('linked-doc.md');
    expect(paths).toContain(path.join('linked-dir', 'nested.md'));
  });

  test('symlinks pointing outside the sandbox stay invisible to list_docs and search', async () => {
    const r = await listDocs(undefined, true, realDir) as ListDocsResult;
    const paths = r.docs.map(d => d.path);
    expect(paths).not.toContain('escape-doc.md');
    expect(paths.some(p => p.startsWith('escape-dir'))).toBe(false);
    const s = await searchDocs('out of bounds', undefined, true, 50, realDir) as SearchResult;
    expect(s.totalMatches).toBe(0);
  });

  test('symlink cycles do not hang the walker', async () => {
    const cycleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docslens-cycle-'));
    try {
      fs.writeFileSync(path.join(cycleDir, 'doc.md'), '# Doc\n');
      fs.symlinkSync(cycleDir, path.join(cycleDir, 'self'));
      const r = await listDocs(undefined, true, cycleDir) as ListDocsResult;
      expect(r.docs.map(d => d.path)).toEqual(['doc.md']);
    } finally {
      fs.rmSync(cycleDir, { recursive: true, force: true });
    }
  });
});

describe('outline and links caps', () => {
  let capDir: string;

  beforeAll(() => {
    capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docslens-caps-'));
    const headingLines: string[] = [];
    for (let i = 0; i < LIMITS.outlineMaxHeadings + 10; i++) headingLines.push(`## H${i}`, '');
    fs.writeFileSync(path.join(capDir, 'many-headings.md'), headingLines.join('\n'));
    const linkLines: string[] = ['# Links', ''];
    for (let i = 0; i < LIMITS.linksMaxEntries + 10; i++) linkLines.push(`[link ${i}](https://example.com/${i})`);
    fs.writeFileSync(path.join(capDir, 'many-links.md'), linkLines.join('\n'));
  });

  afterAll(() => {
    fs.rmSync(capDir, { recursive: true, force: true });
  });

  test('outline caps headings with truncated + totalHeadings', async () => {
    const o = await outline('many-headings.md', capDir) as OutlineResult;
    expect(o.headings.length).toBe(LIMITS.outlineMaxHeadings);
    expect(o.truncated).toBe(true);
    expect(o.totalHeadings).toBe(LIMITS.outlineMaxHeadings + 10);
  });

  test('links caps entries with truncated + totalLinks', async () => {
    const l = await links('many-links.md', capDir) as LinksResult;
    expect(l.links.length).toBe(LIMITS.linksMaxEntries);
    expect(l.truncated).toBe(true);
    expect(l.totalLinks).toBe(LIMITS.linksMaxEntries + 10);
  });

  test('uncapped outline/links report truncated: false', async () => {
    const o = await outline('edge.md', FIXTURES) as OutlineResult;
    expect(o.truncated).toBe(false);
    expect(o.totalHeadings).toBe(o.headings.length);
    const l = await links(path.join('docs', 'api.md'), FIXTURES) as LinksResult;
    expect(l.truncated).toBe(false);
    expect(l.totalLinks).toBe(l.links.length);
  });
});

describe('docs-only contract (non-markdown files rejected)', () => {
  test.each(['Dockerfile', 'server.py', 'notes.txt'])('outline/heading/links reject %s', async (p) => {
    const o = await outline(p, FIXTURES) as ErrorResult;
    const h = await heading(p, 'anything', FIXTURES) as ErrorResult;
    const l = await links(p, FIXTURES) as ErrorResult;
    for (const r of [o, h, l]) {
      expect(r.error).toContain('Not a markdown file');
      expect(r.error).toContain('.md/.markdown/.mdx');
    }
  });
});

describe('links: badges, references, fences', () => {
  test('badge [![alt](img)](url) yields the image AND the outer link', async () => {
    const l = await links('links.md', FIXTURES) as LinksResult;
    const img = l.links.find(lk => lk.type === 'image' && lk.target === 'https://img.shields.io/badge.svg');
    const outer = l.links.find(lk => lk.type === 'markdown' && lk.target === 'https://ci.example.com/run');
    expect(img).toMatchObject({ text: 'build badge', line: 3 });
    expect(outer).toMatchObject({ text: 'build badge', line: 3 });
  });

  test('lone images are type image, not markdown', async () => {
    const l = await links('links.md', FIXTURES) as LinksResult;
    const lone = l.links.find(lk => lk.target === 'assets/pic.png');
    expect(lone?.type).toBe('image');
  });

  test('reference targets resolve via [id]: url definitions (incl. collapsed [text][])', async () => {
    const l = await links('links.md', FIXTURES) as LinksResult;
    expect(l.links.find(lk => lk.text === 'the spec')?.target).toBe('https://spec.example.org');
    expect(l.links.find(lk => lk.text === 'collapsed')?.target).toBe('https://collapsed.example.org');
    const api = await links(path.join('docs', 'api.md'), FIXTURES) as LinksResult;
    expect(api.links.find(lk => lk.text === 'RFC Spec')?.target).toBe('https://example.com/rfc');
  });

  test('links inside fenced code blocks and definition lines are not links', async () => {
    const l = await links('links.md', FIXTURES) as LinksResult;
    expect(l.links.some(lk => lk.target === 'https://example.com/fenced')).toBe(false);
    expect(l.links.filter(lk => lk.line >= 13).length).toBe(0);
  });
});

describe('heading: any line resolves to its enclosing section', () => {
  test('content line from a search hit resolves with an explanatory note', async () => {
    const h = await heading('unicode.md', '7', FIXTURES) as HeadingResult;
    expect(h.heading).toBe('Dup');
    expect(h.startLine).toBe(5);
    expect(h.note).toContain('Line 7 is not a heading');
    expect(h.note).toContain('enclosing section "Dup" (line 5)');
  });

  test('out-of-range line errors with the file length', async () => {
    const r = await heading('unicode.md', '999', FIXTURES) as ErrorResult;
    expect(r.error).toContain('out of range');
    expect(r.error).toMatch(/has \d+ lines/);
  });

  test('line before the first heading errors with the first heading location', async () => {
    const r = await heading('frontmatter.md', '2', FIXTURES) as ErrorResult;
    expect(r.error).toContain('precedes the first heading');
  });
});

describe('totalLines matches editor line count', () => {
  test('trailing newline does not inflate; empty file is 0 lines', async () => {
    const crlf = await outline('crlf.md', FIXTURES) as OutlineResult;
    expect(crlf.totalLines).toBe(11);
    const empty = await outline('empty.md', FIXTURES) as OutlineResult;
    expect(empty.totalLines).toBe(0);
  });
});

describe('search_docs zero-match hint', () => {
  test('zero matches include a how-to-proceed hint', async () => {
    const s = await searchDocs('zebra-quantum-xylophone', undefined, true, 50, FIXTURES) as SearchResult;
    expect(s.totalMatches).toBe(0);
    expect(s.hint).toContain('list_docs()');
  });

  test('non-zero matches carry no hint', async () => {
    const s = await searchDocs('configuration', undefined, true, 50, FIXTURES) as SearchResult;
    expect(s.hint).toBeUndefined();
  });
});

describe('cache directories are ignored', () => {
  const cacheDir = path.join(FIXTURES, '.pytest_cache');

  beforeAll(() => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'README.md'), '# pytest cache noise\n');
  });

  afterAll(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  test('.pytest_cache docs are excluded from list_docs and search', async () => {
    const r = await listDocs(undefined, true, FIXTURES) as ListDocsResult;
    expect(r.docs.some(d => d.path.includes('.pytest_cache'))).toBe(false);
    const s = await searchDocs('pytest cache noise', undefined, true, 50, FIXTURES) as SearchResult;
    expect(s.totalMatches).toBe(0);
  });
});

describe('summaries skip HTML comments', () => {
  test('leading multi-line comment is not the summary; inline comments are stripped', async () => {
    const r = await listDocs(undefined, true, FIXTURES) as ListDocsResult;
    const doc = r.docs.find(d => d.path === 'comment.md')!;
    expect(doc.title).toBe('Commented Doc');
    expect(doc.summary).toBe('The real first paragraph survives inline comments.');
  });
});

describe('server_info', () => {
  test('reports root, extensions, and all limits', () => {
    const info = serverInfo('docslens-mcp', '0.2.0', FIXTURES);
    expect(info.workingDirectory).toBe(FIXTURES);
    expect(info.pathContract).toContain(FIXTURES);
    expect(info.extensions).toEqual(['.md', '.markdown', '.mdx']);
    expect(info.limits).toEqual(LIMITS);
  });
});
