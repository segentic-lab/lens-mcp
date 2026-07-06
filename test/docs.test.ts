import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  listDocs,
  outline,
  searchDocs,
  links,
  heading,
  validatePath,
  LIMITS,
  type ListDocsResult,
  type OutlineResult,
  type SearchResult,
  type LinksResult,
  type HeadingResult,
  type ErrorResult,
} from '../src/docs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures-md');

// ---- Table-driven test cases ----

type ToolName = 'listDocs' | 'listDocsNonRecursive' | 'outline' | 'searchDocs' | 'links' | 'heading';

type AnyResult = ListDocsResult | OutlineResult | SearchResult | LinksResult | HeadingResult | ErrorResult;

interface TestCase {
  desc: string;
  tool: ToolName;
  arg: string;
  check: (result: AnyResult) => void;
}

const toolFn: Record<ToolName, (arg: string) => Promise<AnyResult>> = {
  listDocs: (_arg: string) => listDocs(undefined, true, FIXTURES),
  listDocsNonRecursive: (_arg: string) => listDocs(undefined, false, FIXTURES),
  outline: (f: string) => outline(f, FIXTURES),
  searchDocs: (q: string) => searchDocs(q, undefined, true, LIMITS.searchMaxResultsDefault, FIXTURES),
  links: (f: string) => links(f, FIXTURES),
  heading: (arg: string) => {
    const [file, ...rest] = arg.split('::');
    return heading(file, rest.join('::'), FIXTURES);
  },
};

const cases: TestCase[] = [
  // ---- list_docs ----
  {
    desc: 'list_docs recursive finds all .md files in tree',
    tool: 'listDocs',
    arg: '',
    check(r) {
      const ld = r as ListDocsResult;
      expect(ld.docs.length).toBeGreaterThanOrEqual(6);
      const paths = ld.docs.map(d => d.path);
      expect(paths).toEqual(expect.arrayContaining([
        'README.md',
        expect.stringContaining('guide.md'),
        expect.stringContaining('api.md'),
        expect.stringContaining('spec.md'),
      ]));
    },
  },
  {
    desc: 'list_docs non-recursive returns only top-level .md files',
    tool: 'listDocsNonRecursive',
    arg: '',
    check(r) {
      const ld = r as ListDocsResult;
      const paths = ld.docs.map(d => d.path);
      expect(paths).toContain('README.md');
      expect(paths).toContain('empty.md');
      expect(paths).not.toEqual(
        expect.arrayContaining([expect.stringContaining('guide.md')]),
      );
    },
  },
  {
    desc: 'list_docs extracts title from first H1',
    tool: 'listDocs',
    arg: '',
    check(r) {
      const ld = r as ListDocsResult;
      const readme = ld.docs.find(d => d.path === 'README.md');
      expect(readme).toBeDefined();
      expect(readme!.title).toBe('Project README');
    },
  },
  {
    desc: 'list_docs extracts summary from first paragraph',
    tool: 'listDocs',
    arg: '',
    check(r) {
      const ld = r as ListDocsResult;
      const readme = ld.docs.find(d => d.path === 'README.md');
      expect(readme).toBeDefined();
      expect(readme!.summary).toContain('main README');
    },
  },
  {
    desc: 'list_docs includes outlinePreview with H1/H2 only',
    tool: 'listDocs',
    arg: '',
    check(r) {
      const ld = r as ListDocsResult;
      const readme = ld.docs.find(d => d.path === 'README.md');
      expect(readme).toBeDefined();
      expect(readme!.outlinePreview.length).toBeGreaterThanOrEqual(3);
      for (const h of readme!.outlinePreview) {
        expect(h.depth).toBeLessThanOrEqual(2);
      }
    },
  },
  {
    desc: 'list_docs handles file with no headings (null title)',
    tool: 'listDocs',
    arg: '',
    check(r) {
      const ld = r as ListDocsResult;
      const noH = ld.docs.find(d => d.path === 'no-heading.md');
      expect(noH).toBeDefined();
      expect(noH!.title).toBeNull();
      expect(noH!.headingCount).toBe(0);
    },
  },
  {
    desc: 'list_docs handles empty file',
    tool: 'listDocs',
    arg: '',
    check(r) {
      const ld = r as ListDocsResult;
      const empty = ld.docs.find(d => d.path === 'empty.md');
      expect(empty).toBeDefined();
      expect(empty!.title).toBeNull();
      expect(empty!.summary).toBeNull();
      expect(empty!.headingCount).toBe(0);
    },
  },

  // ---- outline ----
  {
    desc: 'outline returns heading hierarchy with line numbers',
    tool: 'outline',
    arg: 'README.md',
    check(r) {
      const o = r as OutlineResult;
      expect(o.headings.length).toBe(4);
      expect(o.headings[0]).toMatchObject({ depth: 1, text: 'Project README' });
      expect(o.headings[1]).toMatchObject({ depth: 2, text: 'Installation' });
      for (const h of o.headings) {
        expect(h.line).toBeGreaterThanOrEqual(1);
      }
    },
  },
  {
    desc: 'outline handles deep heading hierarchy (H1-H4)',
    tool: 'outline',
    arg: path.join('nested', 'deep', 'spec.md'),
    check(r) {
      const o = r as OutlineResult;
      const depths = o.headings.map(h => h.depth);
      expect(depths).toContain(1);
      expect(depths).toContain(2);
      expect(depths).toContain(3);
      expect(depths).toContain(4);
    },
  },
  {
    desc: 'outline returns totalLines count',
    tool: 'outline',
    arg: 'README.md',
    check(r) {
      const o = r as OutlineResult;
      expect(o.totalLines).toBeGreaterThan(5);
    },
  },

  // ---- search_docs ----
  {
    desc: 'search_docs finds matches across files (case-insensitive)',
    tool: 'searchDocs',
    arg: 'configuration',
    check(r) {
      const s = r as SearchResult;
      expect(s.matches.length).toBeGreaterThanOrEqual(2);
      const matchPaths = s.matches.map(m => m.path);
      expect(matchPaths).toEqual(expect.arrayContaining([
        expect.stringContaining('guide.md'),
      ]));
    },
  },
  {
    desc: 'search_docs ranks heading matches first',
    tool: 'searchDocs',
    arg: 'configuration',
    check(r) {
      const s = r as SearchResult;
      const headingMatches = s.matches.filter(m => m.inHeading);
      const bodyMatches = s.matches.filter(m => !m.inHeading);
      if (headingMatches.length > 0 && bodyMatches.length > 0) {
        const lastHeadingIdx = s.matches.lastIndexOf(headingMatches[headingMatches.length - 1]);
        const firstBodyIdx = s.matches.indexOf(bodyMatches[0]);
        expect(lastHeadingIdx).toBeLessThan(firstBodyIdx);
      }
    },
  },

  // ---- links ----
  {
    desc: 'links extracts markdown links, wikilinks, autolinks, and references',
    tool: 'links',
    arg: path.join('docs', 'api.md'),
    check(r) {
      const l = r as LinksResult;
      const types = l.links.map(lk => lk.type);
      expect(types).toContain('markdown');
      expect(types).toContain('wikilink');
      expect(types).toContain('autolink');
      expect(types).toContain('reference');
      const guideLink = l.links.find(lk => lk.target === 'guide.md' && lk.type === 'markdown');
      expect(guideLink).toBeDefined();
      const wikiLink = l.links.find(lk => lk.target === 'getting-started-guide');
      expect(wikiLink).toBeDefined();
    },
  },

  // ---- heading ----
  {
    desc: '## section includes ### subsections, stops at next ##',
    tool: 'heading',
    arg: `${path.join('nested', 'deep', 'spec.md')}::Requirements`,
    check(r) {
      const h = r as HeadingResult;
      expect(h.heading).toBe('Requirements');
      expect(h.level).toBe(2);
      expect(h.content).toContain('## Requirements');
      expect(h.content).toContain('### Functional Requirements');
      expect(h.content).toContain('### Non-Functional Requirements');
      expect(h.content).not.toContain('## Architecture');
    },
  },
  {
    desc: '### section stops at next ### of same level',
    tool: 'heading',
    arg: `${path.join('nested', 'deep', 'spec.md')}::Functional Requirements`,
    check(r) {
      const h = r as HeadingResult;
      expect(h.heading).toBe('Functional Requirements');
      expect(h.level).toBe(3);
      expect(h.content).toContain('concurrent connections');
      expect(h.content).not.toContain('Non-Functional');
    },
  },
  {
    desc: 'last section in file (endLine = EOF)',
    tool: 'heading',
    arg: `${path.join('nested', 'deep', 'spec.md')}::Architecture`,
    check(r) {
      const h = r as HeadingResult;
      expect(h.heading).toBe('Architecture');
      expect(h.level).toBe(2);
      expect(h.content).toContain('### Components');
      expect(h.content).toContain('#### Frontend');
      expect(h.content).toContain('#### Backend');
      expect(h.content).toContain('Express framework');
      expect(h.endLine).toBe(27);
    },
  },
  {
    desc: 'ref by slug matches (kebab-case)',
    tool: 'heading',
    arg: `README.md::advanced-usage`,
    check(r) {
      const h = r as HeadingResult;
      expect(h.heading).toBe('Advanced Usage');
      expect(h.level).toBe(3);
      expect(h.content).toContain('environment variables');
    },
  },
  {
    desc: 'ref by exact text matches',
    tool: 'heading',
    arg: `README.md::Advanced Usage`,
    check(r) {
      const h = r as HeadingResult;
      expect(h.heading).toBe('Advanced Usage');
      expect(h.level).toBe(3);
    },
  },
  {
    desc: 'ref by line number',
    tool: 'heading',
    arg: `README.md::5`,
    check(r) {
      const h = r as HeadingResult;
      expect(h.heading).toBe('Installation');
      expect(h.level).toBe(2);
      expect(h.startLine).toBe(5);
    },
  },
  {
    desc: 'heading not found returns error',
    tool: 'heading',
    arg: `README.md::Nonexistent Section`,
    check(r) {
      const e = r as ErrorResult;
      expect(e).toHaveProperty('error');
      expect(e.error).toContain('Heading not found');
    },
  },
  {
    desc: 'path-guard rejection',
    tool: 'heading',
    arg: `../../../etc/passwd::root`,
    check(r) {
      const e = r as ErrorResult;
      expect(e).toHaveProperty('error');
      expect(e.error).toContain('escapes');
    },
  },

  // ---- error paths ----
  {
    desc: 'outline: nonexistent file returns error',
    tool: 'outline',
    arg: 'does_not_exist.md',
    check(r) {
      const e = r as ErrorResult;
      expect(e).toHaveProperty('error');
      expect(e.error).toContain('not found');
    },
  },
];

describe('docs-lens tools (table-driven)', () => {
  test.each(cases)('$tool($arg): $desc', async ({ tool, arg, check }) => {
    const result = await toolFn[tool](arg);
    check(result);
  });
});

// ---- Additional standalone tests ----

describe('validatePath', () => {
  test('rejects path traversal escape', () => {
    expect(() => validatePath('../../../etc/passwd', FIXTURES)).toThrow(/escapes?/i);
  });

  test('rejects symlink pointing outside cwd', () => {
    const os = require('node:os');
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docslens-'));
    const outside = path.join(os.tmpdir(), 'docslens-outside-target');
    fs.writeFileSync(outside, 'secret');
    const link = path.join(tmpCwd, 'escape.md');
    fs.symlinkSync(outside, link);
    try {
      expect(() => validatePath('escape.md', tmpCwd)).toThrow(/escapes?.*symlink/i);
    } finally {
      fs.unlinkSync(link);
      fs.unlinkSync(outside);
      fs.rmdirSync(tmpCwd);
    }
  });
});

describe('list_docs ignores node_modules', () => {
  const nmDir = path.join(FIXTURES, 'node_modules', 'pkg');
  const nmFile = path.join(nmDir, 'README.md');

  beforeAll(() => {
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(nmFile, '# Should Be Ignored\n');
  });

  afterAll(() => {
    fs.unlinkSync(nmFile);
    fs.rmdirSync(path.join(FIXTURES, 'node_modules', 'pkg'));
    fs.rmdirSync(path.join(FIXTURES, 'node_modules'));
  });

  test('node_modules .md files are excluded from results', async () => {
    const result = await listDocs(undefined, true, FIXTURES) as ListDocsResult;
    const paths = result.docs.map(d => d.path);
    for (const p of paths) {
      expect(p).not.toContain('node_modules');
    }
  });
});

describe('frontmatter handling', () => {
  test('summary skips YAML frontmatter', async () => {
    const result = await listDocs(undefined, true, FIXTURES) as ListDocsResult;
    const fm = result.docs.find(d => d.path === 'frontmatter.md');
    expect(fm).toBeDefined();
    expect(fm!.title).toBe('Document With Frontmatter');
    expect(fm!.summary).toContain('first paragraph after frontmatter');
    expect(fm!.summary).not.toContain('tags');
  });
});
