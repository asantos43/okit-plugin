import assert from 'node:assert/strict';
import test from 'node:test';
import { clientMain, clientSource } from '../src/config-ui/client.js';
import { labels } from '../src/config-ui/labels.js';

function fixture(responses = [], controls = [], actors = [], hash = '', summaries = [], accounts = {}) {
  const handlers = {}, calls = [];
  const nodes = Object.fromEntries(['error', 'status', 'review', 'changes', 'reload'].map(id => [id, { hidden: true, textContent: '' }]));
  nodes.review.scrolls = []; nodes.review.focuses = [];
  nodes.review.scrollIntoView = options => { nodes.review.scrolls.push(options); };
  nodes.review.focus = options => { nodes.review.focuses.push(options); };
  nodes.state = { textContent: JSON.stringify({ expectedMtime: 42, actors, accounts: accounts.state ?? [], labels: labels.en, locale: 'en', instance: 'page-instance' }) };
  let reloads = 0;
  const tabs = ['actors', 'limits', 'language', 'profiles', 'telemetry', 'todo', ...(accounts.rows ? ['accounts'] : [])].map(id => ({
    dataset: { tab: id }, attributes: {}, classList: { toggle(name, value) { this[name] = value; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute: () => `panel-${id}`, focus() { this.focused = true; },
  }));
  const panels = tabs.map(tab => (nodes[`panel-${tab.dataset.tab}`] = {
    id: `panel-${tab.dataset.tab}`, contains: control => control.panel === tab.dataset.tab,
  }));
  const win = { navigator: accounts.navigator ?? {}, getSelection: () => accounts.selection,
    location: { hash, search: '?token=abc%2B123&locale=en', reload: () => { reloads++; } },
    history: { replaceState: (_state, _title, value) => { win.location.hash = value; } },
    document: {
      createRange: () => ({ selectNodeContents: node => { accounts.selected = node; } }),
      getElementById: id => nodes[id], querySelector: selector => nodes[selector.slice(1)], querySelectorAll: selector =>
      selector === '[role="tab"]' ? tabs : selector === '[role="tabpanel"]' ? panels
        : selector === 'details.section > summary' ? summaries
          : selector === 'tr[data-account-id]' ? accounts.rows ?? [] : controls,
      addEventListener: (name, handler) => { handlers[name] = handler; },
      defaultView: { addEventListener: (name, handler) => { handlers[name] = handler; } } },
    fetch: async (path, options) => { calls.push({ path, ...options });
      const result = (path === '/api/keepalive' ? undefined : responses.shift()) ?? { status: 200, value: {} };
      return { status: result.status, json: async () => result.value }; } };
  clientMain(win);
  const startup = calls.splice(0);
  const click = (action, dataset = {}) => handlers.click({ target: { closest: () => ({ dataset: { action, ...dataset } }) } });
  const tabClick = index => handlers.click({ target: { closest: () => tabs[index] } });
  return { win, nodes, calls, startup, handlers, click, tabs, panels, tabClick, reloads: () => reloads };
}

function accountFixture(responses = [], login = 'logged-out', navigator = {}) {
  const input = { value: 'New label', dataset: { renameAccount: '' } };
  const code = { tagName: 'code', textContent: "CODEX_HOME='/home/you/.codex-work' codex login" };
  const pre = { textContent: code.textContent, code };
  const help = { hidden: login === 'logged-in', querySelector: selector => selector === 'pre' ? pre : paragraph };
  const paragraph = { textContent: labels.en.accountLoginHelp }, confirm = { hidden: true }, remove = { textContent: 'Remove', hidden: false };
  const focusable = () => ({ focuses: 0, focus() { this.focuses++; } });
  Object.assign(remove, focusable());
  const confirmButton = focusable(), terminal = focusable(), loginButton = { hidden: login !== 'logged-in' };
  const badge = { className: 'badge old', textContent: 'Old' };
  const row = { dataset: { client: 'codex', accountId: 'work' }, querySelector: selector => ({
    'input[data-rename-account]': input,
    '[data-account-login-help]': help, '[data-account-remove-confirm]': confirm,
    '[data-account-remove-open]': remove, code, '.badge': badge,
    '[data-confirm="true"]': confirmButton, '[data-action="account-terminal"]': terminal,
    '[data-action="account-login"]': loginButton,
  })[selector] };
  const fields = { '[name="label"]': { value: 'Work' }, '[name="configDir"]': { value: '/home/you/.codex-work' } };
  const form = { querySelector: selector => fields[selector] };
  const accounts = { rows: [row], navigator, state: [{ client: 'codex', id: 'work', login }],
    selection: { removeAllRanges() { this.cleared = true; }, addRange(range) { this.range = range; } } };
  const control = { dataset: { path: 'language', type: 'string' }, value: 'en', panel: 'language' };
  const f = fixture(responses, [control, { dataset: { account: 'work', client: 'codex' }, value: 'Actor label' }], [], '#tab=accounts', [], accounts);
  const button = (action, extra = {}) => ({ ...focusable(), dataset: { action, ...row.dataset, ...extra },
    closest: selector => selector === 'tr[data-account-id]' ? row : selector === '[data-account-add]' ? form : null });
  const click = target => f.handlers.click({ target: { closest: selector => selector === '[data-action]' ? target : null } });
  return { ...f, row, input, pre, help, paragraph, confirm, remove, fields, accounts, button, control,
    badge, terminal, loginButton, confirmButton, accountClick: click };
}

test('Accounts add posts its fields and reloads state while preserving the tab', async () => {
  const f = accountFixture();
  await f.accountClick(f.button('account-add'));
  assert.equal(f.calls[0].path, '/api/account-add');
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].body), { client: 'codex', label: 'Work', configDir: '/home/you/.codex-work' });
  assert.equal(f.calls[1].path, '/api/state?locale=en');
  assert.equal(f.reloads(), 1);
  assert.equal(f.win.location.hash, '#tab=accounts');
});

test('Accounts add displays a 422 reason without reloading or clearing fields', async () => {
  const f = accountFixture([{ status: 422, value: { reason: 'Folder already registered' } }]);
  await f.accountClick(f.button('account-add'));
  assert.equal(f.nodes.error.textContent, 'Folder already registered');
  assert.equal(f.fields['[name="label"]'].value, 'Work');
  assert.equal(f.fields['[name="configDir"]'].value, '/home/you/.codex-work');
  assert.equal(f.calls.length, 1);
  assert.equal(f.reloads(), 0);
});

test('Accounts remove requires two clicks in the same row and then reloads', async () => {
  const f = accountFixture(), button = f.button('account-remove');
  await f.accountClick(button);
  assert.equal(f.calls.length, 0);
  assert.equal(f.confirm.hidden, false);
  assert.equal(f.confirmButton.focuses, 1);
  assert.equal(f.remove.hidden, true);
  assert.equal(f.remove.textContent, 'Remove');
  assert.equal(f.nodes.error.textContent, '');
  await f.accountClick(f.button('account-remove', { confirm: 'true' }));
  assert.equal(f.calls[0].path, '/api/account-remove');
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].body), { client: 'codex', id: 'work' });
  assert.equal(f.calls[1].path, '/api/state?locale=en');
  assert.equal(f.reloads(), 1);
});

test('Escape, outside clicks and other row actions cancel remove confirmation', async () => {
  for (const cancel of [f => f.handlers.keydown({ key: 'Escape' }),
    f => f.accountClick(null), f => f.accountClick(f.button('account-login')),
    f => f.accountClick(f.button('account-remove', { cancel: 'true' }))]) {
    const f = accountFixture(), button = f.button('account-remove');
    await f.accountClick(button); await cancel(f);
    assert.equal(f.confirm.hidden, true);
    assert.equal(f.remove.hidden, false);
    assert.equal(f.remove.focuses, 1);
    assert.equal(f.remove.textContent, 'Remove');
    await f.accountClick(button);
    assert.equal(f.calls.length, 0);
  }
});

test('Accounts remove cannot confirm a different row or remove default', async () => {
  const f = accountFixture();
  await f.accountClick(f.button('account-remove'));
  const other = { ...f.row, dataset: { client: 'codex', accountId: 'other' } };
  const button = { dataset: { ...other.dataset, action: 'account-remove', confirm: 'true' },
    closest: () => other };
  await f.accountClick(button);
  assert.equal(f.calls.length, 0);
  await f.accountClick(button);
  assert.deepEqual(JSON.parse(f.calls[0].body), { client: 'codex', id: 'other' });
  const g = accountFixture();
  await g.accountClick(g.button('account-remove', { accountId: 'default' }));
  await g.accountClick(g.button('account-remove', { accountId: 'default' }));
  assert.equal(g.calls.length, 0);
});

test('Accounts rename uses its own marked input, independently of Actors', async () => {
  const f = accountFixture();
  f.input.value = 'Production';
  await f.accountClick(f.button('account-rename'));
  assert.equal(f.calls[0].path, '/api/account-label');
  assert.equal(f.calls[0].method, 'PUT');
  assert.deepEqual(JSON.parse(f.calls[0].body), { client: 'codex', id: 'work', label: 'Production' });
  assert.equal(f.calls[1].path, '/api/state?locale=en');
  assert.equal(f.reloads(), 1);
});

test('Accounts terminal posts only the saved row identity and keeps help open', async () => {
  const f = accountFixture([{ status: 200, value: { launched: true, terminal: 'fake' } }]);
  const button = f.button('account-terminal', { configDir: '/ignored', command: 'ignored' });
  await f.accountClick(button);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/api/account-login');
  assert.equal(f.calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].body), { client: f.row.dataset.client, id: f.row.dataset.accountId });
  assert.equal(f.nodes.status.textContent, labels.en.accountTerminalOpened);
  assert.equal(f.help.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(f.reloads(), 0);
  assert.equal(f.calls.some(call => call.path === '/api/config'), false);
});

test('Accounts terminal refusals keep the command available with the matching message', async () => {
  for (const [reason, key] of [['no-terminal', 'accountTerminalNoTerminal'],
    ['unsafe-folder', 'accountTerminalUnsafeFolder'], ['unsupported-client', 'accountTerminalUnsupported'],
    ['unexpected', 'accountTerminalNoTerminal'], ['toString', 'accountTerminalNoTerminal']]) {
    const f = accountFixture([{ status: 200, value: { launched: false, reason } }]);
    await f.accountClick(f.button('account-terminal'));
    assert.equal(f.nodes.status.textContent, labels.en[key]);
    assert.equal(f.help.hidden, false);
    assert.equal(f.pre.code.textContent, f.pre.textContent);
    assert.deepEqual(f.calls.map(call => call.path), ['/api/account-login']);
    assert.equal(f.reloads(), 0);
  }
});

test('Accounts terminal 422 displays the server reason', async () => {
  const f = accountFixture([{ status: 422, value: { reason: 'Unknown account' } }]);
  const button = f.button('account-terminal');
  f.nodes.status.textContent = 'Previous guidance';
  await f.accountClick(button);
  assert.equal(f.nodes.error.textContent, 'Unknown account');
  assert.equal(f.nodes.status.textContent, '');
  assert.equal(f.help.hidden, false);
  assert.equal(button.disabled, false);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/account-login']);
});

test('Accounts terminal disables while pending and re-enables after success or failure', async () => {
  for (const fails of [false, true]) {
    const f = accountFixture(), button = f.button('account-terminal');
    let settle;
    f.win.fetch = (path, options) => {
      f.calls.push({ path, ...options });
      return new Promise((resolve, reject) => {
        settle = () => fails ? reject(new Error('Network failed'))
          : resolve({ status: 200, json: async () => ({ launched: true }) });
      });
    };
    const pending = f.accountClick(button);
    assert.equal(button.disabled, true);
    assert.deepEqual(f.calls.map(call => call.path), ['/api/account-login']);
    settle();
    await pending;
    assert.equal(button.disabled, false);
    assert.equal(f.nodes[fails ? 'error' : 'status'].textContent, fails ? 'Network failed' : labels.en.accountTerminalOpened);
    assert.equal(button.focuses, 1);
    assert.equal(f.help.hidden, false);
  }
});

test('Accounts copy writes the exact command to the clipboard', async () => {
  const copied = [];
  const f = accountFixture([], 'unknown', { clipboard: { writeText: async value => { copied.push(value); } } });
  f.nodes.error.textContent = 'Previous error';
  await f.accountClick(f.button('account-copy'));
  assert.deepEqual(copied, [f.pre.textContent]);
  assert.equal(f.pre.code.tagName, 'code');
  assert.equal(f.nodes.status.textContent, labels.en.accountCopied);
  assert.equal(f.nodes.error.textContent, '');
  assert.equal(f.accounts.selected, undefined);
});

test('Accounts copy selects the command when clipboard is missing or rejects', async () => {
  for (const navigator of [{}, { clipboard: { writeText: async () => { throw new Error('Denied'); } } }]) {
    const f = accountFixture([], 'unknown', navigator);
    await f.accountClick(f.button('account-copy'));
    assert.equal(f.accounts.selected, f.pre.code);
    assert.equal(f.accounts.selection.cleared, true);
    assert.ok(f.accounts.selection.range);
    assert.equal(f.nodes.status.textContent, labels.en.accountCopyFallback);
    assert.equal(f.calls.length, 0);
  }
});

test('Accounts login opens help and focuses the terminal; Check login updates in place', async () => {
  for (const login of ['logged-in', 'logged-out', 'unknown']) {
    const f = accountFixture([{ status: 200, value: { accounts: [
      { client: 'codex', id: 'work', login, loginCommand: 'updated command' },
    ] } }], login);
    f.control.value = 'pt-BR'; f.handlers.input({ target: f.control });
    const dots = f.tabs.map(tab => tab.classList['has-edits']);
    assert.equal(f.help.hidden, login === 'logged-in');
    assert.equal(f.paragraph.textContent, labels.en.accountLoginHelp);
    const loginButton = f.button('account-login');
    await f.accountClick(loginButton);
    assert.equal(f.help.hidden, false);
    assert.equal(loginButton.hidden, true);
    assert.equal(f.terminal.focuses, 1);
    assert.equal(f.calls.length, 0);
    await f.accountClick(f.button('account-check'));
    assert.equal(f.calls[0].path, '/api/state?locale=en');
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(f.calls.length, 1);
    assert.equal(f.reloads(), 0);
    assert.equal(f.help.hidden, login === 'logged-in');
    assert.equal(f.badge.className, `badge ${login === 'logged-in' ? 'ready' : login === 'logged-out' ? 'waiting' : 'unknown'}`);
    assert.equal(f.badge.textContent, labels.en[login === 'logged-in' ? 'loggedIn' : login === 'logged-out' ? 'notLoggedIn' : 'loginUnknown']);
    assert.equal(f.pre.code.textContent, 'updated command');
    assert.equal(f.control.value, 'pt-BR');
    assert.deepEqual(f.tabs.map(tab => tab.classList['has-edits']), dots);
  }
});

test('Check login updates every matching client row and leaves other clients alone', async () => {
  const f = accountFixture([{ status: 200, value: { accounts: [
    { client: 'codex', id: 'work', login: 'logged-in', loginCommand: 'new work' },
    { client: 'codex', id: 'second', login: 'unknown', loginCommand: 'new second' },
    { client: 'claude-code', id: 'work', login: 'logged-out', loginCommand: 'changed' },
  ] } }]);
  const second = accountFixture(), other = accountFixture();
  second.row.dataset.accountId = 'second'; other.row.dataset.client = 'claude-code';
  f.accounts.rows.push(second.row, other.row);
  await f.accountClick(f.button('account-check'));
  assert.equal(f.badge.className, 'badge ready');
  assert.equal(second.badge.className, 'badge unknown');
  assert.equal(second.help.hidden, false);
  assert.equal(second.pre.code.textContent, 'new second');
  assert.equal(other.badge.className, 'badge old');
  assert.equal(other.pre.code.textContent, other.pre.textContent);
});

test('Check login reports HTTP and network failures without reloading or closing help', async () => {
  for (const network of [false, true]) {
    const f = accountFixture([{ status: 422, value: { reason: 'Cannot check login' } }]);
    if (network) f.win.fetch = async () => { throw new Error('Cannot check login'); };
    f.nodes.status.textContent = 'Old guidance';
    await f.accountClick(f.button('account-check'));
    assert.equal(f.nodes.error.textContent, 'Cannot check login');
    assert.equal(f.nodes.status.textContent, '');
    assert.equal(f.help.hidden, false);
    assert.equal(f.reloads(), 0);
  }
});

test('Accounts add, rename and remove refuse dirty or reset controls before requests', async () => {
  for (const action of ['account-add', 'account-rename', 'account-remove']) {
    for (const dirty of ['edit', 'reset', 'invalid']) {
      const f = accountFixture();
      if (dirty === 'reset') await f.click('reset', { reset: 'language' });
      else if (dirty === 'invalid') { f.control.dataset.type = 'object'; f.control.value = '{'; }
      else f.control.value = 'pt-BR';
      await f.accountClick(f.button(action));
      await f.accountClick(f.button(action, { confirm: 'true' }));
      assert.equal(f.calls.length, 0);
      assert.equal(f.reloads(), 0);
      assert.equal(f.nodes.error.textContent, labels.en.accountSaveFirst);
      assert.equal(f.nodes.status.textContent, '');
    }
  }
});

test('Accounts terminal guidance distinguishes Claude Code and Codex', async () => {
  for (const client of ['claude-code', 'codex']) {
    const f = accountFixture([{ status: 200, value: { launched: true } }]);
    await f.accountClick(f.button('account-terminal', { client }));
    assert.equal(f.nodes.status.textContent, labels.en[client === 'claude-code' ? 'accountTerminalOpenedClaude' : 'accountTerminalOpened']);
    assert.equal(f.nodes.error.textContent, '');
  }
});

test('keepalive registers the instance on start and only persisted pageshow', () => {
  const f = fixture();
  assert.equal(f.startup.length, 1);
  const check = call => {
    assert.equal(call.path, '/api/keepalive');
    assert.equal(call.method, 'POST');
    assert.equal(call.keepalive, true);
    assert.equal(call.headers['x-okit-token'], 'abc+123');
    assert.deepEqual(JSON.parse(call.body), { instance: 'page-instance' });
  };
  check(f.startup[0]);
  f.handlers.pageshow({ persisted: false });
  assert.equal(f.calls.length, 0);
  f.handlers.pageshow({ persisted: true });
  assert.equal(f.calls.length, 1);
  check(f.calls[0]);
});

test('tabs select one panel, persist the hash and follow keyboard navigation', async () => {
  const f = fixture();
  const selected = index => {
    assert.deepEqual(f.panels.map(panel => panel.hidden), f.panels.map((_, i) => i !== index));
    assert.deepEqual(f.tabs.map(tab => tab.attributes['aria-selected']), f.tabs.map((_, i) => String(i === index)));
    assert.deepEqual(f.tabs.map(tab => tab.tabIndex), f.tabs.map((_, i) => i === index ? 0 : -1));
    assert.equal(f.win.location.hash, `#tab=${f.tabs[index].dataset.tab}`);
  };
  selected(0);
  await f.tabClick(1); selected(1);
  for (const [from, key, to] of [[1, 'ArrowRight', 2], [2, 'End', 5], [5, 'ArrowRight', 0],
    [0, 'ArrowLeft', 5], [5, 'Home', 0]]) {
    let prevented = false;
    f.handlers.keydown({ target: f.tabs[from], key, preventDefault: () => { prevented = true; } });
    selected(to); assert.equal(prevented, true); assert.equal(f.tabs[to].focused, true);
  }
  for (const [hash, expected] of [['#tab=telemetry', 4], ['#tab=unknown', 0], ['', 0]]) {
    const g = fixture([], [], [], hash);
    assert.equal(g.panels[expected].hidden, false);
    assert.equal(g.panels.filter(panel => !panel.hidden).length, 1);
  }
});

test('only changed controls are sent with token and mtime; save refreshes state', async () => {
  const a = { dataset: { path: 'language', type: 'string' }, value: 'en' };
  const b = { dataset: { path: 'limits.global', type: 'integer' }, value: '2' };
  const f = fixture([], [a, b]);
  b.value = '3';
  await f.click('review');
  assert.match(f.nodes.changes.textContent, /Before: 2\nAfter: 3/);
  await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body), { expectedMtime: 42, changes: [{ path: 'limits.global', value: 3 }] });
  assert.equal(f.calls[0].headers['x-okit-token'], 'abc+123');
  assert.equal(f.calls[0].credentials, 'same-origin');
  assert.equal(f.calls[1].path, '/api/state?locale=en');
  assert.equal(f.reloads(), 1);
  assert.match(clientSource(), /^\(function clientMain/);
});

test('hidden tab edits keep dots, review changes and saved values across tab switches', async () => {
  const control = { dataset: { path: 'limits.global', type: 'integer' }, value: '2', panel: 'limits' };
  const f = fixture([], [control]);
  assert.equal(f.panels[1].hidden, true);
  control.value = '3'; f.handlers.input({ target: control });
  assert.equal(f.tabs[1].classList['has-edits'], true);
  control.value = '2'; f.handlers.change({ target: control });
  assert.equal(f.tabs[1].classList['has-edits'], false);
  await f.tabClick(1);
  control.value = '4'; f.handlers.change({ target: control });
  await f.tabClick(2);
  assert.equal(f.panels[1].hidden, true);
  assert.equal(f.tabs[1].classList['has-edits'], true);
  await f.click('review');
  assert.match(f.nodes.changes.textContent, /limits.global\nBefore: 2\nAfter: 4/);
  await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [{ path: 'limits.global', value: 4 }]);
  assert.equal(f.reloads(), 1);
  assert.equal(f.win.location.hash, '#tab=language');
  const restored = fixture([], [], [], f.win.location.hash);
  assert.equal(restored.panels[2].hidden, false);
});

test('untouched empty number and text controls yield no changes', async () => {
  const controls = ['number', 'integer', 'string'].map(type => ({
    dataset: { path: `future.${type}`, type }, value: '',
    type: type === 'string' ? 'text' : 'number',
  }));
  const f = fixture([], controls);
  await f.click('review');
  assert.equal(f.nodes.changes.textContent, '');
  await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, []);
});

test('validation reason, conflict reload and explicit model confirmation', async () => {
  for (const status of [422, 409]) {
    const f = fixture([{ status, value: { reason: 'disk or validation reason' } }]);
    await f.click('review'); await f.click('apply');
    assert.equal(f.nodes.error.textContent, 'disk or validation reason');
    assert.equal(f.nodes.reload.hidden, status !== 409);
  }
  const control = { dataset: { actorPath: 'profiles.codex.simple.model', type: 'string' }, value: 'old' };
  const confirmed = { dataset: { actorPath: 'profiles.codex.hard.model', type: 'string' }, value: 'old' };
  const other = { dataset: { path: 'language', type: 'string' }, value: 'en' };
  const actors = [{ client: 'codex', classes: ['simple', 'hard'].map(name => ({ path: `profiles.codex.${name}`,
    modelChoices: [{ model: 'listed', confirmed: true }, { model: 'new', confirmed: false }] })) }];
  const f = fixture([{ status: 422, value: { reason: 'Model is not confirmed by the client; confirm this change explicitly.' } }],
    [confirmed, control, other], actors);
  control.value = 'new'; confirmed.value = 'listed'; other.value = 'pt-BR';
  await f.click('review'); await f.click('apply');
  assert.equal(f.calls.length, 1);
  assert.equal(f.nodes.error.textContent, labels.en.confirmModel);
  await f.click('apply');
  const changes = JSON.parse(f.calls[1].body).changes;
  assert.deepEqual(changes, [{ path: 'profiles.codex.hard.model', value: 'listed' },
    { path: 'profiles.codex.simple.model', value: 'new', confirm: true }, { path: 'language', value: 'pt-BR' }]);
});

test('enabling precedes row edits; disabling writes null; pagehide uses keepalive grace', async () => {
  const on = { dataset: { actor: 'profiles.codex.simple' }, type: 'checkbox', checked: false };
  const model = { dataset: { actorPath: 'profiles.codex.simple.model', type: 'string' }, value: '' };
  const f = fixture([], [on, model]);
  on.checked = true; model.value = 'new';
  await f.click('review'); await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [
    { path: 'profiles.codex.simple', unset: true }, { path: 'profiles.codex.simple.model', value: 'new' }]);
  const off = { dataset: { actor: 'profiles.codex.hard' }, type: 'checkbox', checked: true };
  const g = fixture([], [off]); off.checked = false;
  await g.click('review'); await g.click('apply');
  assert.deepEqual(JSON.parse(g.calls[0].body).changes, [{ path: 'profiles.codex.hard', value: null }]);
  f.handlers.pagehide();
  assert.equal(f.calls.at(-1).path, '/api/close');
  assert.equal(f.calls.at(-1).keepalive, true);
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { grace: true, instance: 'page-instance' });
  await f.click('close');
  assert.equal(f.nodes.error.textContent, labels.en.closed);
});

test('shared account and critic controls stay synchronized; reset emits unset', async () => {
  const path = 'profiles.codex.hard.model';
  const a = { dataset: { actorPath: path, type: 'string' }, value: 'old' };
  const b = { dataset: { actorPath: path, type: 'string' }, value: 'old' };
  const field = { dataset: { path: 'language', type: 'string' }, value: 'en' };
  const f = fixture([], [a, b, field]);
  a.value = 'new'; f.handlers.change({ target: a });
  assert.equal(b.value, 'new');
  await f.click('reset', { reset: 'language' });
  await f.click('review'); await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [{ path, value: 'new' }, { path: 'language', unset: true }]);
});

test('review scrolls to and focuses the review panel, also for model confirmation', async () => {
  const f = fixture();
  await f.click('review');
  assert.equal(f.nodes.review.hidden, false);
  assert.deepEqual(f.nodes.review.scrolls, [{ block: 'nearest' }]);
  assert.deepEqual(f.nodes.review.focuses, [{ preventScroll: true }]);
  const model = { dataset: { path: 'limits.model', type: 'string' }, value: 'old' };
  const g = fixture([{ status: 422, value: { reason: 'Model is not confirmed by the client; confirm this change explicitly.' } }], [model]);
  model.value = 'new';
  await g.click('review'); g.nodes.review.scrolls.length = 0; g.nodes.review.focuses.length = 0;
  await g.click('apply');
  assert.equal(g.nodes.review.scrolls.length, 1);
  assert.equal(g.nodes.review.focuses.length, 1);
  const bare = fixture();
  delete bare.nodes.review.scrollIntoView; delete bare.nodes.review.focus;
  await bare.click('review');
  assert.equal(bare.nodes.review.hidden, false);
});

test('tab keys with modifiers are ignored so browser shortcuts keep working', () => {
  const f = fixture();
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    let prevented = false;
    f.handlers.keydown({ target: f.tabs[0], key: 'ArrowRight', [modifier]: true, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(f.tabs[0].attributes['aria-selected'], 'true');
    assert.equal(f.tabs[1].attributes['aria-selected'], 'false');
  }
  let prevented = false;
  f.handlers.keydown({ target: f.tabs[0], key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.tabs[1].attributes['aria-selected'], 'true');
});

test('collapsed section edits and resets mark ancestor summaries and tab, then clear', async () => {
  const field = { dataset: { path: 'codexQuota.fields.used', type: 'string' }, value: 'old', panel: 'limits' };
  const summaries = [true, true, false].map(contains => ({
    parentElement: { open: false, contains: control => contains && control === field },
    classList: { toggle(name, value) { this[name] = value; } },
  }));
  const f = fixture([], [field], [], '', summaries);
  const check = dirty => {
    assert.equal(f.tabs[1].classList['has-edits'], dirty);
    assert.deepEqual(summaries.map(summary => summary.classList['has-edits']), [dirty, dirty, false]);
    assert.ok(summaries.every(summary => !summary.parentElement.open));
  };
  field.value = 'new'; f.handlers.input({ target: field }); check(true);
  field.value = 'old'; f.handlers.change({ target: field }); check(false);
  await f.click('reset', { reset: field.dataset.path }); check(true);
  await f.click('review'); await f.click('apply');
  assert.deepEqual(JSON.parse(f.calls[0].body).changes, [{ path: field.dataset.path, unset: true }]);
  f.handlers.change({ target: field }); check(false);
});

test('clicking Reset marks the tab of that field as edited', async () => {
  const field = { dataset: { path: 'limits.global', type: 'integer' }, value: '2', panel: 'limits' };
  const f = fixture([], [field]);
  assert.notEqual(f.tabs[1].classList['has-edits'], true);
  await f.click('reset', { reset: 'limits.global' });
  assert.equal(f.tabs[1].classList['has-edits'], true);
  assert.notEqual(f.tabs[0].classList['has-edits'], true);
});
