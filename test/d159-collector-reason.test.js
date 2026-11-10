import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { fixture } from './helpers/install-fixture.js';
import { collectorState } from '../src/quota/collector-registration.js';

// | settings.json of an account | state names | must refuse |
// | missing / broken JSON / no collector command / read-only | the cause and the file, en and pt-BR | a bare "not registered" |
async function world(t) {
  const f = await fixture(t);
  Object.assign(f.io.env, { CLAUDE_CONFIG_DIR: join(f.home, 'override'), OKWORK_HOME: f.root });
  const raw = JSON.parse(await fs.readFile(join(f.root, 'config.json'), 'utf8'));
  raw.quotaPoll = { enabled: false };
  raw.accounts = { 'claude-code': [{ id: 'gauss', label: 'Gauss', configDir: join(f.home, 'gauss') }] };
  await fs.writeFile(join(f.root, 'config.json'), JSON.stringify(raw));
  await fs.mkdir(raw.accounts['claude-code'][0].configDir, { recursive: true });
  const account = { ...raw.accounts['claude-code'][0], client: 'claude-code', isDefault: false };
  return { ...f, raw, account, file: join(account.configDir, 'settings.json'), ctx: { ...f.io, out: f.io.out, locale: 'en' } };
}

test('each failure names its cause and the file, in both languages', async t => {
  const f = await world(t);
  const cases = [
    [null, /does not exist/, /não existe/], // locale:pt-BR
    ['{ broken', /not valid JSON/, /JSON válido/], // locale:pt-BR
    ['{"a":1}', /no status-bar collector command/, /não tem o comando/], // locale:pt-BR
  ];
  for (const [content, en, pt] of cases) {
    if (content === null) await fs.rm(f.file, { force: true }); else await fs.writeFile(f.file, content);
    const english = await collectorState(f.ctx, f.raw, f.account);
    assert.equal(english.state, 'not registered');
    assert.match(english.reason, en);
    assert.ok(english.reason.includes(f.file));
    assert.equal(english.file, f.file);
    const portuguese = await collectorState({ ...f.ctx, locale: 'pt-BR' }, f.raw, f.account);
    assert.match(portuguese.reason, pt);
    assert.ok(portuguese.reason.includes(f.file));
  }
});

test('a read-only settings file is told as a permissions problem', async t => {
  const f = await world(t);
  await fs.writeFile(f.file, '{"a":1}');
  const denied = { ...fs, access: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
  const state = await collectorState({ ...f.ctx, fs: denied }, f.raw, f.account);
  assert.match(state.reason, /cannot be written/);
  assert.ok(state.reason.includes(f.file));
});

test('the doctor lists the collector of each account, with the file when it is not registered', async t => {
  const f = await world(t);
  await fs.writeFile(f.file, '{ broken');
  await main(['doctor', '--client', 'claude-code'], f.io);
  const broken = f.output.join('\n');
  assert.match(broken, /Account collector/);
  assert.match(broken, /Not registered/);
  assert.ok(broken.includes(f.file), broken);
  f.output.length = 0;
  await fs.rm(f.file);
  await main(['doctor', '--client', 'claude-code', '--fix'], f.io);
  f.output.length = 0;
  await main(['doctor', '--client', 'claude-code'], f.io);
  assert.match(f.output.join('\n'), /Account collector[^\n]*Registered/);
});
