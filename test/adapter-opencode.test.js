import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import adapter, { capabilities, configRoot, installHooks, installSkill, readQuota, spawn } from '../adapters/opencode/index.js';
import { adapterQuotaReader } from '../src/status.js';
import { rolePrompt } from '../src/roles.js';
import { configureRoles } from '../adapters/opencode/index.js';
import plugin from '../src/install/client-plugin.js';
const brief = (text) => `Role: Executor\n${text}`;
const roleText = (text) => rolePrompt({ client: 'opencode', briefing: brief(text) });

// | Must pass | Must refuse |
// | native config primary Director, briefed agents, preserved actor/user bytes | ambiguous role, unsupported mechanism |
test('native agent/config and command delivery preserve user configuration', async (t) => {
  const root = await temp(t);
  await mkdir(join(root, 'commands'));
  const file = join(root, 'commands', 'okit.md');
  await writeFile(file, 'User command instructions\n');
  for (let n = 0; n < 2; n++) await adapter.installRole({ root });
  assert.equal((await readFile(file, 'utf8')).split('<!-- okit role:begin -->').length, 2);
  const config = { default_agent: 'custom', agent: { custom: { model: 'p/user', variant: 'custom', prompt: 'User prompt' } } };
  const bridge = await plugin({ client: {}, directory: root });
  await bridge.config(config);
  const once = JSON.stringify(config);
  await bridge.config(config);
  assert.equal(JSON.stringify(config), once);
  assert.equal(config.default_agent, 'custom');
  assert.equal(config.agent.custom.model, 'p/user');
  assert.equal(config.agent.custom.variant, 'custom');
  assert.match(config.agent.custom.prompt, /^User prompt\n.*\nMain session:/);
  assert.match(config.agent['okit-director'].prompt, /Role: Director/);
  for (const role of ['Executor', 'Critic']) {
    const delivery = adapter.deliverRole({ briefing: `Role: ${role}\nInspect changes`, actor: { model: 'p/model', effort: 'high' } });
    assert.equal(delivery.native.agent.mode, 'subagent');
    assert.equal(delivery.native.agent.model, 'p/model');
    assert.equal(delivery.native.agent.variant, 'high');
    assert.match(delivery.native.agent.prompt, new RegExp(`Role: ${role}`));
    const calls = [];
    await spawn({ model: 'p/model', effort: 'high' }, `Role: ${role}\nInspect changes`, { logDir: root,
      runId: `role-${role}`, spawn: (...args) => { calls.push(args); return { pid: 4242, on() {}, unref() {} }; } });
    assert.ok(calls[0][1].includes('p/model'));
    assert.ok(calls[0][1].includes('high'));
    assert.match(calls[0][1].at(-1), new RegExp(`Role: ${role}`));
    for (const field of ['Orders:', 'Limits:', 'Work in hand:', 'Available actors:', 'Unknown facts:', 'Ordens:', 'Fatos desconhecidos:']) assert.ok(delivery.native.agent.prompt.includes(field));
  }
  for (let n = 0; n < 2; n++) await adapter.removeRole({ root });
  assert.equal(await readFile(file, 'utf8'), 'User command instructions\n');
  assert.equal((await adapter.installRole({ root, briefing: 'do the step' })).status, 'clarification');
  assert.equal((await adapter.installRole({ root, nativeSupported: false })).status, 'unsupported');
  assert.equal(configureRoles({ agent: { 'okit-director': { prompt: 'User' } } }).status, 'unsupported');
  const malformed = { agent: { custom: { prompt: ['unsupported'] } } };
  assert.equal(configureRoles(malformed).status, 'unsupported');
  assert.deepEqual(malformed, { agent: { custom: { prompt: ['unsupported'] } } });
  await assert.rejects(spawn({ model: 'p/model' }, 'do the step'), /Clarify/);
});

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'okit-opencode-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

// | Case | Must pass | Must refuse |
// | spawn | exact argv, custom provider variant | empty model/prompt, NATIVE |
// | skill | copy, repeat, retain different bytes | traversal, missing SKILL.md |
// | plugin | publish JS, repeat, preserve entries | non-JS, overwrite |
// | quota | recorded user numbers, no writes | malformed JSON |
test('configRoot follows option, client env, XDG and home precedence', () => {
  const env = { OPENCODE_CONFIG_DIR: 'client', XDG_CONFIG_HOME: 'xdg' };
  assert.equal(configRoot({ root: 'chosen', env }), resolve('chosen'));
  assert.equal(configRoot({ env }), resolve('client'));
  assert.equal(configRoot({ env: { XDG_CONFIG_HOME: 'xdg' } }), resolve('xdg', 'opencode'));
  assert.equal(configRoot({ root: ' ', env: {} }), join(homedir(), '.config', 'opencode'));
});

test('spawn delegates the exact command to an injected process', async (t) => {
  const root = await temp(t);
  const calls = [];
  const fake = (...args) => {
    calls.push(args);
    return { pid: 4242, on() {}, unref() {} };
  };
  const prompt = 'inspect "quoted" input; $(never-run)';
  const result = await spawn({ model: 'provider/model', effort: 'custom' }, brief(prompt),
    { spawn: fake, cwd: root, logDir: root, runId: 'run-test', env: { TEST_MARKER: 'yes' } });
  assert.deepEqual(result, { mode: 'PROCESS', runId: 'run-test', pid: 4242 });
  assert.equal(calls[0][0], 'opencode');
  assert.deepEqual(calls[0][1], ['run', '--dir', root, '--model', 'provider/model',
    '--variant', 'custom', '--format', 'json', roleText(prompt)]);
  assert.equal(calls[0][2].shell, undefined);
  assert.equal(calls[0][2].env.OKWORK_NO_DAEMON, '1');
  assert.equal(calls[0][2].env.TEST_MARKER, 'yes');
  assert.equal(JSON.parse(await readFile(join(root, 'run-test.json'))).client, 'opencode');
  await spawn({ model: 'provider/model' }, brief('no effort'),
    { spawn: fake, cwd: root, logDir: root, runId: 'run-no-effort', headless: true });
  assert.deepEqual(calls[1][1], ['run', '--dir', root, '--model', 'provider/model', '--format', 'json', roleText('no effort')]);
});

test('invalid spawns fail before invoking any process', async () => {
  for (const [actor, prompt, opts] of [
    [{}, 'body', {}], [{ model: 'p/m' }, '', {}],
    [{ model: 'p/m' }, 'body', { mode: 'NATIVE' }],
    [{ model: 'p/m' }, 'body', { headless: false }],
    [{ model: 'p/m', effort: 3 }, 'body', {}],
    [{ model: 'p/m' }, 'body', { runId: '../escape' }],
  ]) await assert.rejects(spawn(actor, prompt, opts), TypeError);
});

test('quota parses recorded core samples without changing them or mixing clients', async (t) => {
  const root = await temp(t);
  assert.deepEqual(await readQuota({ stateRoot: root }), { source: 'user' });
  await mkdir(join(root, 'quota'));
  const file = join(root, 'quota', 'opencode.json');
  const sample = '{"remainingPct":42,"windowMinutes":300,"source":"api"}\n';
  await writeFile(file, sample);
  const before = await stat(file);
  assert.deepEqual(await readQuota({ stateRoot: root }), { source: 'user', remainingPct: 42, windowMinutes: 300 });
  assert.equal(await readFile(file, 'utf8'), sample);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  const read = adapterQuotaReader({ stateRoot: root });
  assert.deepEqual(await read('opencode'), { source: 'user', remainingPct: 42, windowMinutes: 300 });
  assert.deepEqual(await read('claude-code'), { source: 'user' });
  for (const [record, expected] of [
    [{ remainingPct: 0 }, { source: 'user', remainingPct: 0 }],
    [{ remainingPct: 'half' }, { source: 'user' }],
    [{ remainingPct: 30, windowMinutes: '300' }, { source: 'user', remainingPct: 30 }],
  ]) {
    await writeFile(file, JSON.stringify(record));
    assert.deepEqual(await readQuota({ stateRoot: root }), expected);
  }
  await writeFile(file, '{broken');
  await assert.rejects(readQuota({ stateRoot: root }), /Invalid JSON/);
});

test('capabilities and default export follow the contract with independent arrays', () => {
  assert.deepEqual(capabilities(), { models: [], efforts: ['high', 'max', 'minimal'],
    skills: true, hooks: true, mcp: true, desktop: false, windows: false });
  const given = capabilities();
  given.efforts.push('mutated');
  given.models.push('mutated');
  assert.deepEqual(capabilities().models, []);
  assert.equal(capabilities().efforts.includes('mutated'), false);
  assert.equal(adapter.CLIENT, 'opencode');
  for (const name of ['spawn', 'readQuota', 'capabilities', 'installSkill', 'installHooks', 'configRoot']) {
    assert.equal(typeof adapter[name], 'function');
  }
});

test('skill copies are idempotent and retain differing user files', async (t) => {
  const root = await temp(t);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '# Skill\n');
  const opts = { root: join(root, 'config'), env: {} };
  const first = await installSkill('example', source, opts);
  assert.equal(first.path, join(opts.root, 'skills', 'example'));
  assert.deepEqual(first.written, ['SKILL.md']);
  assert.deepEqual((await installSkill('example', source, opts)).skipped,
    [{ path: 'SKILL.md', reason: 'identical' }]);
  await writeFile(join(first.path, 'SKILL.md'), 'user edits');
  assert.deepEqual((await installSkill('example', source, opts)).skipped,
    [{ path: 'SKILL.md', reason: 'differs' }]);
  assert.equal(await readFile(join(first.path, 'SKILL.md'), 'utf8'), 'user edits');
  for (const name of ['../x', 'a/b', 'a\\b', '..', '', '.hidden', 'a..b', '..hidden']) {
    await assert.rejects(installSkill(name, source, opts), TypeError);
  }
  await assert.rejects(installSkill('missing', root, opts), /SKILL.md/);
});

test('plugin installation preserves config, other modules, and repeated installs', async (t) => {
  const root = await temp(t);
  const source = join(root, 'example.js');
  const config = join(root, 'config');
  await mkdir(join(config, 'plugins'), { recursive: true });
  const bytes = 'export const Example = async () => ({});\n';
  const settings = '{"plugin":["user-package"],"mcp":{"user":{"enabled":true}}}\n';
  await writeFile(source, bytes);
  await writeFile(join(config, 'opencode.json'), settings);
  await writeFile(join(config, 'plugins', 'user.js'), '// user\n');
  const opts = { env: { OPENCODE_CONFIG_DIR: config } };
  const first = await installHooks(source, opts);
  assert.deepEqual(first, { path: join(config, 'plugins', 'example.js'), written: true });
  const before = await stat(first.path);
  assert.deepEqual(await installHooks(source, opts), { ...first, written: false, reason: 'identical' });
  assert.equal((await stat(first.path)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(config, 'opencode.json'), 'utf8'), settings);
  assert.equal(await readFile(join(config, 'plugins', 'user.js'), 'utf8'), '// user\n');
  assert.deepEqual((await readdir(join(config, 'plugins'))).sort(), ['example.js', 'user.js']);
  await writeFile(first.path, '// edited by user\n');
  assert.deepEqual(await installHooks(source, opts), { ...first, written: false, reason: 'differs' });
  assert.equal(await readFile(first.path, 'utf8'), '// edited by user\n');
  await assert.rejects(installHooks(join(root, 'not-js.json'), opts), /\.js plugin/);
});

test('concurrent plugin publication never replaces differing complete bytes', async (t) => {
  const root = await temp(t);
  const sources = [join(root, 'a'), join(root, 'b')];
  for (const [index, directory] of sources.entries()) {
    await mkdir(directory);
    await writeFile(join(directory, 'plugin.js'), `// plugin ${index}\n`);
  }
  const results = await Promise.all(sources.map((directory) => installHooks(
    join(directory, 'plugin.js'), { root: join(root, 'config') })));
  assert.equal(results.filter((result) => result.written).length, 1);
  assert.equal(results.find((result) => !result.written).reason, 'differs');
  const winner = results.findIndex((result) => result.written);
  assert.equal(await readFile(results[0].path, 'utf8'), `// plugin ${winner}\n`);
});
