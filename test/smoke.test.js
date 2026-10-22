import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('package.json declares the package name', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.name, 'okit-plugin');
});

test('LICENSE is the MIT license', () => {
  assert.match(read('../LICENSE'), /MIT License/);
});