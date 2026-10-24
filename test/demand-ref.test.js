import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { demandRef, projectName, withDemandRef } from '../src/demand-ref.js';

// | case | must pass | must refuse |
// | name / no name | qualified ref / bare id | replacing the machine id |
// | scoped / global | own project / registered project | mutating the item |
test('demand references preserve ids, with and without a project name', () => {
  assert.equal(demandRef('D25', 'okit-plugin'), 'D25 (okit-plugin)');
  for (const name of [undefined, null, '', '  ']) assert.equal(demandRef('D25', name), 'D25');
  const item = { id: 'D25', appliesTo: 'other' };
  assert.deepEqual(withDemandRef(item, 'registered'), { ...item, ref: 'D25 (other)' });
  assert.equal(item.ref, undefined);
  assert.equal(withDemandRef({ id: 'D25', appliesTo: ['other'] }, 'registered').ref, 'D25 (other)');
  assert.equal(withDemandRef({ id: 'D25', appliesTo: ['a', 'b'] }, 'registered').ref, 'D25');
  assert.equal(withDemandRef({ id: 'D25' }, 'registered').ref, 'D25 (registered)');
});

test('project name comes from the state record or its repository path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'demand-ref-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await projectName(root), undefined);
  await writeFile(join(root, 'project.json'), JSON.stringify({ name: 'registered', path: '/repos/fallback' }));
  assert.equal(await projectName(root), 'registered');
  await writeFile(join(root, 'project.json'), JSON.stringify({ name: ' ', path: '/repos/fallback' }));
  assert.equal(await projectName(root), 'fallback');
});
