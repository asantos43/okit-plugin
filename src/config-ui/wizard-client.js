import { clientSource } from './client.js';
import { wizardConfig } from './wizard-config.js';
import { wizardFlow } from './wizard-flow.js';
import { planSummary, previewSummary } from './wizard-summary.js';

export function wizardMain(win, createFlow, bridgeConfig, startConfig, summarize = { plan: planSummary, preview: previewSummary }) {
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
  const clientName = (client) => text().clientNames?.[client] ?? String(client ?? '');
  // `{key}` takes its value from the given values; a key with no value is empty. Only text is produced: textContent escapes it.
  const say = (template, values = {}) => String(template ?? '').replace(/\{(\w+)\}/g,
    (_, key) => (['string', 'number', 'boolean'].includes(typeof values[key]) ? String(values[key]) : ''));
  // The one place where JSON may be shown: a collapsed "View details" block, never the main text.
  const details = (parent, value) => {
    const block = element('details', undefined, parent); block.className = 'wizard-details';
    element('summary', text().details, block); element('pre', JSON.stringify(value, null, 2), block); return block;
  };
  let reasonNode;
  // What blocks Next, said once. A failing requirement is already listed above the options, so it is not repeated here.
  const reason = () => {
    if (flow.allowed()) return '';
    if (flow.state.clients.length === 0) return text().missing;
    return boot.wizard.requirements.some((item) => !item.ok) ? '' : text().missing;
  };
  function buildScreen(state) {
    byId('body').replaceChildren(); byId('actions').replaceChildren(); byId('choices').replaceChildren();
    const t = text();
    reasonNode = null; bodySignature = null;
    if (state.screen === 'detect') {
      const found = boot.wizard.detection.filter((row) => row.installed);
      for (const row of boot.wizard.detection) {
        if (row.installed) check(`client:${row.client}`, say(t.installClient, { client: clientName(row.client) }), state.clients.includes(row.client));
        else element('p', say(t.clientMissing, { client: clientName(row.client) }), byId('choices')).className = 'wizard-note';
      }
      if (!found.length) element('p', t.missing, byId('choices')).className = 'wizard-note';
      const failing = boot.wizard.requirements.filter((item) => !item.ok);
      if (failing.length) {
        element('p', t.notReady, byId('body')).className = 'wizard-state-bad';
        const lines = new Set();
        for (const item of failing) lines.add(`${t[item.key]}${item.path ? ` (${item.path})` : ''}: ${t[item.remedyKey]}`);
        for (const line of lines) element('p', line, byId('body'));
      } else element('p', t.allReady, byId('body')).className = 'wizard-state-ok';
      const options = element('details', undefined, byId('body')); options.className = 'wizard-options';
      element('summary', t.options, options);
      for (const option of ['noPath', 'noLink', 'noStatusline']) check(option, t[option], state.options[option], options);
      if (boot.wizard.platform === 'win32') check('policy', t.policy, state.policy, options);
      element('p', t.autostartNote, byId('body')).className = 'wizard-note';
      const installed = Object.entries(boot.wizard.installed ?? {});
      if (installed.length) {
        element('p', `${t.installedNote}: ${installed.map(([client, row]) => `${clientName(client)} ${row.version ?? ''}`.trim()).join(', ')}`, byId('body'));
        for (const [operation, label] of [['update', t.update], ['repair', t.repair], ['models', t.changeModels]]) button(`rerun:${operation}`, label);
      }
      button('review', t.next, !flow.allowed());
      reasonNode = element('p', reason(), byId('body')); reasonNode.className = 'wizard-reason';
    }
    if (state.screen === 'review') { button('detect', t.back); button('review', t.preview, true); button('apply', t.apply, true); }
    if (state.screen === 'applying') button('cancel', t.cancel, !state.active);
    if (state.screen === 'models') {
      const select = element('select', undefined, element('label', t.models, byId('body')));
      select.id = 'wizard-client';
      for (const row of state.job?.result?.clients ?? []) if (row.state === 'ok') {
        const option = element('option', row.client, select); option.value = row.client;
      }
      select.value = state.modelClient ?? select.value; state.modelClient = select.value;
      button('result', t.backToDone); button('setup-preview', t.preview, !select.value); button('followup', t.apply, true);
    }
    if (state.screen === 'accounts') { element('p', t.collectors, byId('body')); button('result', t.backToDone); }
    if (state.screen === 'result') { button('config', t.openConfig); }
  }
  // The done screen: what was done per client, then the optional steps as a checklist (each one with its own button).
  let bodySignature;
  function buildDone(state) {
    const t = text(), body = byId('body');
    const clients = state.job?.result?.clients ?? [];
    const signature = JSON.stringify([state.locale, clients, state.job?.followups, state.preview?.followupId, state.followupKind, state.active]);
    if (signature === bodySignature) return;
    bodySignature = signature; body.replaceChildren();
    const anyOk = clients.some((row) => row.state === 'ok');
    for (const row of clients) {
      const line = element('p', `${row.state === 'ok' ? '✓' : '✗'} ${clientName(row.client)}: ${t[row.state] ?? row.state}${row.reason ? ` (${row.reason})` : ''}`, body);
      line.className = row.state === 'ok' ? 'wizard-state-ok' : 'wizard-state-bad';
    }
    if (anyOk && clients.some((row) => row.state !== 'ok')) element('p', t.partial, body);
    if (!anyOk) return element('p', t.failedHelp, body);
    element('h3', t.nextSteps, body);
    const list = element('ul', undefined, body); list.className = 'wizard-checklist';
    const followup = (kind) => state.job?.followups?.find((item) => item.kind === kind);
    const step = (kind, title, run) => {
      const item = element('li', undefined, list), done = followup(kind);
      const mark = done ? (done.state === 'ok' ? t.stepDone : t[done.state] ?? done.state) : t.stepPending;
      element('span', `${done?.state === 'ok' ? '✓' : '○'} ${title}: ${mark}`, item);
      if (run && !(done?.state === 'ok')) {
        const open = element('button', run.label, item); open.type = 'button'; open.dataset.wizard = run.action; open.disabled = state.active;
        if (state.followupKind === kind && state.preview) {
          const apply = element('button', t.apply, item); apply.type = 'button'; apply.dataset.wizard = 'followup'; apply.disabled = true;
        }
      }
    };
    step('setup', t.stepModels, { label: t.chooseModels, action: 'models' });
    if (clients.some((row) => row.client === 'claude-code' && row.state === 'ok')) step('panel', t.stepPanel, { label: t.preview, action: 'panel-preview' });
    step('accounts', t.stepAccounts, { label: t.setUpAccounts, action: 'accounts' });
    if (state.policy && boot.wizard.platform === 'win32') step('policy', t.policy, { label: t.preview, action: 'policy-preview' });
    // One sentence: how to reach the command (in the language on screen), then the restart; never two "open a new terminal".
    const activation = boot.wizard.activationMessages?.[state.locale]?.replace(/[.\s]+$/, '');
    element('p', activation ? `${activation}. ${t.restartAfter}` : t.restart, body);
    const recovery = (boot.wizard.recovery ?? []).map((item) => [item.command, ...(item.args ?? [])].join(' '));
    if (recovery.length) element('p', `${t.recoveryNote} ${recovery.join(' · ')}`, body);
  }
  // The text of a plan or follow-up preview: short lines per client, JSON only inside the collapsed block.
  let summaryKey, progressNode, planningSince = 0;
  function showSummary(state) {
    const t = text(), box = byId('preview');
    const key = state.screen === 'review' ? (state.planning ? 'planning' : state.plan ? `plan:${state.plan.planId}:${state.locale}` : 'none')
      : state.preview ? `preview:${state.preview.followupId}:${state.locale}` : 'none';
    if (key === summaryKey) return;
    summaryKey = key; box.replaceChildren(); progressNode = null;
    if (key === 'planning') {
      planningSince = Date.now();
      progressNode = element('p', '', box); progressNode.setAttribute('role', 'status'); progressNode.className = 'wizard-progress';
      tickProgress(); return;
    }
    if (state.screen === 'review' && state.plan) {
      const summary = summarize.plan(state.plan.plan);
      if (summary.conflicts) element('p', say(t.conflicts, { count: summary.conflicts }), box).className = 'wizard-state-bad';
      element('p', say(t.planTotal, { count: summary.total }), box);
      for (const entry of summary.clients) {
        const card = element('section', undefined, box); card.className = 'wizard-client';
        element('h3', entry.client ? clientName(entry.client) : t.sharedGroup, card);
        const list = element('ul', undefined, card);
        if (entry.files) element('li', entry.packaged ? t.packageDownloaded : say(t.packageFiles, { count: entry.files }), list);
        for (const item of entry.shown) element('li', `${t.kinds[item.kind] ?? t.kinds.other}: ${item.path}`, list);
        if (entry.more) element('li', say(t.andMore, { count: entry.more }), list);
        if (!entry.files && !entry.shown.length) element('li', t.nothingToChange, list);
      }
      details(box, state.plan.plan);
    } else if (state.preview) {
      const list = element('ul', undefined, box);
      for (const line of summarize.preview(state.preview.preview)) {
        element('li', say(t.previewLines[line.kind] ?? t.previewLines.other, { a: line.a, b: line.b, c: line.c }), list);
      }
      details(box, state.preview.preview);
    }
  }
  function tickProgress() {
    if (!progressNode) return;
    const seconds = Math.max(0, Math.floor((Date.now() - planningSince) / 1000));
    progressNode.textContent = `${text().calculating} ${text().calcStage} (${seconds} s)`;
    win.setTimeout(tickProgress, 1000);
  }
  // The stages of the installation, one line each: done, in progress, failed or waiting.
  function showStages(state) {
    const t = text(), box = byId('boundaries');
    box.replaceChildren();
    if (!['applying'].includes(state.screen)) { box.hidden = true; return; }
    box.hidden = false;
    const job = state.job ?? {}, completed = job.completed ?? [], remaining = job.remaining ?? [];
    const failed = job.state === 'failed' || state.job?.result?.clients?.some((row) => row.state === 'failed');
    const list = element('ul', undefined, box); list.className = 'wizard-stages';
    const stages = [...completed.map((id) => [id, 'done']), ...remaining.map((id, index) => [id, index === 0 ? (failed ? 'failed' : 'running') : 'waiting'])];
    const marks = { done: '✓', running: '…', failed: '✗', waiting: '·' };
    const names = { done: t.stageDone, running: t.stageRunning, failed: t.stageFailed, waiting: t.stageWaiting };
    for (const [id, status] of stages) {
      const [client, ...rest] = id.split(':'), key = rest.join(':');
      const label = say(boot.installLabels?.[state.locale]?.[key] ?? key, { client: clientName(client) });
      element('li', `${marks[status]} ${stages.some(([other]) => other.split(':')[0] !== client) ? `${clientName(client)}: ` : ''}${label}: ${names[status]}`, list);
    }
    if (!stages.length) element('li', t.starting, list);
    element('p', t.cancelNote, box);
  }
  let lastTakeover;
  function render(state, focus = false) {
    const t = text(), transition = lastScreen !== state.screen || lastLocale !== state.locale;
    if (transition) { buildScreen(state); lastScreen = state.screen; lastLocale = state.locale; summaryKey = null; }
    doc.documentElement.dataset.screen = state.screen;
    byId('heading').textContent = t[state.screen];
    byId('error').textContent = state.error;
    byId('consent-label').hidden = !(state.screen === 'review' && state.plan || state.preview);
    byId('consent').checked = state.consent;
    byId('unknown-label').hidden = state.screen !== 'models'; byId('unknown').checked = state.unknown;
    if (state.screen === 'result') buildDone(state);
    showSummary(state);
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
    // The raw lines are technical output: they stay in a collapsed block, apart from the stage list.
    const shownEvents = ['applying', 'result'].includes(state.screen) && events.length > 0;
    byId('events').hidden = !shownEvents; if (byId('technical')) byId('technical').hidden = !shownEvents;
    byId('events').textContent = events.join('\n');
    showStages(state);
    for (const node of all('[data-wizard="apply"]')) node.disabled = !state.consent || !state.plan?.plan.reviewable || !flow.allowed() || !state.owns;
    for (const node of all('[data-wizard="followup"]')) node.disabled = !state.consent || !state.preview || state.active || !state.owns;
    if (state.screen === 'detect') {
      for (const node of all('[data-wizard="review"]')) node.disabled = !flow.allowed();
      if (reasonNode) reasonNode.textContent = reason();
    }
    if (state.screen === 'review') for (const node of all('[data-wizard="review"]')) node.disabled = state.planning;
    if (lastTakeover !== state.takeover || transition) {
      byId('existing').replaceChildren(); lastTakeover = state.takeover;
      if (state.takeover) { element('p', t.takeover, byId('existing'));
        const take = element('button', t.take, byId('existing')); take.type = 'button'; take.dataset.wizard = 'take'; }
    }
    byId('status').textContent = state.active ? t.applying : '';
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
    details(byId('question'), question.preview);
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
        const language = node.parentNode?.firstChild, summary = byId('technical')?.querySelector?.('summary');
        if (language) language.textContent = `${boot.catalogs[locale].tablanguage} `;
        if (summary) summary.textContent = text().technical;
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
      if (action.startsWith('rerun:')) await flow.rerun(action.slice(6));
      else if (action === 'review') await flow.review();
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
  ${wizardConfig.toString()}, function(configWindow) { ${clientSource('configWindow')} },
  { plan: ${planSummary.toString()}, preview: ${previewSummary.toString()} });`;
