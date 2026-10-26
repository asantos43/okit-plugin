import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
export const GUIDE_LINE_BUDGET = 80;
const README_LINE_BUDGET = 35;
const TITLE = 'Orchestration Kit plugin (okit plugin)';
const pages = ['README', 'install', 'models-and-quota', 'ask-the-director',
  'smoke-demo', 'update-and-remove', 'troubleshooting'];
const names = pages.flatMap(base => [`${base}.md`, `${base}.pt-BR.md`]);
const maintainerPages = ['README', 'ARCHITECTURE', 'INTEGRATION', 'DEMO', 'SMOKE', 'DESIGN', 'RELEASING'];
const maintainerNames = maintainerPages.flatMap(base => [`${base}.md`, `${base}.pt-BR.md`]);
const lines = text => text.trimEnd().split('\n');
const headings = text => [...text.matchAll(/^(#{1,6}) .+$/gm)].map(m => m[1].length);
const ids = text => [...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]);

function checkUserPage(text, budget, guide = false) {
  assert.ok(lines(text).length <= budget, `line budget ${budget}`);
  assert.doesNotMatch(text, /\b[DO]\d+\b|\b(?:passo|step)\s+\d+\b/i);
  assert.doesNotMatch(text, /\n{3,}/, 'no surplus blank lines');
  if (guide) {
    assert.match(text, /^# [^\n]+\n\n[^#\s<\d][^\n]*[.!?]\n\n/, 'one-line summary after title');
    assert.match(text, /^1\. /m, 'numbered instructions');
  }
}

function checkMaintainerPage(text) {
  assert.match(text, /^# [^\n]+\n\n[^#\s<\d][^\n]*[.!?]\n\n/, 'one-line summary');
  assert.match(text, /<a id="contents"><\/a>\n## (?:Contents|Índice)\n\n(?:- \[[^\n]+\n)+/, 'TOC');
  assert.doesNotMatch(text, /[\t ]+$/m, 'no trailing spaces');
  const sections = [...text.matchAll(/<a id="(section-\d+)"><\/a>\n## ([^\n]+)/g)];
  for (const [, id, title] of sections) assert.ok(text.includes(`- [${title}](#${id})`), title);
}

test('both front pages have the exact title, immediate banner and compact user text', async () => {
  for (const suffix of ['', '.pt-BR']) {
    const text = await read(`README${suffix}.md`);
    assert.equal(lines(text)[0], `# ${TITLE}`);
    assert.match(lines(text)[2], /^!\[[^\]]+\]\(docs\/art\/banner\.svg\)$/);
    checkUserPage(text, README_LINE_BUDGET);
    assert.doesNotMatch(text, /^\s*\|/m, 'front pages have no tables');
  }
});

test('the guide contains exactly the required English and Portuguese pages', async () => {
  assert.deepEqual((await readdir(new URL('docs/guide/', root))).sort(), names.toSorted());
});

test('maintainer pages have mirrored summaries and contents, with no legacy root pages', async () => {
  assert.deepEqual((await readdir(new URL('docs/maintainers/', root))).sort(), maintainerNames.toSorted());
  const oldRoot = await readdir(new URL('docs/', root));
  for (const name of maintainerNames.filter(name => !name.startsWith('README'))) {
    assert.ok(!oldRoot.includes(name), `legacy page: ${name}`);
  }
  for (const base of maintainerPages) {
    const en = await read(`docs/maintainers/${base}.md`);
    const pt = await read(`docs/maintainers/${base}.pt-BR.md`);
    for (const text of [en, pt]) checkMaintainerPage(text);
    assert.deepEqual(headings(en), headings(pt), base);
    assert.deepEqual(ids(en), ids(pt), base);
    assert.equal(new Set(ids(en)).size, ids(en).length, base);
    if (base !== 'README') assert.ok(ids(en).some(id => id.startsWith('section-')), base);
  }
});

test('every guide page has a short summary, numbered instructions and a line budget', async () => {
  for (const name of names) {
    const text = await read(`docs/guide/${name}`);
    assert.doesNotThrow(() => checkUserPage(text, GUIDE_LINE_BUDGET, true), name);
  }
});

test('language mirrors keep the same heading levels and stable anchors', async () => {
  for (const base of ['README', ...pages.map(name => `docs/guide/${name}`)]) {
    const en = await read(`${base}.md`);
    const pt = await read(`${base}.pt-BR.md`);
    assert.deepEqual(headings(en), headings(pt), base);
    assert.ok(ids(en).length > 0, `${base}: stable anchors`);
    assert.deepEqual(ids(en), ids(pt), base);
    assert.equal(new Set(ids(en)).size, ids(en).length, `${base}: unique anchors`);
  }
});

test('structure rules accept ordinary instructions and refuse forbidden or oversized content', () => {
  // | Corpus | Must pass | Must refuse |
  // | Ordinary summary and numbered task | yes | no |
  // | Demand/order ids or construction step numbers | no | yes |
  // | Surplus blank lines or exceeded line budget | no | yes |
  // | Multiline/missing summary or missing numbered instructions | no | yes |
  const valid = '# Guide\n\nOne task explained briefly.\n\n1. Run the command and read the result.\n';
  assert.doesNotThrow(() => checkUserPage(valid, GUIDE_LINE_BUDGET, true));
  for (const extra of ['D72', 'O30', 'passo 1', 'Step 2', '\n\n\n', '\nx'.repeat(GUIDE_LINE_BUDGET)]) {
    assert.throws(() => checkUserPage(valid + extra, GUIDE_LINE_BUDGET, true), extra);
  }
  for (const invalid of [valid.replace('briefly.\n', 'briefly\ncontinued.\n'),
    valid.replace('1. ', '- '), valid.replace('One task explained briefly.\n', '')]) {
    assert.throws(() => checkUserPage(invalid, GUIDE_LINE_BUDGET, true));
  }
});

test('maintainer corpus accepts summary and TOC and refuses missing or multiline summaries and broken contents', () => {
  // | Corpus | Must pass | Must refuse |
  // | One-line summary and complete anchored contents | yes | no |
  // | Missing/multiline summary, absent TOC or omitted section | no | yes |
  const valid = '# Design\n\nA maintainer contract.\n\n<a id="contents"></a>\n## Contents\n\n- [Core](#section-1)\n\n<a id="section-1"></a>\n## Core\n';
  assert.doesNotThrow(() => checkMaintainerPage(valid));
  for (const invalid of [valid.replace('A maintainer contract.\n', ''),
    valid.replace('contract.', 'contract\ncontinued.'), valid.replace('## Contents', '## Elsewhere'),
    valid.replace('- [Core](#section-1)', '- [Missing](#section-2)')]) {
    assert.throws(() => checkMaintainerPage(invalid));
  }
});
