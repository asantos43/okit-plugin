import { clientSource } from './client.js';
import { wizardConfig } from './wizard-config.js';
import { wizardFlow } from './wizard-flow.js';

export function wizardMain(win, createFlow, bridgeConfig, startConfig) {
  const doc = win.document;
  const boot = JSON.parse(doc.getElementById('state').textContent);
  const token = new win.URLSearchParams(win.location.search).get('token') ?? '';
  win.history.replaceState(null, '', win.location.pathname);
  const byId = (id) => doc.getElementById(`wizard-${id}`);
  const all = (selector) => [...doc.querySelectorAll(selector)];
  const api = async (path, method, input) => {
    const response = await win.fetch(path, { method, headers: { 'x-okit-token': token,
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, value: await response.json() };
  };
  let lastScreen, lastLocale, timer, polling = false, resolveWrite;
  const text = () => boot.catalogs[flow.state.locale].wizard;
  const write = (value) => new Promise((resolve) => {
    resolveWrite = resolve;
    const dialog = byId('write'); dialog.querySelector('pre').textContent = JSON.stringify(value, null, 2);
    dialog.showModal();
  });
  const flow = createFlow(boot, api, render);
  const config = bridgeConfig(win, token, startConfig, write, boot.locale, (fresh) => {
    boot.actors = fresh.actors; boot.expectedMtime = fresh.expectedMtime; render(flow.state);
  });
  const element = (tag, value, parent) => {
    const node = doc.createElement(tag); if (value !== undefined) node.textContent = value;
    parent?.append(node); return node;
  };
  function button(action, label, disabled = false) {
    const node = element('button', label, byId('actions'));
    node.type = 'button'; node.dataset.wizard = action; node.disabled = disabled; return node;
  }
  function check(key, label, checked, parent = byId('choices'), disabled = false) {
    const wrapper = element('label', undefined, parent);
    const input = element('input', undefined, wrapper); input.type = 'checkbox';
    input.dataset.choice = key; input.checked = Boolean(checked); input.disabled = disabled;
    element('span', label, wrapper); return input;
  }
  function buildScreen(state) {
    byId('body').replaceChildren(); byId('actions').replaceChildren(); byId('choices').replaceChildren();
    const t = text();
    if (state.screen === 'detect' || state.screen === 'review') {
      for (const row of boot.wizard.detection) check(`client:${row.client}`,
        `${row.client}: ${row.executable ?? t.failed} ${row.version ?? ''}`, state.clients.includes(row.client));
      for (const option of ['noPath', 'noLink', 'noStatusline']) check(option, t[option], state.options[option]);
      check('autostart', t.autostart, false, byId('choices'), true);
      if (boot.wizard.platform === 'win32') check('policy', t.policy, state.policy);
    }
    if (state.screen === 'detect') button('requirements', t.next, !flow.allowed());
    if (state.screen === 'requirements') {
      for (const item of boot.wizard.requirements) element('p', `${t[item.key]}: ${item.ok ? t.ok : t.failed}
        ${item.actual ?? item.path ?? ''} ${item.required ?? ''} ${item.ok ? '' : t[item.remedyKey]}`, byId('body'));
      element('p', t.localTools, byId('body')); button('detect', t.back); button('review', t.preview, !flow.allowed());
    }
    if (state.screen === 'review') { button('review', t.preview); button('apply', t.apply, true); button('detect', t.back); }
    if (state.screen === 'applying') button('cancel', t.cancel, !state.active);
    if (state.screen === 'models') {
      const select = element('select', undefined, element('label', t.models, byId('body')));
      select.id = 'wizard-client';
      for (const row of state.job?.result?.clients ?? []) if (row.state === 'ok') {
        const option = element('option', row.client, select); option.value = row.client;
      }
      select.value = state.modelClient ?? select.value; state.modelClient = select.value;
      button('setup-preview', t.preview, !select.value); button('followup', t.apply, true); button('panel', t.next);
    }
    if (state.screen === 'panel') {
      const claude = state.job?.result?.clients.some((row) => row.client === 'claude-code' && row.state === 'ok');
      if (claude) { button('panel-preview', t.preview); button('followup', t.apply, true); }
      button('accounts', t.skip);
    }
    if (state.screen === 'accounts') { element('p', t.collectors, byId('body')); button('reload', t.next); }
    if (state.screen === 'reload') {
      element('p', boot.wizard.activationMessage, byId('body')); element('p', t.restart, byId('body'));
      element('pre', JSON.stringify(state.options, null, 2), byId('body'));
      element('pre', JSON.stringify(state.plan?.plan.mutations.filter((item) => /path|profile/i.test(item.kind)) ?? [], null, 2), byId('body'));
      if (state.policy && state.job?.result?.clients.some((row) => row.state === 'ok')) {
        button('policy-preview', t.policy); button('followup', t.apply, true);
      }
      button('result', t.next);
    }
    if (state.screen === 'result') {
      element('p', t.pending, byId('body'));
      const clients = state.job?.result?.clients ?? [];
      if (clients.some((row) => row.state === 'ok') && clients.some((row) => row.state !== 'ok')) element('p', t.partial, byId('body'));
      for (const row of clients) element('p', `${row.client}: ${t[row.state]} ${row.reason ?? ''}`, byId('body'));
      element('pre', JSON.stringify(boot.wizard.recovery, null, 2), byId('body'));
      button('config', t.next);
    }
  }
  let lastTakeover;
  function render(state, focus = false) {
    const t = text(), transition = lastScreen !== state.screen || lastLocale !== state.locale;
    if (transition) { buildScreen(state); lastScreen = state.screen; lastLocale = state.locale; }
    byId('heading').textContent = t[state.screen];
    byId('error').textContent = state.error;
    byId('consent-label').hidden = !(state.screen === 'review' && state.plan || state.preview);
    byId('consent').checked = state.consent;
    byId('unknown-label').hidden = state.screen !== 'models'; byId('unknown').checked = state.unknown;
    byId('preview').textContent = state.screen === 'review' ? JSON.stringify(state.plan?.plan ?? {}, null, 2)
      : state.preview ? JSON.stringify(state.preview.preview, null, 2) : '';
    // `{key}` takes its value from the event's params (the params themselves, `values`, or an object of `args`);
    // a key with no value is empty, as in the terminal presenter. Only text is produced: textContent escapes it.
    const fill = (text, params = {}) => {
      let label = String(text);
      const values = Object.assign({}, ...(Array.isArray(params.args) ? params.args.filter((item) => item && typeof item === 'object') : []),
        params.values ?? {}, params);
      // A key the catalogs do not know (the output of a child process) keeps its generic label and shows the message.
      if (!/\{\w+\}/.test(label) && typeof values.message === 'string') label = `${label}: ${values.message}`;
      return String(label).replace(/\{(\w+)\}/g, (_, key) => (['string', 'number', 'boolean'].includes(typeof values[key]) ? String(values[key]) : ''));
    };
    const events = state.events.map((event) => {
      const label = boot.installLabels?.[state.locale]?.[event.messageKey] ?? t[event.messageKey] ?? t.event;
      return `${event.client ?? ''} ${event.status}: ${fill(label, event.params)}`.replace(/\s+$/, '');
    });
    byId('events').hidden = !['applying', 'result', 'reload'].includes(state.screen);
    byId('events').textContent = events.join('\n');
    byId('boundaries').hidden = !['applying', 'result'].includes(state.screen);
    byId('boundaries').textContent = `${t.cancelNote}\n${t.completed}: ${JSON.stringify(state.job?.completed ?? [])}
      ${t.remaining}: ${JSON.stringify(state.job?.remaining ?? [])}\n${JSON.stringify(state.job?.followups ?? [], null, 2)}`;
    for (const node of all('[data-wizard="apply"]')) node.disabled = !state.consent || !state.plan?.plan.reviewable || !flow.allowed() || !state.owns;
    for (const node of all('[data-wizard="followup"]')) node.disabled = !state.consent || !state.preview || state.active || !state.owns;
    for (const node of all('[data-wizard="requirements"]')) node.disabled = !flow.allowed();
    for (const node of all('[data-wizard="panel"], [data-wizard="accounts"], [data-wizard="result"]')) node.disabled = state.active;
    if (lastTakeover !== state.takeover || transition) {
      byId('existing').replaceChildren(); lastTakeover = state.takeover;
      if (state.takeover) { element('p', t.takeover, byId('existing'));
        const take = element('button', t.take, byId('existing')); take.type = 'button'; take.dataset.wizard = 'take'; }
    }
    byId('status').textContent = state.active ? t.applying : state.job?.followups?.length
      ? JSON.stringify(state.job.followups.map((item) => ({ kind: item.kind, state: item.state, reason: item.reason }))) : '';
    showControls(state);
    showQuestion(state.job?.question);
    if (focus || transition) (state.error ? byId('error') : byId('heading')).focus();
  }
  let questionId;
  function showQuestion(question) {
    if (questionId === question?.questionId) return;
    questionId = question?.questionId; byId('question').replaceChildren();
    if (!question) return;
    element('h3', text().question, byId('question'));
    element('p', question.message, byId('question'));
    element('pre', JSON.stringify(question.preview, null, 2), byId('question'));
    for (const answer of ['yes', 'no']) { const node = element('button', text()[answer], byId('question'));
      node.type = 'button'; node.dataset.wizard = answer; }
  }
  function showControls(state) {
    const visible = ['models', 'accounts', 'config'].includes(state.screen);
    doc.getElementById('configuration').hidden = !visible;
    doc.getElementById('config-footer').hidden = state.screen !== 'config';
    doc.querySelector('.tabs').hidden = state.screen !== 'config';
    if (state.screen !== 'config') for (const panel of all('[role="tabpanel"]')) {
      panel.hidden = panel.id !== (state.screen === 'models' ? 'panel-actors' : state.screen === 'accounts' ? 'panel-accounts' : '');
    }
    for (const node of all('[data-actor], [data-actor-path$=".maxTurns"]')) node.disabled = state.screen === 'models';
    if (state.screen === 'models') for (const card of all('#panel-actors .actor-card')) card.hidden = card.querySelector('h3').textContent !== state.modelClient;
    if (state.screen === 'config') { doc.getElementById('wizard').hidden = true;
      doc.querySelector('[data-tab="actors"]').click(); for (const card of all('#panel-actors .actor-card')) card.hidden = false; }
  }
  async function poll() {
    if (polling) return;
    win.clearTimeout(timer); polling = true;
    let retry = true;
    try { retry = await flow.poll(); }
    catch { flow.state.error = text().retry; render(flow.state); }
    finally { polling = false; if (retry) timer = win.setTimeout(poll, 1000); }
  }
  function profiles() {
    const client = flow.state.modelClient;
    const actor = boot.actors.find((item) => item.client === client);
    return actor?.classes.filter((row) => ['simple', 'normal', 'hard'].includes(row.class) && row.enabled).map((row) => ({
      class: row.class,
      model: doc.querySelector(`[data-actor-path="${row.path}.model"]`).value,
      effort: doc.querySelector(`[data-actor-path="${row.path}.effort"]`).value,
      ...(flow.state.unknown ? { confirm: true } : {}) })) ?? [];
  }
  doc.addEventListener('change', async (event) => {
    const node = event.target;
    if (node.id === 'wizard-consent') return flow.consent(node.checked);
    if (node.id === 'wizard-unknown') return flow.change('unknown', node.checked);
    if (node.id === 'wizard-client') return flow.change('modelClient', node.value);
    if (node.dataset.choice?.startsWith('client:')) {
      return flow.change('clients', all('[data-choice^="client:"]').filter((input) => input.checked).map((input) => input.dataset.choice.slice(7)));
    }
    if (node.dataset.choice === 'policy') return flow.change('policy', node.checked);
    if (node.dataset.choice) return flow.change('options', { ...flow.state.options, [node.dataset.choice]: node.checked });
    if (node.dataset.actorPath) flow.change('unknown', false);
    if (node.id === 'wizard-locale') {
      try {
        const locale = node.value;
        const fresh = await config.refresh(true, locale);
        boot.actors = fresh.actors; boot.expectedMtime = fresh.expectedMtime;
        flow.change('locale', locale); questionId = null;
        doc.documentElement.lang = locale;
        byId('consent-label').lastChild.textContent = text().consent;
        byId('unknown-label').lastChild.textContent = text().unknown;
        if (flow.state.screen === 'review') await flow.review();
        render(flow.state, true);
      } catch { flow.fail(text().retry); }
    }
  });
  doc.addEventListener('input', (event) => {
    if (event.target.dataset.actorPath) flow.change('unknown', false);
  });
  doc.addEventListener('click', async (event) => {
    const writeButton = event.target.closest('[data-write]');
    if (writeButton) { byId('write').close(); resolveWrite?.(writeButton.dataset.write === 'yes'); resolveWrite = null; return; }
    const target = event.target.closest('[data-wizard]');
    if (!target) return;
    const action = target.dataset.wizard;
    try {
      if (action === 'review') await flow.review();
      else if (action === 'apply') { await flow.apply(); await poll(); }
      else if (action === 'take') { flow.take(); await poll(); }
      else if (action === 'cancel') await flow.cancel();
      else if (action === 'yes' || action === 'no') await flow.answer(action === 'yes');
      else if (action === 'setup-preview') {
        const current = await api('/api/state', 'GET');
        await flow.preview('setup', flow.state.modelClient, { expectedMtime: current.value.expectedMtime, profiles: profiles() });
      } else if (action === 'panel-preview') await flow.preview('panel', 'claude-code');
      else if (action === 'policy-preview') await flow.preview('policy', flow.state.job.result.clients.find((row) => row.state === 'ok').client);
      else if (action === 'followup') { await flow.followup(); await poll(); }
      else { flow.go(action); }
    } catch { flow.fail(text().error); }
  });
  byId('write').addEventListener('cancel', () => { resolveWrite?.(false); resolveWrite = null; });
  // Config actions keep their existing presenter. During setup only model fields
  // participate; account writes are reviewed by the fetch bridge above.
  doc.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'close') {
      event.stopImmediatePropagation(); void api('/api/close', 'POST', {}); return;
    }
    if (!['accounts', 'config'].includes(flow.state.screen)) event.stopImmediatePropagation();
  }, true);
  render(flow.state, true); void poll();
  return flow;
}

export const wizardSource = () => `(${wizardMain.toString()})(window, ${wizardFlow.toString()},
  ${wizardConfig.toString()}, function(configWindow) { ${clientSource('configWindow')} });`;
