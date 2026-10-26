import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const readmes = ['README.md', 'README.pt-BR.md'];
const documents = [
  ...readmes,
  ...['ARCHITECTURE', 'DESIGN', 'RELEASING', 'SMOKE', 'INTEGRATION'].flatMap(name =>
    [`docs/${name}.md`, `docs/${name}.pt-BR.md`]),
];

for (const document of documents) {
  test(`${document}: relative Markdown links exist`, () => {
    const file = resolve(root, document);
    // Ignore command examples and inline code, which can contain Markdown syntax.
    const markdown = readFileSync(file, 'utf8')
      .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
      .replace(/`[^`\n]*`/g, '');
    const targets = [
      ...Array.from(markdown.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g), match => match[1]),
      ...Array.from(markdown.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm), match => match[1]),
    ];
    assert.ok(targets.length > 0, `${document}: no links found`);
    for (const target of targets) {
      const href = target.replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
      const path = decodeURIComponent(href.split(/[?#]/, 1)[0]);
      assert.ok(existsSync(resolve(dirname(file), path)), `${document}: missing ${href}`);
    }
  });
}

for (const [index, readme] of readmes.entries()) {
  test(`${readme}: banner at the top with localized alt text`, () => {
    const markdown = readFileSync(resolve(root, readme), 'utf8');
    const banner = markdown.match(/^# [^\n]+\n\s*\n!\[([^\]\n]+)\]\(docs\/art\/banner\.svg\)/);
    assert.ok(banner, 'expected banner immediately after the heading');
    assert.match(banner[1], index === 0 ? /director's chair/ : /cadeira de diretor/);
  });
}

test('banner is a compact self-contained SVG', () => {
  const bytes = readFileSync(resolve(root, 'docs/art/banner.svg'));
  const svg = bytes.toString('utf8');
  assert.ok(bytes.length < 100_000, `banner is ${bytes.length} bytes`);
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const content = svg.replace(/\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
  assert.doesNotMatch(content, /https?:/i);
  assert.doesNotMatch(content, /<\s*(?:[\w.-]+:)?(?:script|image|foreignObject)\b/i);
  assert.doesNotMatch(content, /\b(?:[\w.-]+:)?href\s*=|\bon\w+\s*=|<!DOCTYPE|<!ENTITY/i);
  assert.doesNotMatch(content, /url\(\s*["']?(?!#)/i);
});
