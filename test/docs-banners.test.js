import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { generateBanners, renderBanner } from '../scripts/docs-banners.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFile(resolve(root, file), 'utf8');
const config = JSON.parse(await read('docs/images/banners/banners.config.json'));
async function markdownFiles(folder) {
  const files = await Promise.all((await readdir(resolve(root, folder), { withFileTypes: true }))
    .map(entry => entry.isDirectory() ? markdownFiles(`${folder}/${entry.name}`)
      : entry.name.endsWith('.md') ? [`${folder}/${entry.name}`] : []));
  return files.flat();
}
function checkBanner(file, text) {
  const id = file.startsWith('docs/') ? file.split('/')[1] : 'project';
  const area = config.areas.find(area => area.id === id);
  assert.ok(area, `${file}: configured area`);
  const lang = file.endsWith('.pt-BR.md') ? 'pt-BR' : 'en';
  const target = relative(dirname(file), `docs/images/banners/${id}.svg`);
  const expected = `![${config.project}: ${area.title[lang]}](${target})`;
  assert.match(text, /^# [^\n]+\n\n/, `${file}: H1 first`);
  assert.equal(text.split('\n')[2], expected, `${file}: localized area banner after H1`);
  return target;
}

test('every documentation page has its localized area banner and an existing SVG', async () => {
  const files = ['README.md', 'README.pt-BR.md', ...await markdownFiles('docs')];
  for (const file of files) {
    const target = checkBanner(file, await read(file));
    assert.match(await read(`${dirname(file)}/${target}`), /^<svg\b/, file);
  }
});

test('banner corpus accepts both languages and refuses missing, misplaced or wrong banners', () => {
  // | Corpus | Must pass | Must refuse |
  // | Correct area, language, project and position | yes | no |
  // | Missing/misplaced banner or wrong area/language/project/path | no | yes |
  for (const area of config.areas) for (const lang of ['en', 'pt-BR']) {
    const suffix = lang === 'en' ? '' : '.pt-BR';
    const file = area.id === 'project' ? `README${suffix}.md` : `docs/${area.id}/README${suffix}.md`;
    const path = relative(dirname(file), `docs/images/banners/${area.id}.svg`);
    const banner = `![${config.project}: ${area.title[lang]}](${path})`;
    const valid = `# Title\n\n${banner}\n\nSummary.\n`;
    assert.doesNotThrow(() => checkBanner(file, valid));
    for (const invalid of [valid.replace(banner + '\n\n', ''), `${banner}\n\n# Title\n`,
      valid.replace(config.project, 'other-project'), valid.replace(area.title[lang], area.title[lang === 'en' ? 'pt-BR' : 'en']),
      valid.replace(path, 'missing.svg'), valid.replace(path, path.replace(area.id, 'wrong-area'))]) {
      assert.throws(() => checkBanner(file, invalid), `${file}: ${invalid}`);
    }
  }
});

const run = cwd => spawnSync(process.execPath, ['scripts/docs-banners.js', '--check'], { cwd, encoding: 'utf8' });
test('committed banners match the config and stay small and theme aware', async () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  for (const area of config.areas) {
    const svg = await read(`docs/images/banners/${area.id}.svg`);
    assert.equal(svg, renderBanner(config, area));
    assert.ok(Buffer.byteLength(svg) < 3000, area.id);
    assert.ok(svg.includes('@media(prefers-color-scheme:dark)'));
    for (const title of [config.project, ...Object.values(area.title)]) assert.ok(svg.includes(title));
    assert.doesNotMatch(svg, /<(?:script|image|foreignObject)\b|\bhref=|\bon\w+=/i);
  }
});

test('--check detects a hand-edited colour and missing SVG; generation repairs both', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'okit-doc-banners-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(resolve(fixture, 'scripts'));
  await cp(resolve(root, 'scripts/docs-banners.js'), resolve(fixture, 'scripts/docs-banners.js'));
  await writeFile(resolve(fixture, 'package.json'), '{"type":"module"}\n');
  await cp(resolve(root, 'docs/images/banners'), resolve(fixture, 'docs/images/banners'), { recursive: true });
  assert.equal(run(fixture).status, 0);
  const file = resolve(fixture, 'docs/images/banners/guide.svg');
  await writeFile(file, (await readFile(file, 'utf8')).replace(config.colours.dark.accent, '#ffffff'));
  assert.notEqual(run(fixture).status, 0);
  await rm(file);
  assert.notEqual(run(fixture).status, 0);
  const result = spawnSync(process.execPath, ['scripts/docs-banners.js'], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run(fixture).status, 0);
});

test('generateBanners refuses an unknown icon from a temporary config', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'okit-doc-icon-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const area = { id: 'invalid-icon', icon: 'unknown', title: { en: 'Test', 'pt-BR': 'Teste' } };
  await writeFile(resolve(fixture, 'banners.config.json'), JSON.stringify({ ...config, areas: [area] }));
  await assert.rejects(generateBanners(fixture), /Unknown icon: unknown/);
  await assert.rejects(readFile(resolve(fixture, 'invalid-icon.svg')),
    error => error.code === 'ENOENT');
});

test('generateBanners rejects path traversal ids before writing outside its folder', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'okit-doc-area-'));
  const outside = resolve(fixture, '..', `${basename(fixture)}-escaped.svg`);
  t.after(async () => {
    await rm(outside, { force: true });
    await rm(fixture, { recursive: true, force: true });
  });
  const area = { id: `../${basename(fixture)}-escaped`, icon: 'book', title: { en: 'Test', 'pt-BR': 'Teste' } };
  await writeFile(resolve(fixture, 'banners.config.json'), JSON.stringify({ ...config, areas: [area] }));
  await assert.rejects(generateBanners(fixture), /Invalid area id:/);
  await assert.rejects(readFile(outside), error => error.code === 'ENOENT');
});
