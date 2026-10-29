import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';

import { TOOLS } from '../src/mcp/tools.js';
import { isQuotaReleased, QUOTA_RELEASED_EVENT, quotaReleasedNotice } from '../src/quota/released.js';

const roots = [];
const LOCALES = ['en', 'pt-BR'];
const CLIENTS = ['claude-code', 'codex', 'opencode'];
// Words a person should never read in the notice: the event type, any id or
// code, a run or demand reference, a raw client key.
const JARGON = /quota\.released|\b[A-Z]\d{2,}\b|\bD\d+\b|\bI\d{6}\b|\bid\b|\brun\b|claude-code|undefined|\[object|\{|\}|\d/i;

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function callTool(args) {
  const root = await mkdtemp(join(tmpdir(), 'quota-released-'));
  roots.push(root);
  const tool = TOOLS.find((entry) => entry.name === 'quota_notice');
  return JSON.parse(await tool.handler(args, { root }));
}

// | Input                                   | Must pass                 | Must refuse                      |
// | { type: 'quota.released', client }      | available + released text | the "not available" sentence     |
// | { type: 'quota.released' } (no client)  | generic "back" sentence   | a made-up client name            |
// | { type: 'quota.released', client: 'x' } | generic "back" sentence   | the raw client key               |
// | no event, other type, non-object        | "not available" sentence  | claiming the quota came back     |
// | array with quota.released type         | unavailable               | treating the array as an event   |
// | constructor / __proto__ client         | generic released notice   | inherited client names           |
test('the quota-back event gives a released notice naming the subscription', () => {
  const names = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
  for (const client of CLIENTS) {
    for (const locale of LOCALES) {
      const notice = quotaReleasedNotice({ type: QUOTA_RELEASED_EVENT, client }, locale);
      assert.equal(notice.available, true);
      assert.equal(notice.released, true);
      assert.ok(notice.text.includes(names[client]), `${locale} ${client}: ${notice.text}`);
    }
  }
  assert.match(quotaReleasedNotice({ type: QUOTA_RELEASED_EVENT, client: 'codex' }, 'en').text, /quota .*is back/);
  assert.match(quotaReleasedNotice({ type: QUOTA_RELEASED_EVENT, client: 'codex' }, 'pt-BR').text, /cota .*voltou/);
});

test('an event without a known client still says the quota is back, without inventing a name', () => {
  for (const event of [{ type: QUOTA_RELEASED_EVENT }, { type: QUOTA_RELEASED_EVENT, client: 'mystery' },
    { type: QUOTA_RELEASED_EVENT, client: 7 }]) {
    for (const locale of LOCALES) {
      const notice = quotaReleasedNotice(event, locale);
      assert.equal(notice.released, true);
      assert.ok(!notice.text.includes('mystery'));
      assert.match(notice.text, locale === 'en' ? /is back/ : /voltou/);
    }
  }
});

test('ignoring the event fails: no event or another kind of event is never reported as released', () => {
  for (const event of [undefined, null, 'quota.released', 42, [], {}, { type: 'quota.low' },
    { type: 'quota.released.maybe' }, { kind: QUOTA_RELEASED_EVENT }]) {
    assert.equal(isQuotaReleased(event), false);
    for (const locale of LOCALES) {
      const notice = quotaReleasedNotice(event, locale);
      assert.equal(notice.available, false);
      assert.equal(notice.released, false);
      assert.doesNotMatch(notice.text, locale === 'en' ? /is back/ : /voltou/);
      assert.match(notice.text, locale === 'en' ? /not available/ : /não está disponível/);
    }
  }
});

test('arrays with quota.released type are not quota events', () => {
  const event = Object.assign([], { type: QUOTA_RELEASED_EVENT });
  assert.equal(isQuotaReleased(event), false);
  for (const locale of LOCALES) {
    assert.deepEqual(quotaReleasedNotice(event, locale), quotaReleasedNotice(undefined, locale));
  }
});

test('inherited client names produce exactly the generic quota-back notice', () => {
  for (const client of ['constructor', '__proto__']) {
    for (const locale of LOCALES) {
      const notice = quotaReleasedNotice({ type: QUOTA_RELEASED_EVENT, client }, locale);
      assert.deepEqual(notice, quotaReleasedNotice({ type: QUOTA_RELEASED_EVENT }, locale));
      assert.doesNotMatch(notice.text, /constructor|__proto__|function|\[object/);
    }
  }
});

test('the notice speaks plain words in both languages, with no codes or ids', () => {
  const events = [undefined, { type: QUOTA_RELEASED_EVENT },
    ...CLIENTS.map((client) => ({ type: QUOTA_RELEASED_EVENT, client, id: 'D77', runId: 'run-9', demand: 'I000042' }))];
  for (const event of events) {
    for (const locale of LOCALES) {
      const { text } = quotaReleasedNotice(event, locale);
      assert.ok(text.trim().length > 0);
      assert.doesNotMatch(text.replace(/claude code/i, ''), JARGON, `${locale}: ${text}`);
    }
  }
  assert.notEqual(quotaReleasedNotice({ type: QUOTA_RELEASED_EVENT }, 'en').text,
    quotaReleasedNotice({ type: QUOTA_RELEASED_EVENT }, 'pt-BR').text);
  // A locale the plugin does not know falls back to English, never to nothing.
  assert.equal(quotaReleasedNotice(undefined, 'xx').text, quotaReleasedNotice(undefined, 'en').text);
});

test('the quota_notice tool answers the simulated event in the asked language', async () => {
  const event = { type: QUOTA_RELEASED_EVENT, client: 'opencode', runId: 'secret-run' };
  for (const locale of LOCALES) {
    const answer = await callTool({ event, locale });
    assert.deepEqual(answer, quotaReleasedNotice(event, locale));
    assert.equal(answer.released, true);
    assert.ok(!answer.text.includes('secret-run'));
  }
  const fallback = await callTool({ event });
  assert.equal(fallback.released, true);
});

test('the quota_notice tool says the notice is not available when the kit sent no event', async () => {
  for (const args of [{}, { locale: 'pt-BR' }, { event: null }, { event: { type: 'other' } }]) {
    const answer = await callTool(args);
    assert.equal(answer.available, false);
    assert.equal(answer.released, false);
    assert.match(answer.text, /not available|não está disponível/);
  }
});

test('the quota_notice tool refuses an event that is not an object', async () => {
  for (const args of [{ event: 'quota.released' }, { event: [] }, { event: 3 }, { junk: true }, { locale: 'xx' }]) {
    await assert.rejects(() => callTool(args), TypeError, JSON.stringify(args));
  }
});

test('invalid quota_notice events are refused in the requested language', async () => {
  for (const event of ['quota.released', [], 3]) {
    for (const [locale, message] of [
      ['en', 'quota_notice: event must be an object when given'],
      ['pt-BR', 'quota_notice: o evento deve ser um objeto quando informado'],
    ]) {
      await assert.rejects(() => callTool({ event, locale }), { name: 'TypeError', message });
    }
  }
});

test('the Director probes without an event before waiting and explains the quota fallback', async () => {
  const skill = await readFile(new URL('../skills/okit-director/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Before waiting, call `quota_notice` without `event`, with the user's `locale`/);
  assert.match(skill, /Antes de esperar, chame `quota_notice` sem `event`, com o `locale` do usuário/);
  assert.match(skill, /If `available` is false, say “The kit cannot tell you yet when quota comes back/);
  assert.match(skill, /Se `available` for false, diga “O kit ainda não avisa quando a cota volta/);
  for (const command of ['okit-plugin quota show', 'okit-plugin daemon status']) assert.ok(skill.includes(`\`${command}\``));
  assert.match(skill, /Do not wait for an event that will not arrive/);
  assert.match(skill, /Não espere um evento que não virá/);
  assert.ok(skill.indexOf('Before waiting, call') < skill.indexOf('When an event arrives, call'));
  assert.match(skill, /Do not poll/);
  assert.match(skill, /Não consulte/);
});
