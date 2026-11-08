import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderPage } from '../src/config-ui/page.js';
import { labels } from '../src/config-ui/labels.js';
import { buildState } from '../src/config-ui/state.js';
import { schemaEntries } from '../src/core/config.js';

export const ACCOUNT_SELECTORS = ['tr[data-account-id]', '[data-account-remove-confirm]',
  '[data-account-remove-open]', '[data-account-login-help]', '[data-account-add]',
  'input[data-rename-account]', 'code', '#status', '#error', '[data-login-progress]', '[data-login-url]', '[data-account-quota]'];

test('real Accounts markup supplies every shared client selector', async () => {
  const state = buildState();
  state.accounts.push({ client: 'codex', id: 'work', label: 'Work', configDir: '/work',
    login: 'unknown', loginCommand: 'codex' });
  const html = renderPage(state, { nonce: 'test', token: 'token' }).split('<script')[0];
  const tags = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*?)>/g)];
  const source = await readFile(new URL('../src/config-ui/client.js', import.meta.url), 'utf8');
  for (const selector of ACCOUNT_SELECTORS) {
    const [, tag, attribute] = selector.match(/^(\w*)\[([^\]]+)\]$/) ?? [];
    const exists = tags.some(([, name, attrs]) => selector.startsWith('#')
      ? attrs.includes(`id="${selector.slice(1)}"`)
      : attribute ? (!tag || name === tag) && new RegExp(`(?:^|\\s)${attribute}(?:[\\s=]|$)`).test(attrs)
        : name === selector);
    assert.ok(exists, `page supplies ${selector}`);
    assert.ok(source.includes(`'${selector}'`), `client uses ${selector}`);
  }
  assert.match(html, /<p id="status" role="status" aria-live="polite" class="status"><\/p>/);
  assert.match(html, /\.status\{color:var\(--muted\)/);
});

test('Accounts cells keep localized headings and client folder placeholders', () => {
  for (const locale of ['en', 'pt-BR']) {
    const state = buildState();
    state.accounts = ['claude-code', 'codex'].flatMap(client =>
      ['logged-in', 'logged-out', 'unknown'].map((login, index) => ({
        client, id: index ? `work${index}` : 'default', label: 'Work',
        configDir: null, login, loginCommand: 'client login',
      })));
    const html = renderPage(state, { nonce: 'test', token: 'token', locale });
    const text = labels[locale];
    const cards = [...html.matchAll(/<section class="actor-card account-card"[^]*?<\/section>/g)];
    assert.equal(cards.length, 2);
    for (const [index, [card]] of cards.entries()) {
      assert.ok(card.includes(`<small class="account-note" id="folder-note-${index ? 'codex' : 'claude-code'}">${text.accountFolderSuggestion}</small>`));
      assert.ok(card.includes(`aria-describedby="folder-note-${index ? 'codex' : 'claude-code'}"`));
      assert.ok(card.includes(`placeholder="/home/you/.${index ? 'codex' : 'claude'}-work"`));
      const headings = [...card.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match => match[1]);
      assert.deepEqual(headings, ['accountLabel', 'accountId', 'accountFolder', 'accountLogin', 'accountActions'].map(key => text[key]));
      const rows = [...card.matchAll(/<tr data-client=[^]*?<\/tr>/g)];
      assert.equal(rows.length, 3);
      for (const [rowIndex, [row]] of rows.entries()) {
        assert.deepEqual([...row.matchAll(/<td\b[^>]*data-label="([^"]+)"/g)].map(match => match[1]), headings);
        assert.match(row, /<td class="account-id"/);
        const loginButton = row.match(/<button[^>]*data-action="account-login"[^>]*>/)[0];
        assert.equal(/\bhidden\b/.test(loginButton), false);
        assert.ok(row.includes(`>${text.accountLoginCommand}</button>`));
        const help = row.match(/<div class="account-login-help"[^>]*>/)[0];
        assert.equal(/\bhidden\b/.test(help), rowIndex === 0);
        const block = row.match(/<div class="account-login-help"[^>]*>([^]*?)<\/div>/)[1];
        const buttons = [...block.matchAll(/<button[^>]*data-action="account-terminal"[^>]*>([^]*?)<\/button>/g)];
        assert.equal(buttons.length, 1);
        assert.equal(buttons[0][1], text.accountTerminal);
        assert.ok(buttons[0][0].includes(`data-client="${index ? 'codex' : 'claude-code'}" data-account-id="${rowIndex ? `work${rowIndex}` : 'default'}"`));
        assert.ok(block.indexOf('data-action="account-terminal"') < block.indexOf('data-action="account-copy"'));
        assert.ok(block.includes(`</pre><p>${text.accountTerminalHint.replaceAll("'", '&#39;')}</p>`));
        assert.equal((row.match(/data-action="account-terminal"/g) ?? []).length, 1);
        assert.equal((row.match(/data-account-remove-open/g) ?? []).length, rowIndex ? 1 : 0);
        if (rowIndex) {
          const confirm = row.match(/<div data-account-remove-confirm hidden>([^]*?)<\/div>/)[1];
          assert.equal((confirm.match(/data-confirm="true"/g) ?? []).length, 1);
          assert.equal((confirm.match(/data-cancel="true"/g) ?? []).length, 1);
          assert.ok(confirm.includes(`<small class="account-note">${text.accountRemoveNote.replaceAll("'", '&#39;')}</small>`));
        }
      }
    }
    assert.match(html, /\.account-card td\.account-id\{overflow-wrap:normal;word-break:normal;white-space:nowrap\}/);
    assert.match(html, /@media\(max-width:699px\)/);
    assert.match(html, /\.account-card table,\.account-card tbody,\.account-card tr,\.account-card td\{display:block;width:100%;min-width:0\}/);
    assert.match(html, /\.account-card thead\{[^}]*clip:rect\(0,0,0,0\)[^}]*clip-path:inset\(50%\)/);
    assert.match(html, /td::before\{content:attr\(data-label\);display:block;font-weight:bold\}/);
    assert.match(html, /input\[data-rename-account\]\{width:100%;min-width:0\}/);
    assert.match(html, /\.account-card,\.account-card \.table-scroll\{overflow-x:visible\}/);
    assert.match(html, /\.account-card td\{overflow-wrap:anywhere\}/);
    assert.match(html, /\.account-card td button\{white-space:normal;overflow-wrap:anywhere\}/);
    assert.match(html, /button\[data-action=account-terminal\]\{background:var\(--accent\);color:var\(--card\);border-color:var\(--accent\)\}/);
  }
});

function sections(html) {
  const stack = [], result = [];
  for (const match of html.matchAll(/<details\b[^>]*>|<\/details>/g)) {
    if (match[0] === '</details>') {
      const item = stack.pop();
      item.html = html.slice(item.start, match.index + match[0].length);
    } else {
      const item = { tag: match[0], start: match.index, parent: stack.at(-1),
        path: match[0].match(/data-section="([^"]+)"/)[1] };
      stack.push(item); result.push(item);
    }
  }
  return result;
}

test('Limits groups and profile clients have native sections with accurate counts', () => {
  const html = renderPage(buildState(), { nonce: 'test', token: 'token' });
  const items = sections(html), byPath = path => items.find(item => item.path === path);
  for (const path of ['limits', 'lowQuotaPct', 'daemon', 'smoke', 'accountPolicy', 'codexQuota']) {
    assert.ok(byPath(path)); assert.equal(byPath(path).parent, undefined);
    assert.ok(html.indexOf(byPath(path).html) > html.indexOf('id="panel-limits"'));
    assert.ok(html.indexOf(byPath(path).html) < html.indexOf('id="panel-language"'));
  }
  assert.match(byPath('limits').tag, / open>/);
  for (const path of ['lowQuotaPct', 'daemon', 'smoke', 'accountPolicy', 'codexQuota']) {
    assert.doesNotMatch(byPath(path).tag, / open/);
  }
  assert.equal(byPath('codexQuota.fields').parent, byPath('codexQuota'));
  assert.equal((byPath('codexQuota.fields').html.match(/data-path="codexQuota.fields\./g) ?? []).length, 11);
});

test('empty config opens the first small groups in Limits and Other, with subsections collapsed', () => {
  const items = sections(renderPage(buildState(), { nonce: 'test', token: 'token' }));
  assert.deepEqual(items.filter(item => / open>/.test(item.tag)).map(item => item.path), ['limits', 'panel']);
});

test('the first section opens at four fields but stays collapsed at five', () => {
  for (const count of [4, 5]) {
    const state = buildState();
    state.fields = Array.from({ length: count }, (_, index) =>
      ({ path: `future.field${index}`, value: 0, default: 0, type: 'integer' }));
    state.fields.push({ path: 'another.field', value: 0, default: 0, type: 'integer' });
    const items = sections(renderPage(state, { nonce: 'test', token: 'token' }));
    assert.equal(/ open>/.test(items.find(item => item.path === 'future').tag), count === 4);
    assert.doesNotMatch(items.find(item => item.path === 'another').tag, / open/);
  }
});

test('a nondefault daemon value opens Daemon besides the first small groups', () => {
  const state = buildState();
  const field = state.fields.find(field => field.path === 'daemon.minQuotaPct');
  field.value = field.default + 1;
  const items = sections(renderPage(state, { nonce: 'test', token: 'token' }));
  assert.deepEqual(items.filter(item => / open>/.test(item.tag)).map(item => item.path), ['limits', 'daemon', 'panel']);
});

test('single-group panels omit outer details; summaries count all descendant controls', () => {
  const html = renderPage(buildState(), { nonce: 'test', token: 'token' });
  const items = sections(html);
  const profiles = items.filter(item => item.path.startsWith('profiles.'));
  assert.deepEqual(profiles.map(item => item.path).sort(), ['profiles.claude-code', 'profiles.codex', 'profiles.opencode']);
  for (const item of profiles) {
    assert.equal(item.parent, undefined);
    assert.doesNotMatch(item.tag, / open/);
    assert.match(item.html, new RegExp(`<summary>${item.path.split('.')[1]} `));
    assert.equal((item.html.match(/ data-path="/g) ?? []).length, 12);
  }
  for (const path of ['language', 'profiles', 'telemetry', 'todo', 'todo.checkbox']) {
    assert.equal(items.some(item => item.path === path), false);
  }
  assert.doesNotMatch(items.find(item => item.path === 'telemetry.rede').tag, / open/);
  for (const item of items) {
    const count = Number(item.html.match(/<summary>[^]*?<span class="count">\((\d+)\)/)[1]);
    assert.equal(count, (item.html.match(/ data-path="/g) ?? []).length);
  }
});

test('tabs link eight panels and retain 93 fields and 48 actor controls without script', () => {
  for (const locale of ['en', 'pt-BR']) {
    const html = renderPage(buildState(), { locale, nonce: 'test', token: 'token' }).replace(/<script\b[\s\S]*?<\/script>/g, '');
    assert.ok(html.includes(`tabindex="-1">${locale === 'en' ? 'Accounts' : 'Contas'}</button>`));
    const ids = ['actors', 'accounts', 'limits', 'language', 'profiles', 'telemetry', 'todo', 'other'];
    assert.equal((html.match(/role="tab"/g) ?? []).length, 8);
    assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 8);
    for (const [index, id] of ids.entries()) {
      assert.ok(html.includes(`id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${labels[locale][`tab${id}`]}</button>`));
      assert.ok(html.includes(`role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"${id === 'accounts' ? ' hidden' : ''}>`));
    }
    assert.equal((html.match(/ data-path="/g) ?? []).length, 93);
    for (const key of ['enabled', 'intervalSec', 'claudeFallbackMinutes']) {
      assert.ok(html.includes(`data-path="quotaPoll.${key}"`));
    }
    assert.match(html, /data-path="panel.color" data-type="boolean" type="checkbox" checked/);
    assert.equal((html.match(/ data-(?:actor-path|actor)="/g) ?? []).length, 48);
    const paths = [...html.matchAll(/ data-path="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(paths.sort(), buildState().fields.map(field => field.path).sort());
    assert.doesNotMatch(html, / style="|\son\w+=/);
    const panels = [...html.matchAll(/role="tabpanel"[^>]*>([\s\S]*?)(?=<section class="panel"|<section id="review")/g)];
    for (const [index, id] of ids.entries()) {
      const expected = buildState().fields.filter(field => id === 'limits'
        ? ['limits', 'lowQuotaPct', 'daemon', 'smoke', 'accountPolicy', 'codexQuota'].includes(field.path.split('.')[0])
        : field.path.split('.')[0] === (id === 'other' ? 'panel' : id));
      for (const field of expected) assert.ok(panels[index][1].includes(`data-path="${field.path}"`));
    }
  }
});

test('Accounts shows both client cards with default rows and separate add forms', () => {
  const state = buildState();
  state.accounts = ['claude-code', 'codex'].map(client => ({ client, id: 'default', label: 'Default',
    configDir: null, login: 'unknown', loginCommand: `${client} login` }));
  for (const locale of ['en', 'pt-BR']) {
    const html = renderPage(state, { locale, nonce: 'test', token: 'token' }).split('id="panel-accounts"')[1].split('id="panel-limits"')[0];
    assert.equal((html.match(/class="actor-card account-card"/g) ?? []).length, 2);
    assert.equal((html.match(/<tr data-client=/g) ?? []).length, 2);
    assert.equal((html.match(/data-account-id="default"/g) ?? []).length > 0, true);
    assert.equal((html.match(new RegExp(`<td[^>]*>${labels[locale].clientDefault}</td>`, 'g')) ?? []).length, 2);
    assert.doesNotMatch(html, /data-action="account-remove"| data-(?:path|actor-path|actor)=/);
    for (const client of ['claude-code', 'codex']) {
      assert.ok(html.includes(`data-account-client="${client}"><h3>${client}</h3>`));
      assert.ok(html.includes(`data-account-add data-client="${client}"`));
      assert.ok(html.includes(`data-action="account-add" data-client="${client}"`));
    }
    assert.equal((html.match(/name="label"/g) ?? []).length, 2);
    assert.equal((html.match(/name="configDir"/g) ?? []).length, 2);
    for (const key of ['accountFolderPlaceholderClaude', 'accountFolderPlaceholderCodex']) {
      assert.ok(html.includes(`placeholder="${labels[locale][key]}"`));
    }
    for (const key of ['accountLabel', 'accountId', 'accountFolder', 'accountLogin', 'accountActions']) {
      assert.ok(html.includes(`<th scope="col">${labels[locale][key]}</th>`));
    }
  }
});

test('account rows render rename inputs, code and help hidden only when logged in', () => {
  const state = buildState(), hostile = '<script>"\'&</script>';
  state.accounts = ['logged-in', 'logged-out', 'unknown'].map((login, index) => ({
    client: 'codex', id: `work-${index}`, label: hostile, configDir: `/home/${hostile}`, login, loginCommand: `codex ${hostile}`,
  }));
  const html = renderPage(state, { nonce: 'test', token: 'token' }).split('id="panel-accounts"')[1].split('id="panel-limits"')[0];
  const rows = [...html.matchAll(/<tr data-client="codex" data-account-id="([^"]+)">([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, 3);
  for (const [index, [, id, row]] of rows.entries()) {
    assert.equal(id, `work-${index}`);
    assert.ok(row.includes(`<input data-rename-account data-client="codex" data-account-id="${id}"`));
    assert.match(row, /value="&lt;script&gt;&quot;&#39;&amp;&lt;\/script&gt;"/);
    assert.match(row, /<td[^>]*>\/home\/&lt;script&gt;&quot;&#39;&amp;&lt;\/script&gt;<\/td>/);
    assert.match(row, /<pre><code>codex &lt;script&gt;&quot;&#39;&amp;&lt;\/script&gt;<\/code><\/pre>/);
    assert.ok(row.includes(`data-account-login-help${index === 0 ? ' hidden' : ''}><p>`));
    assert.match(row, /data-account-remove-confirm hidden/);
    for (const action of ['rename', 'remove', 'login', 'copy', 'check']) {
      assert.ok(row.includes(`type="button" data-action="account-${action}" data-client="codex" data-account-id="${id}"`));
    }
    const [color, key] = [['ready', 'loggedIn'], ['waiting', 'notLoggedIn'], ['unknown', 'loginUnknown']][index];
    assert.ok(row.includes(`<span class="badge ${color}" title="${labels.en[`${key}Title`]}">${labels.en[key]}</span>`));
    for (const key of ['accountLoginHelp', 'accountCopy', 'accountCheck', 'accountConfirmRemove', 'cancel']) assert.ok(row.includes(`>${labels.en[key]}<`));
  }
  assert.doesNotMatch(html, /<script| style=|\son\w+=| data-(?:path|actor-path|actor)=/);
});

test('nondefault values open their ancestors and missing titles use the raw segment', () => {
  const state = buildState();
  const field = state.fields.find(field => field.path.startsWith('codexQuota.fields.'));
  field.value = `${field.default}-changed`;
  state.fields.push({ path: 'future.example', value: 1, default: 1, type: 'integer' });
  state.fields.push({ path: 'another.example', value: 1, default: 1, type: 'integer' });
  const items = sections(renderPage(state, { nonce: 'test', token: 'token' }));
  for (const path of ['codexQuota', 'codexQuota.fields']) {
    assert.match(items.find(item => item.path === path).tag, / open>/);
  }
  assert.match(items.find(item => item.path === 'future').html, /<summary>future <span/);
});

test('review section is focusable and the sticky bar follows the main width', () => {
  const html = renderPage(buildState(), { nonce: 'test', token: 'token' });
  assert.match(html, /<section id="review" tabindex="-1" hidden>/);
  const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /header,main,\.action-bar\{max-width:1100px;margin:auto\}/);
  assert.doesNotMatch(css, /\.action-bar\{max-width:100%\}/);
  assert.match(css, /\*\{box-sizing:border-box\}/);
});

test('schema fields render once, including future fields and redacted values', () => {
  const state = buildState();
  state.fields.push({ path: 'future.example', value: 'new', type: 'text' });
  state.fields.push({ path: 'future.hidden', value: '[Redacted]', type: 'text' });
  const html = renderPage(state, { nonce: 'test', token: 'token' });
  const paths = [...html.matchAll(/ data-path="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(paths.sort(), [...schemaEntries({}).map(entry => entry.path), 'future.example', 'future.hidden'].sort());
  assert.match(html, /data-path="future.hidden"[^>]*readonly/);
  assert.match(html, /role="tabpanel" id="panel-other" aria-labelledby="tab-other">[\s\S]*data-path="future.example"/);
  assert.match(html, /data-tab="other"[^>]*>Other<\/button>/);
  assert.equal((html.match(/<tbody>/g) ?? []).length, state.actors.length + 2);
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
  // A protocol-only literal validates login links; no remote endpoint is embedded.
  assert.doesNotMatch(html, /\son\w+\s*=|https?:\/\/(?!['"])/i);
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
    const entries = Object.entries(labels[locale]).flatMap(([key, value]) =>
      typeof value === 'object' ? Object.entries(value).map(([path, title]) => [`${key}.${path}`, title]) : [[key, value]]);
    for (const [key, raw] of entries) {
      const value = raw.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      html = html.replaceAll(`>${value}<`, `>LABEL_${key}<`).replaceAll(`="${value}"`, `="LABEL_${key}"`)
        .replaceAll(`(${value})`, `(LABEL_${key})`).replaceAll(`>${value}:`, `>LABEL_${key}:`)
        .replaceAll(`>${value} <span class="count">`, `>LABEL_${key} <span class="count">`);
    }
    return html;
  };
  assert.equal(normalized('en'), normalized('pt-BR'));
});

test('actor tables sit in horizontal scroll wrappers; tab list and wrapper scroll horizontally', () => {
  const html = renderPage(buildState(), { nonce: 'test', token: 'token' });
  const css = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)[1];
  const body = html.replace(/<style\b[\s\S]*?<\/style>/g, '').replace(/<script\b[\s\S]*?<\/script>/g, '');
  const tables = body.match(/<table\b/g)?.length ?? 0;
  assert.ok(tables > 0);
  assert.equal(body.match(/<div class="table-scroll"><table\b/g)?.length ?? 0, tables);
  assert.equal(body.match(/<div class="table-scroll">/g)?.length ?? 0, tables);
  assert.match(css, /\.tabs\{[^}]*overflow-x:auto/);
  assert.match(css, /\.tabs\{[^}]*flex-wrap:nowrap/);
  assert.match(css, /\.table-scroll\{[^}]*overflow-x:auto/);
  assert.match(css, /header \.badge\{[^}]*white-space:normal/);
});
