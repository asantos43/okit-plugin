import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const panelImport = /(?:from\s*|import\s*\(?|require\s*\()\s*['"][^'"]*\/panel(?:\/|(?=['"]))/;

// | Corpus | Must pass | Must refuse |
// | imports | core modules | optional panel directory and entry points |
test('isolation guard accepts core imports and refuses panel imports', () => {
  for (const source of ["import './state.js';", "export { state } from './state.js';"]) {
    assert.doesNotMatch(source, panelImport);
  }
  for (const source of ["import '../panel/view.js';", "import('../panel');",
    "export { view } from '../panel/index.js';", "require('../panel')"]) {
    assert.match(source, panelImport);
  }
});

async function sources(directory) {
  const entries = await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const file = `${directory}/${entry.name}`;
    if (file === 'adapters/claude-code/panel') return [];
    return entry.isDirectory() ? sources(file) : /\.[cm]?js$/.test(file) ? [file] : [];
  }))).flat();
}

test('all core and adapter JavaScript outside the mod stays isolated from the panel', async () => {
  const files = [...await sources('src'), ...await sources('adapters')];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, panelImport, file);
  }
});
