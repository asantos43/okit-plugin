// Human CLI views are kept separate from the presenter embedded in release scripts.
import { createPresenter as basePresenter, TEXTS as BASE_TEXTS, clientLabel as baseClientLabel,
  redactingWriter, localizeReason } from './install/present.js';
export * from './install/present.js';

export const TEXTS = Object.freeze({ ...BASE_TEXTS,
  stepPlanned: { en: 'planned', 'pt-BR': 'planejado' },
  clientChoose: { en: 'Choose a coding client before installing.', 'pt-BR': 'Escolha um cliente de programação antes de instalar.' },
  clientAsk: { en: 'Choose a client [1–3, or all]:', 'pt-BR': 'Escolha um cliente [1–3, ou all]:' },
  autostartAsk: { en: 'Background service — runs waiting work while your client is closed. Start it with this machine? [y/N]:', 'pt-BR': 'Serviço em segundo plano — executa trabalhos em espera enquanto o cliente está fechado. Iniciar com esta máquina? [s/N]:' },
  autostartAlready: { en: 'Automatic start is on. Check it: {command} doctor', 'pt-BR': 'Início automático ligado. Verifique: {command} doctor' },
  autostartLater: { en: 'Automatic start is off. To enable it later: {command} setup', 'pt-BR': 'Início automático desligado. Para ativar depois: {command} setup' },
  autostartInstalled: { en: 'Automatic start is on. Check it: {command} doctor', 'pt-BR': 'Início automático ligado. Verifique: {command} doctor' },
  autostartFailed: { en: 'Automatic start could not be configured.\n{reason}\nTry again after fixing the cause: {command} setup', 'pt-BR': 'Não foi possível configurar o início automático.\n{reason}\nTente de novo após corrigir a causa: {command} setup' },
  doctorRegistrationAbsent: { en: 'Not registered', 'pt-BR': 'Sem registro' },
  doctorFixRegistration: { en: 'register the plugin in {name}: {command} install --client {client}', 'pt-BR': 'registre o plugin no {name}: {command} install --client {client}' },
  doctorSessionNone: { en: 'No client session is open', 'pt-BR': 'Nenhuma sessão de cliente aberta' },
  doctorFixAutostart: { en: 'Automatic start is optional. Enable it: {command} setup', 'pt-BR': 'Início automático é opcional. Ative: {command} setup' },
  doctorAutostartOptional: { en: 'Optional', 'pt-BR': 'Opcional' },
  doctorDaemon: { en: 'Background service', 'pt-BR': 'Serviço em segundo plano' },
});
const normalizeClientLabel = (name) => name === 'Opencode' ? 'OpenCode' : name;
export const clientLabel = (name) => normalizeClientLabel(baseClientLabel(name));
export const commandTitle = (command, locale, action) => `${command} — ${locale === 'pt-BR'
  ? { setup: 'Configuração', doctor: 'Verificação da instalação' }[action]
  : { setup: 'Setup', doctor: 'Installation check' }[action]}`;
export const catalogFallback = (locale) => locale === 'pt-BR'
  ? 'Não foi possível ler a lista de modelos; estas opções vêm da lista incluída no plugin.'
  : 'The model list could not be read; these choices come from the built-in list.';
export function createPresenter(options = {}) {
  const ui = basePresenter(options);
  ui.text = (key, values = {}) => String(TEXTS[key]?.[ui.locale] ?? '').replace(/\{(\w+)\}/g, (_, key) => {
    const value = key === 'client' ? normalizeClientLabel(values[key]) : values[key];
    return String(value ?? '');
  });
  return ui;
}

/** Collect installer observations so the outcome can precede completed steps. */
export function createInstallerView({ operation, command, locale, write, verbose = false, hide = [] }) {
  const notes = [];
  const headers = [], steps = [], failures = [], offered = [];
  let globalLine = false, activeClient;
  const ui = createPresenter({ locale, write: (line) => notes.push({ line, client: globalLine ? undefined : activeClient }), verbose, hide });
  const pt = ui.locale === 'pt-BR';
  const emit = redactingWriter(write, hide);
  let current = false, menu = false, titled = false, pathHint, modelsConfirmed = false;
  const title = () => { if (titled) return; titled = true; emit(`${command} — ${pt
    ? { install: 'Instalação', update: 'Atualização', uninstall: 'Desinstalação' }[operation]
    : { install: 'Install', update: 'Update', uninstall: 'Uninstall' }[operation]}`); };
  const original = { ...ui };
  ui.humanOutput = true;
  ui.header = (values) => {
    activeClient = normalizeClientLabel(values.client);
    headers.push({ ...values, client: activeClient });
  };
  ui.endClients = () => { activeClient = undefined; };
  ui.row = (label, status, detail = '') => {
    label = normalizeClientLabel(label);
    if (label === ui.text('models') && status === 'ok') modelsConfirmed = true;
    if (label === ui.text('upToDate')) current = true;
    if (status === 'failed') failures.push({ step: label, reason: detail });
    globalLine = [ui.text('kit'), ui.text('models'), ui.text('policy')].includes(label);
    original.row(label, status, detail);
    globalLine = false;
  };
  ui.note = (value) => { globalLine = typeof value !== 'string'; original.note(value); globalLine = false; };
  ui.detail = (value) => { globalLine = typeof value !== 'string'; original.detail(value); globalLine = false; };
  ui.warn = original.warn;
  ui.summary = ({ hint }) => { pathHint = hint; original.note(ui.text('nextOpen')); };
  ui.failure = (failure) => { failures.push(failure); return []; };
  ui.sequence = (keys, values = {}) => {
    let n = 0;
    return (key) => ui.step(++n, keys.length, ui.text(key, values), key);
  };
  ui.step = (n, total, label, key) => {
    let ended = false;
    const end = (status, detail = '', extra = []) => {
      if (ended) return;
      ended = true;
      steps.push({ label, key, status, detail, client: headers.at(-1)?.client });
      if (status === 'failed') failures.push({ step: label, reason: detail });
      extra.forEach(ui.note);
    };
    return { label, ok: (d, e) => end('ok', d, e), skip: (d, e) => end('skipped', d, e),
      plan: (d, e) => end('plan', d, e), fail: (d, e) => end('failed', d, e), get ended() { return ended; } };
  };
  ui.explain = (lines) => {
    if (lines[0] === ui.text('clientChoose')) {
      title(); menu = true;
      emit(pt ? 'Escolha um cliente de programação antes de instalar.' : 'Choose a coding client before installing.');
      for (const line of lines.slice(1)) emit(line.trimStart().replace(/^(\d+\. )(\S+)(.*)$/, (_, number, client, state) => {
        offered.push(client);
        return `${number}${clientLabel(client)}${state}`;
      }));
    } else if (!lines.includes(ui.text('dryRunDone'))) { title(); lines.forEach(emit); }
  };
  return { ui, finish };
  function finish({ code, before = {}, after = {}, client, dryRun = false, purge = false, checkOnly = false }) {
    if (!menu && !headers.length && !failures.length) return;
    if (!menu) title();
    const ids = client && client !== 'all' ? [client] : headers.length
      ? headers.map((header) => Object.keys({ ...before, ...after }).find((id) => clientLabel(id) === header.client)).filter(Boolean)
      : Object.keys(before);
    const target = failures.find((failure) => failure.client)?.client ?? ids[0] ?? client ?? 'codex';
    const label = clientLabel(target);
    const install = `${command} install --client ${target}`;
    const check = `${command} doctor --client ${target}`;
    const invocation = { install, update: `${command} update --client ${target}`, uninstall: `${command} uninstall --client ${target}` }[operation];
    const once = new Set();
    const say = (line) => { if (!once.has(line)) { once.add(line); emit(line); } };
    if (menu && code !== 0) {
      for (const failure of failures.filter(({ reason }) => reason !== ui.text('clientNoTty'))) say(localizeReason(failure.reason, ui.locale));
      for (const id of offered) say(`${pt ? 'Instale para' : 'Install for'} ${clientLabel(id)}: ${command} install --client ${id}`);
      return;
    }
    const absent = failures.some(({ reason }) => reason === 'No installation record found' || reason.startsWith('Client not registered:'));
    if (absent && operation !== 'install') {
      say(pt ? `Nenhuma instalação do plugin encontrada. Nada foi ${operation === 'update' ? 'atualizado' : 'removido'}.`
        : `No plugin installation was found. Nothing was ${operation === 'update' ? 'updated' : 'removed'}.`);
      for (const failure of failures.filter(({ reason }) => reason.startsWith('Client not registered:'))) say(localizeReason(failure.reason, ui.locale));
      say(operation === 'update' ? `${pt ? 'Instale primeiro' : 'Install first'}: ${install}`
        : `${pt ? 'Confira o estado local' : 'Check the local state'}: ${command} doctor`);
      return;
    }
    if (code !== 0) {
      const failure = failures.find((failure) => failure.client) ?? failures[0];
      const download = failure?.step === ui.text('get');
      if (download && operation === 'install') say(headers.length > 1
        ? (pt ? 'Alguns clientes foram instalados. Outros precisam de atenção.' : 'Some clients were installed. Others need attention.')
        : (pt ? 'Não foi possível baixar a versão. Nada foi instalado.' : 'The release could not be downloaded. Nothing was installed.'));
      const framed = !download || operation !== 'install' || headers.length > 1;
      if (framed && failure?.step) say(ui.text('failedAt', { step: failure.step, reason: localizeReason(failure.reason, ui.locale) }));
      if (failure && (!framed || !failure.step)) say(localizeReason(failure.reason, ui.locale));
      say(download ? `${pt ? 'Confira sua conexão e tente' : 'Check your connection, then retry'}: ${invocation}`
        : `${pt ? 'Tente novamente' : 'Try again'}: ${invocation}`);
      if (operation === 'update' && (after[target]?.previous || before[target]?.previous)) say(`${pt ? 'Volte à versão guardada' : 'Return to the retained version'}: ${command} update --rollback`);
      flushNotes(say);
      return;
    }
    if (dryRun) {
      say(pt ? 'Somente prévia. Nada mudou.' : 'Preview only. Nothing changed.');
      renderSteps(say);
      say(`${pt ? 'Para aplicar' : 'Apply'}: ${invocation}`);
      flushNotes(say);
      return;
    }
    if (operation === 'update' && current) {
      say(pt ? `${label} está em dia. Nada mudou.` : `${label} is up to date. Nothing changed.`);
      renderSteps(say);
      say(`${pt ? 'Verifique a instalação' : 'Check the installation'}: ${check}`);
      flushNotes(say);
      return;
    }
    if (checkOnly) {
      say(`${pt ? 'Nova versão disponível' : 'New version available'}: ${headers.at(-1)?.version}`);
      say(`${pt ? 'Para atualizar' : 'Update'}: ${command} update --client ${target}`);
      flushNotes(say);
      return;
    }
    if (operation === 'uninstall') {
      const remaining = Object.keys(after);
      if (remaining.length) {
        say(pt ? `Integração do ${label} removida. O comando foi mantido para ${remaining.map(clientLabel).join(', ')}.`
          : `Removed ${label} integration. The command is kept for ${remaining.map(clientLabel).join(', ')}.`);
        say(`${pt ? 'Verifique a instalação restante' : 'Check the remaining installation'}: ${command} doctor --client ${remaining[0]}`);
      } else {
        say(pt ? `Plugin removido do ${label}.${purge ? '' : ' Seus ajustes foram mantidos.'}`
          : `Removed the plugin from ${label}.${purge ? '' : ' Your settings were kept.'}`);
        if (purge) say(pt ? 'Os ajustes também foram removidos.' : 'Settings were also removed.');
        say(`${pt ? 'Instale novamente quando precisar' : 'Install again when needed'}: ${install}`);
      }
      renderSteps(say);
      flushNotes(say);
      return;
    }
    for (const id of ids.length ? ids : [target]) {
      const name = clientLabel(id), record = after[id];
      say(operation === 'install'
        ? (pt ? `Instalado para ${name}.${modelsConfirmed ? '' : ' Falta confirmar os modelos.'}` : `Installed for ${name}.${modelsConfirmed ? '' : ' Model choices still need confirmation.'}`)
        : (pt ? `${name} atualizado de ${before[id]?.version} para ${record?.version}.` : `Updated ${name} from ${before[id]?.version} to ${record?.version}.`));
    }
    renderSteps(say);
    say(operation === 'install' ? `${pt ? 'Próximo' : 'Next'}: ${command} setup`
      : (pt ? `Próximo: reinicie ${label} e rode: ${check}` : `Next: restart ${label}, then run: ${check}`));
    if (operation === 'install') say(`${pt ? 'Verifique a instalação' : 'Check the installation'}: ${check}`);
    if (pathHint) {
      say(pt ? 'PATH é a lista de pastas onde o terminal procura comandos.' : 'PATH is the list of folders your terminal searches for commands.');
      say(pathHint);
    }
    if (operation === 'update' && ids.some((id) => after[id]?.previous)) say(`${pt ? 'Volte à versão guardada' : 'Return to the retained version'}: ${command} update --rollback`);
    flushNotes(say);
    if (verbose && notes.some(({ line }) => line.trimStart().startsWith(ui.text('kit')))) say(`${pt ? 'Confira novamente' : 'Check again'}: MCP kit_detect {}`);
  }
  function renderSteps(say) {
    const multiple = new Set(steps.map((step) => step.client)).size > 1;
    for (const [index, step] of steps.entries()) {
      const name = step.key === 'register' ? `${pt ? 'Conectar' : 'Connect'} ${step.client}` : step.label;
      const complete = step.status === 'ok' && step.detail !== ui.text('registerMarketplaceManual');
      const result = complete ? (pt ? 'concluído' : 'complete') : step.detail || (step.status === 'plan' ? ui.text('stepPlanned') : '');
      const detail = complete && step.detail && !['get', 'local', 'files', 'register'].includes(step.key) ? ` — ${step.detail}` : '';
      say(`${index + 1}. ${multiple ? `${step.client} — ` : ''}${name}${result || detail ? `: ${result}${detail}` : ''}`);
    }
  }
  function flushNotes(say) {
    const multiple = new Set(headers.map((header) => header.client)).size > 1;
    for (const { line, client } of notes) say(multiple && client ? `${client} — ${line.trimStart()}` : line);
  }
}

export function presentDiagnosis(result, { ui, command, client, verbose = false, out }) {
  const pt = ui.locale === 'pt-BR';
  out(`${command} — ${pt ? 'Verificação da instalação' : 'Installation check'}`);
  const { failed, warnings } = result;
  if (!failed && !warnings) out(pt
    ? `Pronto. ${result.rows.length === 1 ? 'A verificação passou' : `As ${result.rows.length} verificações passaram`}.`
    : `Ready. ${result.rows.length === 1 ? 'The check passed' : `All ${result.rows.length} checks passed`}.`);
  else {
    const failures = pt ? `${failed} ${failed === 1 ? 'verificação falhou' : 'verificações falharam'}` : `${failed} failed ${failed === 1 ? 'check' : 'checks'}`;
    const alerts = pt ? `${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}` : `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
    out(`${pt ? 'Precisa de atenção' : 'Needs attention'}: ${failed ? failures : alerts}${failed && warnings ? `; ${alerts}` : ''}; ${pt ? 'as demais passaram' : 'other checks passed'}.`);
  }
  const shown = result.rows.filter((row) => !row.quiet || verbose);
  // The rows of a client name it, so two clients are told apart. The labels share one width, so every mark of the run
  // is in the same column.
  const labels = shown.map((row) => row.id === 'registration'
    ? (pt ? `Conexão com ${clientLabel(row.client)}` : `${clientLabel(row.client)} connection`)
    : (row.client ? `${clientLabel(row.client)}: ${row.label}` : row.label));
  out(pt ? '| Verificação | Resultado |' : '| Check | Result |');
  out('| --- | --- |');
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  for (const [index, row] of shown.entries()) {
    out(`| ${cell(labels[index])} | ${cell(row.detail)} |`);
  }
  const check = `${command} doctor${client ? ` --client ${client}` : ''}`;
  const fixes = [...new Set(shown.filter((row) => ['failed', 'warn'].includes(row.status) && row.fix).map((row) => row.fix))];
  for (const fix of fixes) {
    out(`${pt ? 'Correção' : 'Fix'}: ${fix}`);
    // One verification command is enough when several checks need repair.
  }
  if (fixes.length) out(`${pt ? 'Depois confira' : 'Then check'}: ${check}`);
  if (shown.some((row) => row.id === 'session' && row.status === 'warn' && !row.fix)) out(pt
    ? `Nenhuma sessão de cliente aberta. Abra ${clientLabel(client ?? 'codex')} e rode: ${check}`
    : `No client session is open. Open ${clientLabel(client ?? 'codex')}, then run: ${check}`);
  if (labels.some((label) => /MCP/.test(label)) || shown.some((row) => /MCP/.test(`${row.detail} ${row.fix ?? ''}`))) out(pt
    ? 'MCP é a conexão usada pelo assistente para chamar ferramentas do plugin.'
    : 'MCP is the connection your assistant uses to call plugin tools.');
  if (!fixes.length) out(`${pt ? 'Verifique novamente quando precisar' : 'Check again when needed'}: ${check}`);
}
export async function askNumberedModel({ ask, locale, client, className, candidates, attempts, out }) {
  const pt = locale === 'pt-BR';
  out(`\n${workLabel(className, locale)} — ${clientLabel(client)}`);
  candidates.forEach((model, index) => out(`${index + 1}. ${model}${index === 0 ? (pt ? ' (recomendado)' : ' (recommended)') : ''}`));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const answer = await ask(pt ? 'Escolha um modelo [1]:' : 'Choose a model [1]:');
    if (answer == null) return { cancelled: true };
    const clean = String(answer).trim();
    const index = clean === '' ? 0 : /^[1-9]\d*$/.test(clean) ? Number(clean) - 1 : -1;
    if (candidates[index]) return { value: candidates[index] };
    const options = candidates.map((_, i) => i + 1).join(pt ? ' ou ' : ' or ');
    out(pt ? `Escolha ${options}.` : `Choose ${options}.`);
  }
  return { invalid: true };
}
export function workLabel(name, locale) {
  const labels = locale === 'pt-BR'
    ? { simple: 'Tarefas pequenas', normal: 'Tarefas do dia a dia', hard: 'Tarefas complexas' }
    : { simple: 'Small tasks', normal: 'Everyday tasks', hard: 'Complex tasks' };
  return labels[name] ?? name;
}

export function setupResultLines(result, locale, command) {
  const pt = locale === 'pt-BR';
  if (result.cancelled) return [pt ? 'Cancelado. Nada foi salvo.' : 'Cancelled. Nothing was saved.',
    pt ? `Tente novamente quando quiser: ${command} setup` : `Try again when ready: ${command} setup`];
  const clients = [...new Set([...result.changes, ...result.skipped].map((entry) => entry.client))];
  const check = `${command} doctor${clients.length === 1 ? ` --client ${clients[0]}` : ''}`;
  if (result.kept?.length) return [pt ? 'As escolhas mais novas foram mantidas. Confira: MCP config_get {}' : 'Newer choices were kept. Check them: MCP config_get {}'];
  if (result.changes.length) return [pt
    ? `${result.changes.length} escolhas de modelos salvas para ${clients.map(clientLabel).join(', ')}.`
    : `Saved ${result.changes.length} model choices for ${clients.map(clientLabel).join(', ')}.`,
  `${pt ? 'Próximo' : 'Next'}: ${check}`];
  if (result.skipped.length) return [pt ? 'Todas as escolhas de modelos já estão salvas. Nada mudou.' : 'All model choices are already saved. Nothing changed.',
    `${pt ? 'Verifique a instalação' : 'Check the installation'}: ${check}`,
    `${pt ? 'Altere os modelos' : 'Change models'}: ${command} setup --again`];
  return [pt ? 'Nenhum cliente com modelo ativo foi encontrado. Nada foi salvo.' : 'No client with an active model was found. Nothing was saved.',
    pt ? `Instale ou ative um modelo no seu cliente de programação e rode: ${command} setup` : `Install or enable a model in your coding client, then run: ${command} setup`,
    `${pt ? 'Confira os clientes disponíveis' : 'Check which clients are available'}: MCP env_report {"locale":"${locale}"}`];
}

export function presentModelChoices({ locale, changes, command, out }) {
  const pt = locale === 'pt-BR';
  out(pt ? '\nEscolhas de modelos' : '\nModel choices');
  out(pt ? '| Trabalho | Modelo |' : '| Work | Model |');
  out('| --- | --- |');
  for (const change of changes) out(`| ${workLabel(change.class, locale)} | ${change.model} |`);
  out(pt
    ? `\nAs escolhas valem para trabalhos futuros. Para alterá-las: ${command} setup --again`
    : `\nThese choices apply to future work. You can change them with: ${command} setup --again`);
  return pt ? 'Salvar estas escolhas? [s/N]:' : 'Save these choices? [y/N]:';
}
export const setupIntroduction = (locale, names) => locale === 'pt-BR'
  ? `Escolha modelos para ${names}; nada é salvo até sua confirmação.`
  : `Choose models for ${names}; nothing is saved until you confirm.`;
