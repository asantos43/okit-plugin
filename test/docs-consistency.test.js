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
const pairs = ['README', 'INSTALL', 'docs/ARCHITECTURE', 'docs/DESIGN',
  'docs/RELEASING', 'docs/SMOKE', 'docs/INTEGRATION', 'docs/DEMO'];
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
  const readme = await read('README.md');
  const said = (pattern) => Number(readme.match(pattern)?.[1]);
  assert.equal(said(/exposes (\d+) tools/), TOOL_NAMES.length);
  assert.equal(Number((await read('README.pt-BR.md')).match(/expõe (\d+) ferramentas/)[1]), TOOL_NAMES.length);
  assert.equal(said(/`smoke` runs (\d+) isolated checks/),
    INSTALL_CHECKS.length + FEATURE_CHECKS.length + UNINSTALL_CHECKS.length);
  assert.equal(said(/`client-smoke` has (\d+) scenario checks/), SCENARIO.length);
  assert.match(readme, /nine client × system pairs/);
  assert.equal(DEFAULT_CONFIG.release.clients.length * DEFAULT_CONFIG.release.systems.length, 9);
});

test('environment command, tool, skill and shared module are documented in both languages', async () => {
  for (const file of ['README.md', 'README.pt-BR.md']) {
    const text = await read(file);
    for (const term of ['okit-plugin env report', 'env_report', 'okit-environment']) {
      assert.ok(text.includes(term), `${file}: ${term}`);
    }
  }
  for (const file of ['docs/ARCHITECTURE.md', 'docs/ARCHITECTURE.pt-BR.md']) {
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
    // D34/D36 owns the publisher section, including its existing translated title.
    const canonical = (title) => title === 'Publishing — Publicação' ? 'Publishing' : title;
    assert.deepEqual(headings(await read(`${base}.md`)).map(canonical),
      headings(await read(`${base}.pt-BR.md`)).map(canonical), base);
  }
});

test('both READMEs document every command and action from CLI USAGE', async () => {
  const cli = await read('src/cli.js');
  const usage = cli.match(/const USAGE = \[([\s\S]*?)\]\.join/)[1].replaceAll('{command}', DEFAULT_CONFIG.install.command);
  const commands = [...usage.matchAll(/okit-plugin ([a-z-]+)(?: ([a-z-]+(?:\|[a-z-]+)*))?/g)]
    .flatMap(([, group, actions]) => actions
      ? actions.split('|').map((action) => `okit-plugin ${group} ${action}`) : [`okit-plugin ${group}`]);
  assert.ok(commands.length > 0);
  for (const file of ['README.md', 'README.pt-BR.md']) {
    const text = (await read(file)).replace(/okit-plugin (daemon|autostart) ([a-z-]+(?:\|[a-z-]+)+)/g,
      (_, group, actions) => actions.split('|').map((action) => `okit-plugin ${group} ${action}`).join('\n'));
    for (const command of commands) assert.ok(text.includes(command), `${file}: ${command}`);
  }
});
