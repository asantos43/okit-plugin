import { accountSlug, proposedAccountFolder } from '../accounts.js';

export function clientMain(win, slugify = accountSlug, proposeFolder = proposedAccountFolder) {
  const doc = win.document;
  const state = JSON.parse(doc.getElementById('state').textContent);
  const text = state.labels;
  const params = {};
  win.location.search.replace(/^\?/, '').split('&').forEach(part => {
    const [key, value = ''] = part.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
  });
  const all = selector => [...doc.querySelectorAll(selector)];
  const read = control => control.type === 'checkbox' ? control.checked
    : ['integer', 'number'].includes(control.dataset.type) ? (control.value === '' ? null : Number(control.value))
      : ['object', 'profile'].includes(control.dataset.type) ? JSON.parse(control.value || 'null') : control.value;
  const controls = all('[data-path], [data-actor-path], [data-actor]');
  const initial = new Map(controls.map(control => [control, read(control)]));
  const resets = new Set();
  const tabs = all('[role="tab"]');
  const panels = all('[role="tabpanel"]');
  const selectTab = tab => {
    for (const item of tabs) {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
    win.history.replaceState(null, '', `#tab=${tab.dataset.tab}`);
  };
  const isDirty = control => {
    const path = control.dataset.path ?? control.dataset.actorPath ?? control.dataset.actor;
    try { return resets.has(path) || JSON.stringify(read(control)) !== JSON.stringify(initial.get(control)); }
    catch { return true; }
  };
  const updateDots = () => {
    for (const marker of [...tabs, ...all('details.section > summary')]) {
      const container = tabs.includes(marker)
        ? doc.getElementById(marker.getAttribute('aria-controls')) : marker.parentElement;
      const dirty = controls.some(control => container.contains(control) && isDirty(control));
      marker.classList.toggle('has-edits', dirty);
    }
  };
  if (tabs.length) selectTab(tabs.find(tab => win.location.hash === `#tab=${tab.dataset.tab}`) ?? tabs[0]);
  const manualFolders = new WeakSet();
  doc.addEventListener('input', event => {
    updateDots();
    const source = event.target;
    const form = source.closest?.('[data-account-add]');
    if (!form) return;
    const folder = form.querySelector('[name="configDir"]');
    if (source === folder) {
      if (folder.value) { manualFolders.add(folder); return; }
      manualFolders.delete(folder);
    }
    if (!manualFolders.has(folder)) folder.value = proposeFolder(form.dataset.client,
      slugify(form.querySelector('[name="label"]').value), state.home, state.pathSeparator);
  });
  let pending = [];
  doc.addEventListener('change', event => {
    const source = event.target;
    const path = source.dataset.path ?? source.dataset.actorPath ?? source.dataset.actor;
    if (!path) return;
    resets.delete(path);
    for (const control of controls) {
      const sameKind = Boolean(source.dataset.actor) === Boolean(control.dataset.actor);
      if (control !== source && sameKind && (control.dataset.path ?? control.dataset.actorPath ?? control.dataset.actor) === path) {
        if (source.type === 'checkbox') control.checked = source.checked;
        else control.value = source.value;
      }
    }
    updateDots();
  });
  const error = reason => { doc.querySelector('#status').textContent = ''; doc.querySelector('#error').textContent = reason; };
  const status = message => { doc.querySelector('#error').textContent = ''; doc.querySelector('#status').textContent = message; };
  let removing = null;
  const cancelRemove = () => {
    if (!removing) return;
    removing.querySelector('[data-account-remove-confirm]').hidden = true;
    removing.querySelector('[data-account-remove-open]').hidden = false;
    removing.querySelector('[data-account-remove-open]').focus();
    removing = null;
  };
  const showReview = () => {
    const review = doc.getElementById('review');
    review.hidden = false;
    review.scrollIntoView?.({ block: 'nearest' });
    review.focus?.({ preventScroll: true });
  };
  const request = async (path, method, value, keepalive = false) => {
    const response = await win.fetch(path, { method, credentials: 'same-origin', keepalive,
      headers: { 'x-okit-token': params.token ?? '', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, value: await response.json() };
  };
  const collect = () => {
    const changes = new Map();
    const put = change => changes.set(change.path, change);
    for (const control of controls.filter(control => control.dataset.actor)) {
      if (control.checked !== initial.get(control)) put(control.checked
        ? { path: control.dataset.actor, unset: true } : { path: control.dataset.actor, value: null });
    }
    for (const control of controls.filter(control => !control.dataset.actor && !control.readOnly)) {
      const path = control.dataset.path ?? control.dataset.actorPath;
      const parent = path.split('.').slice(0, -1).join('.');
      const actor = controls.find(item => item.dataset.actor === parent);
      if (control.dataset.actorPath && actor && !actor.checked) continue;
      if (resets.has(path)) put({ path, unset: true });
      else if (JSON.stringify(read(control)) !== JSON.stringify(initial.get(control))) put({ path, value: read(control) });
    }
    return [...changes.values()];
  };
  const reloadState = async () => {
    const result = await request(`/api/state?locale=${encodeURIComponent(state.locale)}`, 'GET');
    if (result.status !== 200) throw new Error(result.value.reason);
    win.location.reload();
  };
  const checkAccounts = async client => {
    const result = await request(`/api/state?locale=${encodeURIComponent(state.locale)}`, 'GET');
    if (result.status !== 200) return error(result.value.reason);
    for (const row of all('tr[data-account-id]').filter(row => row.dataset.client === client)) {
      const account = result.value.accounts.find(account => account.client === client && account.id === row.dataset.accountId);
      if (!account) continue;
      const [kind, key] = account.login === 'logged-in' ? ['ready', 'loggedIn']
        : account.login === 'logged-out' ? ['waiting', 'notLoggedIn'] : ['unknown', 'loginUnknown'];
      const badge = row.querySelector('.badge');
      badge.className = `badge ${kind}`;
      badge.textContent = text[key];
      badge.title = text[`${key}Title`];
      row.querySelector('[data-account-login-help]').hidden = account.login === 'logged-in';
      row.querySelector('[data-action="account-login"]').hidden = account.login !== 'logged-in';
      row.querySelector('code').textContent = account.loginCommand;
    }
  };
  const save = async () => {
    for (;;) {
      const result = await request('/api/config', 'PUT', { expectedMtime: state.expectedMtime, changes: pending });
      if (result.status === 200) return reloadState();
      error(result.value.reason ?? text.error);
      if (result.status === 409) doc.getElementById('reload').hidden = false;
      if (result.status !== 422 || !/not confirmed/i.test(result.value.reason)) return;
      const change = pending.find(change => /\.model$/.test(change.path) && !change.unset && !change.confirm
        && (!state.actors.length || state.actors.some(actor => actor.classes.some(row => `${row.path}.model` === change.path
          && !row.modelChoices.some(choice => choice.model === change.value && choice.confirmed)))));
      if (!change) return;
      error(text.confirmModel);
      showReview();
      pending = pending.map(item => item === change ? { ...item, confirm: true } : item);
      return;
    }
  };
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancelRemove();
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next]);
    tabs[next].focus();
  });
  doc.addEventListener('click', async event => {
    const target = event.target.closest('[data-action]');
    const row = target?.closest?.('tr[data-account-id]');
    const confirmRemove = removing && row === removing && target?.dataset.action === 'account-remove'
      && target.dataset.confirm === 'true';
    cancelRemove();
    const tab = event.target.closest('[role="tab"]');
    if (tabs.includes(tab)) { selectTab(tab); return; }
    if (!target) return;
    try {
      const action = target.dataset.action;
      if (['account-add', 'account-rename', 'account-remove'].includes(action) && controls.some(isDirty)) {
        return error(text.accountSaveFirst);
      }
      if (action === 'account-remove') {
        if (!row || target.dataset.accountId === 'default' || target.dataset.cancel === 'true') return;
        if (!confirmRemove) {
          removing = row;
          row.querySelector('[data-account-remove-confirm]').hidden = false;
          row.querySelector('[data-account-remove-open]').hidden = true;
          row.querySelector('[data-confirm="true"]').focus();
          return;
        }
        const result = await request('/api/account-remove', 'POST', { client: target.dataset.client, id: target.dataset.accountId });
        if (result.status === 200) await reloadState(); else error(result.value.reason);
      } else if (action === 'account-add' || action === 'account-rename') {
        const value = { client: target.dataset.client };
        if (action === 'account-add') {
          const form = target.closest('[data-account-add]');
          value.label = form.querySelector('[name="label"]').value;
          value.configDir = form.querySelector('[name="configDir"]').value;
        } else {
          value.id = target.dataset.accountId;
          value.label = row.querySelector('input[data-rename-account]').value;
        }
        const result = await request(action === 'account-add' ? '/api/account-add' : '/api/account-label',
          action === 'account-add' ? 'POST' : 'PUT', value);
        if (result.status === 200) await reloadState(); else error(result.value.reason);
      } else if (action === 'account-login') {
        row.querySelector('[data-account-login-help]').hidden = false;
        target.hidden = true;
        row.querySelector('[data-action="account-terminal"]').focus();
      } else if (action === 'account-terminal') {
        target.disabled = true;
        try {
          const result = await request('/api/account-login', 'POST', { client: target.dataset.client, id: target.dataset.accountId });
          if (result.status === 200) {
            const reasons = { 'no-terminal': text.accountTerminalNoTerminal,
              'unsafe-folder': text.accountTerminalUnsafeFolder, 'unsupported-client': text.accountTerminalUnsupported };
            status(result.value.launched === true ? (target.dataset.client === 'claude-code'
              ? text.accountTerminalOpenedClaude : text.accountTerminalOpened)
              : Object.hasOwn(reasons, result.value.reason) ? reasons[result.value.reason] : text.accountTerminalNoTerminal);
          } else error(result.value.reason);
        } finally { target.disabled = false; target.focus(); }
      } else if (action === 'account-check') await checkAccounts(target.dataset.client);
      else if (action === 'account-copy') {
        const code = row.querySelector('code');
        try {
          await win.navigator.clipboard.writeText(code.textContent);
          status(text.accountCopied);
        } catch {
          const range = doc.createRange();
          range.selectNodeContents(code);
          const selection = win.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          status(text.accountCopyFallback);
        }
      } else if (action === 'review') {
        pending = collect();
        doc.getElementById('changes').textContent = pending.map(change => {
          const control = controls.find(item => (item.dataset.path ?? item.dataset.actorPath ?? item.dataset.actor) === change.path);
          return `${change.path}\n${text.before}: ${JSON.stringify(initial.get(control))}\n${text.after}: ${change.unset ? text.defaultValue : JSON.stringify(change.value)}`;
        }).join('\n\n');
        showReview();
      } else if (action === 'apply') await save();
      else if (action === 'cancel') { pending = []; doc.getElementById('review').hidden = true; }
      else if (action === 'reload') win.location.reload();
      else if (action === 'reset') { resets.add(target.dataset.reset); updateDots(); error(text.defaultValue); }
      else if (action === 'close') {
        const result = await request('/api/close', 'POST', {});
        error(result.status === 200 ? text.closed : result.value.reason);
      } else if (action === 'refresh' || action === 'label') {
        const value = { client: target.dataset.client };
        if (action === 'label') {
          value.id = target.dataset.account;
          value.label = all('input[data-account]').find(input => input.dataset.client === value.client && input.dataset.account === value.id).value;
        }
        const result = await request(action === 'label' ? '/api/account-label' : '/api/models/refresh', action === 'label' ? 'PUT' : 'POST', value);
        if (result.status === 200) await reloadState(); else error(result.value.reason);
      }
    } catch (failure) { error(failure.message); }
  });
  // Listen through the document's window, keeping the injected environment self-contained.
  const keepalive = () => {
    request('/api/keepalive', 'POST', { instance: state.instance }, true).catch(() => {});
  };
  keepalive();
  doc.defaultView.addEventListener('pageshow', event => {
    if (event.persisted) keepalive();
  });
  doc.defaultView.addEventListener('pagehide', () => {
    request('/api/close', 'POST', { grace: true, instance: state.instance }, true).catch(() => {});
  });
}

export const clientSource = () => '(' + clientMain.toString()
  + ')(window, ' + accountSlug.toString() + ', ' + proposedAccountFolder.toString() + ')';
