import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import * as codex from '../adapters/codex/index.js';
import * as opencode from '../adapters/opencode/index.js';
import { DEFAULT_CONFIG, configOf } from '../src/profiles.js';
import { detectClients, proposeProfiles } from '../src/setup/detect.js';

// | Case | Must pass | Must refuse |
// | active candidates | active catalog and user candidates | hidden or unlisted models |
// | unavailable catalog | an active candidate or an explicit omission | a model outside the candidates |
// | unavailable listing | the catalog model and its reason | an exception or a write |
// | family | a candidate of the same provider with a long enough prefix | a candidate of another provider |
// | invalid separator | the configured model that is active | any replacement when the separator is empty or not text |
// | separator out of the names | a candidate compared whole, without a provider | a provider the separator never divides |
// | empty listing | an omission with the manual command | the catalog model |
// | a listing that cannot be read | the catalog model and a plain reason | the technical code of the failure |

function fakeRun(answer) {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    return typeof answer === 'function' ? answer(call) : answer;
  };
  run.calls = calls;
  return run;
}

function clientOf(proposal, name) {
  const client = proposal.clients.find((entry) => entry.client === name);
  assert.ok(client, `missing client ${name}`);
  return client;
}

async function tree(root) {
  const entries = [];
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      entries.push(`${relative(root, path)}:${entry.isDirectory() ? 'dir' : 'file'}`);
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return entries.sort();
}

function codexConfig(candidates = []) {
  return {
    profiles: {
      codex: {
        simple: { model: 'gpt-5-codex' },
        normal: { model: 'gpt-5-codex' },
        hard: { model: 'gpt-5-codex' },
      },
    },
    setup: { detect: { codex: {
      command: 'codex', args: [], timeoutMs: 1000, parse: 'json-array', candidates,
    } } },
  };
}

test('a huge listing proposes only active candidates', async () => {
  const models = Array.from({ length: 500 }, (_, index) => ({
    slug: `noise-${index}`, visibility: 'list',
  }));
  models.push({ slug: 'gpt-5.1-codex', visibility: 'list' });
  models.push({ slug: 'gpt-5-hidden-codex', visibility: 'hide' });
  const config = codexConfig(['gpt-5.1-codex', 'gpt-5-hidden-codex']);
  const run = fakeRun({ code: 0, stdout: JSON.stringify({ models }), stderr: '' });
  const detected = await detectClients({ config, run, adapters: [codex] });
  const listing = detected.clients.find((entry) => entry.client === 'codex');
  assert.ok(!listing.models.includes('gpt-5-hidden-codex'));
  assert.deepEqual(listing.hidden, ['gpt-5-hidden-codex']);
  const proposal = proposeProfiles(detected, config);
  const client = clientOf(proposal, 'codex');
  assert.deepEqual(client.summary, { listed: 502, active: 501, candidatesActive: 1 });
  for (const profile of Object.values(client.profiles)) {
    assert.equal(profile.model, 'gpt-5.1-codex');
    assert.equal(profile.source, 'replaced');
  }
  assert.doesNotMatch(JSON.stringify(proposal), /noise-/);
});

test('an absent catalog model is replaced or omitted with the manual command', async () => {
  const config = codexConfig(['gpt-5.1-codex']);
  const active = fakeRun({
    code: 0,
    stdout: JSON.stringify({ models: [{ slug: 'gpt-5.1-codex', visibility: 'list' }] }),
    stderr: '',
  });
  const detected = await detectClients({ config, run: active, adapters: [codex] });
  const replaced = clientOf(proposeProfiles(detected, config), 'codex').profiles.simple;
  assert.equal(replaced.model, 'gpt-5.1-codex');
  assert.equal(replaced.source, 'replaced');
  assert.match(replaced.reason, /gpt-5\.1-codex/);

  const inactive = fakeRun({
    code: 0,
    stdout: JSON.stringify({ models: [{ slug: 'other', visibility: 'list' }] }),
    stderr: '',
  });
  const absent = await detectClients({ config, run: inactive, adapters: [codex] });
  const omitted = clientOf(proposeProfiles(absent, config), 'codex').profiles.simple;
  assert.equal(omitted.model, null);
  assert.equal(omitted.source, 'omitted');
  assert.match(omitted.reason, /okit-plugin config set profiles\.codex\.simple\.model <model>/);
});

test('a client that listed no model omits every class with the manual command', async () => {
  const config = codexConfig(['gpt-5.1-codex']);
  const empty = fakeRun({ code: 0, stdout: JSON.stringify({ models: [] }), stderr: '' });
  const detected = await detectClients({ config, run: empty, adapters: [codex] });
  const listing = detected.clients.find((entry) => entry.client === 'codex');
  assert.equal(listing.source, 'listing');
  assert.deepEqual(listing.models, []);
  const client = clientOf(proposeProfiles(detected, config), 'codex');
  for (const [className, profile] of Object.entries(client.profiles)) {
    assert.equal(profile.model, null, className);
    assert.equal(profile.source, 'omitted', className);
    assert.match(profile.reason,
      new RegExp(`okit-plugin config set profiles\\.codex\\.${className}\\.model <model>`));
  }
});

test('a client that listed only inactive models omits every class', async () => {
  const config = codexConfig(['gpt-5.1-codex']);
  const inactive = fakeRun({
    code: 0,
    stdout: JSON.stringify({ models: [{ slug: 'gpt-5.1-codex', visibility: 'hide' }] }),
    stderr: '',
  });
  const detected = await detectClients({ config, run: inactive, adapters: [codex] });
  const listing = detected.clients.find((entry) => entry.client === 'codex');
  assert.equal(listing.source, 'listing');
  assert.deepEqual(listing.models, []);
  assert.deepEqual(listing.hidden, ['gpt-5.1-codex']);
  const client = clientOf(proposeProfiles(detected, config), 'codex');
  for (const [className, profile] of Object.entries(client.profiles)) {
    assert.equal(profile.model, null, className);
    assert.equal(profile.source, 'omitted', className);
    assert.match(profile.reason,
      new RegExp(`okit-plugin config set profiles\\.codex\\.${className}\\.model <model>`));
  }
});

// D61: the family of a model name comes from the configuration of the client.
function familyConfig(model, candidates, family) {
  return {
    profiles: { codex: {
      simple: { model }, normal: { model }, hard: { model },
    } },
    setup: { detect: { codex: { candidates, family } } },
  };
}

/** A client that answered with the given active models. */
function listedClient(models) {
  return { clients: [{
    client: 'codex', models, hidden: [], source: 'listing', reason: 'listed / listado',
  }] };
}

test('a candidate of another provider never replaces the configured model', () => {
  const config = {
    profiles: { opencode: {
      simple: { model: 'minimax/MiniMax-M3' },
      normal: { model: 'minimax/MiniMax-M3' },
      hard: { model: 'minimax/MiniMax-M3' },
    } },
    setup: { detect: { opencode: { candidates: ['moonshot/kimi-k2'] } } },
  };
  const detected = { clients: [{
    client: 'opencode', models: ['moonshot/kimi-k2'], hidden: [],
    source: 'listing', reason: 'listed / listado',
  }] };
  const client = clientOf(proposeProfiles(detected, config), 'opencode');
  for (const [className, profile] of Object.entries(client.profiles)) {
    assert.equal(profile.model, null);
    assert.equal(profile.source, 'omitted');
    assert.match(profile.reason,
      new RegExp(`okit-plugin config set profiles\\.opencode\\.${className}\\.model <model>`));
  }
});

test('a candidate with a short common prefix never replaces the configured model', () => {
  const cases = [
    { model: 'gpt-5.5', candidate: 'gpt-6.1-sol' },
    { model: 'gpt-5.5', candidate: 'g-6.1-sol' },
  ];
  for (const entry of cases) {
    const config = familyConfig(entry.model, [entry.candidate]);
    const profile = clientOf(proposeProfiles(listedClient([entry.candidate]), config), 'codex').profiles.simple;
    assert.equal(profile.model, null, `${entry.model} -> ${entry.candidate}`);
    assert.equal(profile.source, 'omitted');
    assert.match(profile.reason, /okit-plugin config set profiles\.codex\.simple\.model <model>/);
  }
});

test('a candidate of the same family with a long enough prefix replaces the model', () => {
  const config = familyConfig('gpt-5.6-sol', ['gpt-5.6-terra']);
  const profile = clientOf(proposeProfiles(listedClient(['gpt-5.6-terra']), config), 'codex').profiles.simple;
  assert.equal(profile.model, 'gpt-5.6-terra');
  assert.equal(profile.source, 'replaced');
  assert.match(profile.reason, /gpt-5\.6-terra/);
});

test('the separator and the minimum prefix come from the user configuration', () => {
  // The separator of the user says where the provider ends: with "::" the
  // names "acme::one" and "acme::two" share no prefix and are refused.
  const separated = familyConfig('acme::one', ['acme::two'], { separator: '::', minimumPrefix: 5 });
  const refused = clientOf(proposeProfiles(listedClient(['acme::two']), separated), 'codex').profiles.simple;
  assert.equal(refused.model, null);
  assert.equal(refused.source, 'omitted');
  // With the default separator the same pair shares the prefix "acme::".
  const defaultSeparator = familyConfig('acme::one', ['acme::two']);
  const accepted = clientOf(proposeProfiles(listedClient(['acme::two']), defaultSeparator), 'codex').profiles.simple;
  assert.equal(accepted.model, 'acme::two');
  assert.equal(accepted.source, 'replaced');
  // The minimum prefix of the user accepts what the default would refuse.
  const loose = familyConfig('gpt-5.5', ['gpt-6.1-sol'], { separator: '/', minimumPrefix: 4 });
  const replaced = clientOf(proposeProfiles(listedClient(['gpt-6.1-sol']), loose), 'codex').profiles.simple;
  assert.equal(replaced.model, 'gpt-6.1-sol');
  assert.equal(replaced.source, 'replaced');
  // Another provider is refused even with the user's own rule.
  const other = familyConfig('other::model-x', ['acme::model-y'], { separator: '::', minimumPrefix: 4 });
  const refusedProvider = clientOf(proposeProfiles(listedClient(['acme::model-y']), other), 'codex').profiles.simple;
  assert.equal(refusedProvider.model, null);
  assert.equal(refusedProvider.source, 'omitted');
  // The clients the user did not name keep their own defaults.
  assert.deepEqual(configOf(separated).setup.detect.opencode.family,
    DEFAULT_CONFIG.setup.detect.opencode.family);
});

test('an empty separator or one that is not text never replaces the configured model', () => {
  // The separator of the user divides the provider from the name of the
  // model. A separator that is empty, or that is not text, is no rule at
  // all: the configured model stays when it is active and the class is
  // omitted when it is not, so a model of another provider never takes the
  // place of the configured one.
  const separators = [null, 7, ''];
  for (const separator of separators) {
    const label = JSON.stringify(separator);
    const config = familyConfig('shared-vendor-a/model', ['shared-vendor-b/model'],
      { separator, minimumPrefix: 5 });
    const active = clientOf(proposeProfiles(
      listedClient(['shared-vendor-a/model', 'shared-vendor-b/model']), config), 'codex').profiles.simple;
    assert.equal(active.model, 'shared-vendor-a/model', label);
    assert.equal(active.source, 'listing', label);
    const absent = clientOf(proposeProfiles(
      listedClient(['shared-vendor-b/model']), config), 'codex').profiles.simple;
    assert.equal(absent.model, null, label);
    assert.equal(absent.source, 'omitted', label);
    assert.match(absent.reason,
      /okit-plugin config set profiles\.codex\.simple\.model <model>/, label);
  }
  // A separator that is text refuses the other provider as well: the rule
  // works, and the two providers are not of the same family.
  const valid = familyConfig('shared-vendor-a/model', ['shared-vendor-b/model'],
    { separator: '/', minimumPrefix: 5 });
  const refused = clientOf(proposeProfiles(
    listedClient(['shared-vendor-b/model']), valid), 'codex').profiles.simple;
  assert.equal(refused.model, null);
  assert.equal(refused.source, 'omitted');
});

test('a separator that is in no name leaves every model without a provider', () => {
  // The documented behavior: a name that does not contain the separator has
  // no provider and is compared whole. The separator "::" is in no name
  // here, so both names have no provider and the common prefix
  // "shared-vendor-" reaches the minimum prefix, and the candidate replaces
  // the configured model. The correction is to configure the separator the
  // client really uses in its names.
  const config = familyConfig('shared-vendor-a/model', ['shared-vendor-b/model'],
    { separator: '::', minimumPrefix: 5 });
  const profile = clientOf(proposeProfiles(
    listedClient(['shared-vendor-b/model']), config), 'codex').profiles.simple;
  assert.equal(profile.model, 'shared-vendor-b/model');
  assert.equal(profile.source, 'replaced');
  assert.match(profile.reason, /shared-vendor-b\/model/);
});

test('a user candidate wins a family tie without leaving the candidate set', () => {
  const config = {
    profiles: { codex: {
      simple: { model: 'gpt-5-codex' },
      normal: { model: 'gpt-5.2-codex' },
      hard: { model: 'gpt-5-codex' },
    } },
    setup: { detect: { codex: { candidates: ['gpt-5.1-codex'] } } },
  };
  const detected = { clients: [{
    client: 'codex',
    models: ['gpt-5.1-codex', 'gpt-5.2-codex'],
    hidden: [],
    source: 'listing',
    reason: 'listed / listado',
  }] };
  const client = clientOf(proposeProfiles(detected, config), 'codex');
  assert.equal(client.profiles.simple.model, 'gpt-5.1-codex');
  assert.equal(client.profiles.simple.source, 'replaced');
  assert.equal(client.profiles.normal.model, 'gpt-5.2-codex');
  assert.equal(client.profiles.normal.source, 'listing');
  assert.equal(client.summary.candidatesActive, 2);
});

test('a missing client, a timeout and unknown output keep the catalog with a reason', async () => {
  const cases = [
    {
      answer: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      expected: /not found on this machine|não foi encontrado nesta máquina/,
    },
    {
      answer: () => new Promise(() => {}),
      expected: /did not answer in time|não respondeu a tempo/,
    },
    {
      answer: { code: 0, stdout: 'unknown prose', stderr: '' },
      expected: /not understood|não foi entendida/,
    },
  ];
  for (const entry of cases) {
    const config = codexConfig();
    config.setup.detect.codex.timeoutMs = 20;
    const detected = await detectClients({
      config, run: fakeRun(entry.answer), adapters: [codex],
    });
    const client = clientOf(proposeProfiles(detected, config), 'codex');
    assert.equal(client.profiles.simple.model, 'gpt-5-codex');
    assert.equal(client.profiles.simple.source, 'catalog');
    assert.match(client.profiles.simple.reason, entry.expected);
    assert.ok(client.profiles.simple.reason.includes(' / '));
    assert.doesNotMatch(client.profiles.simple.reason, /\b[DO]\d+\b/);
  }
});

test('a client whose listing fails keeps the technical code out of the reason', async () => {
  // The listing of this client cannot be read: the run of the adapter
  // refuses with a technical code. The reason the user reads names neither
  // the code nor the message of the failure; the record keeps the code.
  const refused = {
    CLIENT: 'codex',
    async listModels({ run }) {
      await run({ command: 'codex', args: [] });
      return { client: 'codex', installed: true, models: [], hidden: [], source: 'listing' };
    },
  };
  const run = fakeRun(() => {
    throw Object.assign(new Error('spawn codex EACCES'), { code: 'EACCES' });
  });
  const config = codexConfig();
  const detected = await detectClients({ config, run, adapters: [refused] });
  const client = detected.clients.find((entry) => entry.client === 'codex');
  assert.equal(client.source, 'catalog');
  assert.equal(client.error, 'EACCES');
  assert.doesNotMatch(client.reason, /EACCES|spawn codex/);
  assert.match(client.reason, /could not be read/);
  assert.match(client.reason, /não pôde ser lida/);
  const proposal = clientOf(proposeProfiles(detected, config), 'codex').profiles.simple;
  assert.equal(proposal.source, 'catalog');
  assert.equal(proposal.model, 'gpt-5-codex');
  assert.doesNotMatch(proposal.reason, /EACCES|spawn codex/);
});

test('the adapters start together and an adapter failure never escapes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const slow = {
    CLIENT: 'codex',
    listModels: async () => {
      started.push('codex');
      await gate;
      return { client: 'codex', models: ['gpt-5-codex'], source: 'listing', reason: 'ok / ok' };
    },
  };
  const broken = {
    CLIENT: 'opencode',
    listModels: async () => {
      started.push('opencode');
      throw new Error('boom');
    },
  };
  const pending = detectClients({ adapters: [slow, broken] });
  assert.deepEqual(started, ['codex', 'opencode']);
  release();
  const detected = await pending;
  assert.equal(detected.clients.find((entry) => entry.client === 'codex').source, 'listing');
  const failed = detected.clients.find((entry) => entry.client === 'opencode');
  assert.equal(failed.source, 'catalog');
  assert.doesNotMatch(failed.reason, /boom/);
  assert.equal(failed.error, 'boom');
});

test('detection and proposals write nothing to disk', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'okit-setup-detect-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const before = await tree(home);
  const config = { setup: { detect: { opencode: {
    command: 'opencode', args: ['models'], timeoutMs: 1000, parse: 'lines',
  } } } };
  const run = fakeRun({ code: 0, stdout: 'provider/one\n', stderr: '' });
  const detected = await detectClients({ config, env: { HOME: home }, run, adapters: [opencode] });
  proposeProfiles(detected, config);
  assert.deepEqual(await tree(home), before);
});
