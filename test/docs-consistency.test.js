import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TOOL_NAMES } from '../src/mcp/tools.js';
import { INSTALL_CHECKS } from '../src/smoke/checks-install.js';
import { FEATURE_CHECKS } from '../src/smoke/checks-features.js';
import { UNINSTALL_CHECKS } from '../src/smoke/checks-uninstall.js';
import { SCENARIO } from '../src/smoke/scenario.js';
import { DEFAULT_CONFIG } from '../src/profiles.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(resolve(root, file), 'utf8');
const pairs = ['README', 'INSTALL', 'docs/maintainers/ARCHITECTURE', 'docs/maintainers/DESIGN',
  'docs/maintainers/RELEASING', 'docs/maintainers/SMOKE', 'docs/maintainers/INTEGRATION', 'docs/maintainers/DEMO', 'docs/maintainers/README'];
const guidePairs = (await readdir(resolve(root, 'docs/guide')))
  .filter(name => name.endsWith('.md') && !name.endsWith('.pt-BR.md'))
  .map(name => `docs/guide/${name.slice(0, -3)}`);
pairs.push(...guidePairs);
const componentPairs = (await readdir(resolve(root, 'docs/components')))
  .filter(name => name.endsWith('.md') && !name.endsWith('.pt-BR.md'))
  .map(name => `docs/components/${name.slice(0, -3)}`);
pairs.push(...componentPairs);
const files = pairs.flatMap((base) => [`${base}.md`, `${base}.pt-BR.md`]);
files.push('CONTRIBUTING.md', 'SECURITY.md');
for (const [folder, leaf] of [['adapters', 'README.md'], ['skills', 'SKILL.md']]) {
  for (const entry of await readdir(resolve(root, folder), { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(`${folder}/${entry.name}/${leaf}`);
  }
}
const prose = (text) => text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
const headings = (text) => [...prose(text).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const slug = (text) => text.toLowerCase().replace(/<[^>]*>/g, '')
  .replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');

test('documented tool, check and pair counts match the source', async () => {
  for (const suffix of ['', '.pt-BR']) {
    const index = `docs/components/README${suffix}.md`;
    assert.ok((await read(`README${suffix}.md`)).includes(`](${index})`), 'home links to component index');
    assert.ok((await read(`docs/guide/README${suffix}.md`))
      .includes(`](../components/README${suffix}.md)`), 'guide links to component index');
    const tools = await read(`docs/components/mcp-tools${suffix}.md`);
    assert.equal(Number(tools.match(/(?:exposes|expõe) (\d+) (?:tools|ferramentas)/)?.[1]), TOOL_NAMES.length);
    for (const name of TOOL_NAMES) assert.ok(tools.includes(`\`${name}\``), name);
    const guide = await read(`docs/guide/smoke-demo${suffix}.md`);
    assert.equal(Number(guide.match(/passed: (\d+) failed: 0 skipped: 0/)?.[1]),
      INSTALL_CHECKS.length + FEATURE_CHECKS.length + UNINSTALL_CHECKS.length);
    assert.equal(Number(guide.match(/(?:has|tem) (\d+) (?:scenario checks|verificações de cenário)/)?.[1]), SCENARIO.length);
  }
  assert.match(await read('docs/maintainers/RELEASING.md'), /nine client × system payloads.*eighteen separately identified artifacts/);
  assert.match(await read('docs/maintainers/RELEASING.pt-BR.md'), /nove cargas cliente × sistema.*dezoito artefatos identificados separadamente/);
  assert.equal(DEFAULT_CONFIG.release.clients.length * DEFAULT_CONFIG.release.systems.length, 9);
  assert.equal(DEFAULT_CONFIG.release.clients.length * DEFAULT_CONFIG.release.systems.length
    * DEFAULT_CONFIG.release.architectures.length, 18);
});

test('every file name template in the docs carries the architecture', async () => {
  const entries = await readdir(resolve(root, 'docs'), { withFileTypes: true, recursive: true });
  const files = ['README.md', 'README.pt-BR.md', 'INSTALL.md', 'INSTALL.pt-BR.md',
    ...entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => resolve(entry.parentPath, entry.name))];
  let seen = 0;
  for (const file of files) {
    for (const match of (await readFile(resolve(root, file), 'utf8')).matchAll(/<P>-<V>-<C>-<S>(-<A>)?/g)) {
      seen += 1;
      assert.ok(match[1], `${file}: "${match[0]}" lacks -<A>`);
    }
  }
  assert.ok(seen >= 6, 'the templates of both RELEASING files were found');
});

test('the six supported system/architecture pairs are listed in the install and release docs, in both languages', async () => {
  const pairs = ['linux/x64', 'linux/arm64', 'macos/x64', 'macos/arm64', 'windows/x64', 'windows/arm64'];
  for (const suffix of ['', '.pt-BR']) {
    for (const file of [`INSTALL${suffix}.md`, `docs/maintainers/RELEASING${suffix}.md`]) {
      const text = await read(file);
      for (const pair of pairs) assert.ok(text.includes(pair), `${file}: ${pair}`);
    }
  }
});

test('environment command, tool, skill and shared module are documented in both languages', async () => {
  for (const file of ['docs/guide/troubleshooting.md', 'docs/guide/troubleshooting.pt-BR.md']) {
    const text = await read(file);
    for (const term of ['okit-plugin env report', 'env_report', 'okit-environment']) {
      assert.ok(text.includes(term), `${file}: ${term}`);
    }
  }
  for (const file of ['docs/maintainers/ARCHITECTURE.md', 'docs/maintainers/ARCHITECTURE.pt-BR.md']) {
    assert.ok((await read(file)).includes('src/env/report.js'), file);
  }
});

function anchors(text) {
  const seen = new Map();
  const content = prose(text);
  return new Set([...content.matchAll(/^#{1,6} (.+?)(?: +#+)?$/gm)].map((m) => {
    const base = slug(m[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  }).concat([...content.matchAll(/<a\s+id=["']([^"']+)["']\s*>/gi)].map((m) => m[1])));
}

test('heading parser accepts real anchors and refuses missing or fenced headings', () => {
  const text = '## Configuração\n## Configuração\n<a id="legacy-anchor"></a>\n```md\n## Hidden\n<a id="hidden-anchor"></a>\n```\n';
  assert.deepEqual(headings(text), ['Configuração', 'Configuração']);
  const ids = anchors(text);
  for (const id of ['configuração', 'configuração-1', 'legacy-anchor']) assert.ok(ids.has(id));
  for (const id of ['missing', 'hidden', 'configuração-2', 'hidden-anchor']) assert.ok(!ids.has(id));
});

test('scoped Markdown relative links and anchors resolve', async () => {
  for (const file of files) {
    const text = prose(await read(file));
    for (const match of text.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      const [path, fragment] = href.split('#');
      const target = resolve(root, dirname(file), decodeURIComponent(path.split('?')[0] || ''));
      const destination = path ? target : resolve(root, file);
      assert.ok((await stat(destination)).isFile(), `${file}: ${href}`);
      if (fragment) assert.ok(anchors(await readFile(destination, 'utf8'))
        .has(decodeURIComponent(fragment)), `${file}: missing anchor ${href}`);
    }
  }
});

test('English and Brazilian Portuguese keep the same ordered level-two headings', async () => {
  for (const base of pairs) {
    if (base === 'docs/maintainers/README' || base === 'README' || guidePairs.includes(base) || componentPairs.includes(base)) {
      const ids = (text) => [...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]);
      assert.deepEqual(ids(await read(`${base}.md`)), ids(await read(`${base}.pt-BR.md`)), base);
      assert.equal(headings(await read(`${base}.md`)).length, headings(await read(`${base}.pt-BR.md`)).length, base);
      continue;
    }
    // D34/D36 owns the publisher section, including its existing translated title.
    const canonical = (title) => title === 'Publishing — Publicação' ? 'Publishing'
      : title === 'Índice' ? 'Contents' : title;
    assert.deepEqual(headings(await read(`${base}.md`)).map(canonical),
      headings(await read(`${base}.pt-BR.md`)).map(canonical), base);
  }
});

test('both language paths document every command and action from CLI USAGE', async () => {
  const cli = await read('src/cli.js');
  const usage = cli.match(/const USAGE_LINES = \[([\s\S]*?)\]\.map/)[1].replaceAll('{command}', DEFAULT_CONFIG.install.command);
  const commands = [...usage.matchAll(/okit-plugin ([a-z-]+)(?: ([a-z-]+(?:\|[a-z-]+)*))?/g)]
    .flatMap(([, group, actions]) => actions
      ? actions.split('|').map((action) => `okit-plugin ${group} ${action}`) : [`okit-plugin ${group}`]);
  assert.ok(commands.length > 0);
  for (const suffix of ['', '.pt-BR']) {
    const file = `docs/components/cli${suffix}.md`;
    const content = [await read(file), ...await Promise.all(guidePairs.map(base => read(`${base}${suffix}.md`)))].join('\n');
    const text = content.replace(/okit-plugin (daemon|autostart) ([a-z-]+(?:\|[a-z-]+)+)/g,
      (_, group, actions) => actions.split('|').map((action) => `okit-plugin ${group} ${action}`).join('\n'));
    for (const command of commands) assert.ok(text.includes(command), `${file}: ${command}`);
  }
});
