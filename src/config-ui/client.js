export function clientMain(win) {
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
  const updateDots = () => {
    for (const tab of tabs) {
      const panel = doc.getElementById(tab.getAttribute('aria-controls'));
      const dirty = controls.some(control => {
        if (!panel.contains(control)) return false;
        const path = control.dataset.path ?? control.dataset.actorPath ?? control.dataset.actor;
        try { return resets.has(path) || JSON.stringify(read(control)) !== JSON.stringify(initial.get(control)); }
        catch { return true; }
      });
      tab.classList.toggle('has-edits', dirty);
    }
  };
  if (tabs.length) selectTab(tabs.find(tab => win.location.hash === `#tab=${tab.dataset.tab}`) ?? tabs[0]);
  doc.addEventListener('input', updateDots);
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
  const error = reason => { doc.getElementById('error').textContent = reason; };
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
    const tab = event.target.closest('[role="tab"]');
    if (tabs.includes(tab)) { selectTab(tab); return; }
    const target = event.target.closest('[data-action]');
    if (!target) return;
    try {
      const action = target.dataset.action;
      if (action === 'review') {
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

export const clientSource = () => '(' + clientMain.toString() + ')(window)';
