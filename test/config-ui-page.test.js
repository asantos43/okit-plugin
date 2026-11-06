import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderPage } from '../src/config-ui/page.js';
import { labels } from '../src/config-ui/labels.js';
import { buildState } from '../src/config-ui/state.js';
import { schemaEntries } from '../src/core/config.js';

test('schema fields render once, including future fields and redacted values', () => {
  const state = buildState();
  state.fields.push({ path: 'future.example', value: 'new', type: 'text' });
  state.fields.push({ path: 'future.hidden', value: '[Redacted]', type: 'text' });
  const html = renderPage(state, { nonce: 'test', token: 'token' });
  const paths = [...html.matchAll(/ data-path="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(paths.sort(), [...schemaEntries({}).map(entry => entry.path), 'future.example', 'future.hidden'].sort());
  assert.match(html, /data-path="future.hidden"[^>]*readonly/);
  assert.equal((html.match(/<tbody>/g) ?? []).length, state.actors.length);
  assert.equal((html.match(/<tr data-row=/g) ?? []).length, state.actors.length * 4);
});

test('nullish settings render empty inputs while objects and arrays retain JSON', () => {
  const state = buildState();
  for (const type of ['number', 'integer', 'text']) {
    for (const value of [null, undefined]) {
      state.fields.push({ path: `future.${type}.${String(value)}`, type, value });
    }
  }
  state.fields.push({ path: 'future.object', type: 'object', value: { count: 2 } });
  state.fields.push({ path: 'future.array', type: 'object', value: [1, 'two'] });
  const html = renderPage(state, { nonce: 'test', token: 'token' });
  for (const type of ['number', 'integer', 'text']) {
    for (const value of ['null', 'undefined']) {
      assert.ok(html.includes(`data-path="future.${type}.${value}" data-type="${type}" type="${type === 'text' ? 'text' : 'number'}" value=""`));
    }
  }
  assert.doesNotMatch(html, /value="(?:null|undefined)"/);
  assert.match(html, /data-path="future.object"[^>]*value="\{&quot;count&quot;:2\}"/);
  assert.match(html, /data-path="future.array"[^>]*value="\[1,&quot;two&quot;\]"/);
});

test('hostile values stay inert in attributes, text and embedded state', () => {
  const hostile = '"><script>alert(1)</script></script>\u2028\u2029&';
  const state = buildState();
  state.fields.push({ path: 'future.text', type: 'text', value: hostile });
  state.accounts[0].label = hostile;
  state.actors[0].classes[0].model = hostile;
  state.actors[0].classes[0].modelChoices.push({ model: hostile, confirmed: false });
  const html = renderPage(state, { nonce: hostile, token: hostile });
  assert.equal((html.match(/<script\b/g) ?? []).length, 2);
  assert.equal((html.match(/<script[^>]* nonce="/g) ?? []).length, 2);
  assert.doesNotMatch(html, /\son\w+\s*=|https?:\/\//i);
  assert.match(html, /&lt;script&gt;/);
  const embedded = html.match(/id="state"[^>]*>(.*?)<\/script>/s)[1];
  assert.doesNotMatch(embedded, /[<>&\u2028\u2029]/);
  assert.equal(JSON.parse(embedded).accounts[0].label, hostile);
});

test('locale goldens share keys and rendering changes only localized labels', async () => {
  assert.deepEqual(Object.keys(labels.en), Object.keys(labels['pt-BR']));
  for (const locale of ['en', 'pt-BR']) {
    assert.deepEqual(labels[locale], JSON.parse(await readFile(new URL(`./fixtures/config-ui-labels-${locale}.json`, import.meta.url), 'utf8')));
  }
  const state = buildState();
  const normalized = locale => {
    let html = renderPage(state, { locale, token: 'test', nonce: 'nonce' });
    html = html.replace(/<script\b[\s\S]*?<\/script>/g, 'SCRIPT').replace(/lang="[^"]+"/, 'lang="LOCALE"');
    for (const [key, value] of Object.entries(labels[locale])) {
      html = html.replaceAll(`>${value}<`, `>LABEL_${key}<`).replaceAll(`="${value}"`, `="LABEL_${key}"`)
        .replaceAll(`(${value})`, `(LABEL_${key})`).replaceAll(`>${value}:`, `>LABEL_${key}:`);
    }
    return html;
  };
  assert.equal(normalized('en'), normalized('pt-BR'));
});
