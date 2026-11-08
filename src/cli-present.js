import { join } from 'node:path';
import { quotaTone } from './quota-tone.js';
// Human CLI views are kept separate from the presenter embedded in release scripts.
import { createPresenter as basePresenter, TEXTS as BASE_TEXTS, clientLabel as baseClientLabel,
  redactingWriter, localizeReason, powershellLiteral } from './install/present.js';
import { quotedWord, shown as shownCommand } from './install/mcp-register.js';
import { EPHEMERAL, isEphemeral, programWords } from './install/where.js';
import { flagsOf } from './install/flags.js';
import { readyLine } from './env/ready.js';
import { loginWord } from './env/account-rows.js';
import { commandToken, hasCommand, resolveTokens } from './install/command-token.js';
export * from './install/present.js';

export const presentAccount = (row, locale) => [row.client, row.id, row.label, row.configDir ?? 'default',
  loginWord(row.login, locale)].join('\t');
export const accountChanged = (action, locale) => action === 'remove'
  ? (locale === 'pt-BR' ? 'Conta removida da configuração. A pasta e o login permanecem.' : 'Account removed from configuration. The folder and login remain.') // locale:pt-BR
  : (locale === 'pt-BR' ? 'Conta renomeada. O id e o histórico permanecem.' : 'Account renamed. The id and history remain.'); // locale:pt-BR

export function accountInstructions(row, { locale, platform, command, root }) {
  const pt = locale === 'pt-BR';
  const variable = row.client === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const executable = row.client === 'claude-code' ? 'claude' : 'codex';
  const assignment = (key, value, shell) => shell === 'win32'
    ? `$env:${key}=${powershellLiteral(value)}; ` : `${key}=${quotedWord(value, 'linux')} `;
  const lines = [];
  if (row.login !== 'logged-in') lines.push(`${pt ? 'O login é manual. Execute' : 'Login is manual. Run'}: ${assignment(variable, row.configDir, platform)}${executable}`); // locale:pt-BR
  if (row.client === 'claude-code') {
    lines.push(pt ? 'Na pasta desta conta, registre em settings.json → statusLine (type: command) o comando:' // locale:pt-BR
      : 'In this account folder, register in settings.json → statusLine (type: command) the command:');
    // Claude runs statusLine commands in a POSIX shell, including Git Bash on Windows.
    lines.push(`${assignment(variable, row.configDir, 'linux')}${assignment('OKWORK_HOME', root, 'linux')}${shownCommand([command, 'statusline-collector'], 'linux')}`);
  }
  return lines;
}

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
  ? { setup: 'Configuração', doctor: 'Verificação da instalação' }[action] // locale:pt-BR
  : { setup: 'Setup', doctor: 'Installation check' }[action]}`;
export const catalogFallback = (locale) => locale === 'pt-BR'
  ? 'Lista de modelos indisponível; usando a lista incluída.' // locale:pt-BR
  : 'Model list unavailable; using the built-in list.';
export function createPresenter(options = {}) {
  const ui = basePresenter(options);
  ui.quotaPercent = (text) => quotaPercent(text, options);
  ui.text = (key, values = {}) => String(TEXTS[key]?.[ui.locale] ?? '').replace(/\{(\w+)\}/g, (_, key) => {
    const value = key === 'client' ? normalizeClientLabel(values[key]) : values[key];
    return String(value ?? '');
  });
  return ui;
}

/** Color the remaining percentage in a quota detail; keep its following limit plain. */
export function quotaPercent(text, { isTTY = process.stdout.isTTY, env = process.env } = {}) {
  if (!isTTY || Object.hasOwn(env, 'NO_COLOR')) return text;
  return text.replace(/(-?\d+(?:\.\d+)?)%/, (value, percent) => {
    const code = { ok: 32, warn: 33, low: 31, dim: 90 }[quotaTone(Number(percent))];
    return `\x1b[${code}m${value}\x1b[0m`;
  });
}

/** The program as a person types it on this platform: the words the repairs of the doctor start with. */
export async function programLine({ config, platform, env, fs, remaining }) {
  const words = await programWords({ config, platform, env, fs });
  // After a run (`remaining`: the folders of the installations that are left) the running CLI may not be there to be typed
  // again: it was inside the payload an uninstall just deleted, or it is the copy the release installer unpacks in a
  // temporary folder and removes when it ends. The CLI of an installation that is left takes its place; with none, and no
  // link, nothing is left (null) and the view points to the installer of the release.
  const exists = (path) => fs.access(path).then(() => true, () => false);
  if (remaining && words.length > 1 && (isEphemeral(words) || !await exists(words[1]))) {
    for (const folder of remaining) {
      const script = join(folder, 'src/cli.js');
      if (await exists(script)) return shownCommand([words[0], script], platform);
    }
    return null;
  }
  return shownCommand(words, platform);
}
/** Collect installer observations so the outcome can precede completed steps. */
export function createInstallerView({ operation, command, locale, write, verbose = false, hide = [], launch: start = {} }) {
  const notes = [];
  const headers = [], steps = [], failures = [], offered = [];
  let globalLine = false, activeClient, stepNote = false, rowNotes = false;
  const ui = createPresenter({ locale, write: (line) => {
    const shown = operation === 'install' && stepNote;
    notes.push({ line, client: globalLine ? undefined : activeClient, shown });
    if (shown) { title(true); emit(resolve(line)); }
  }, verbose, hide });
  const pt = ui.locale === 'pt-BR';
  const rawEmit = redactingWriter(write, hide);
  let gap = false, started = false;
  const flushGap = () => { if (gap && started) rawEmit(''); gap = false; };
  const emit = (value) => {
    if (operation !== 'install') {
      if (gap && value && !String(value).startsWith('\n')) flushGap();
      else gap = false;
      rawEmit(value); started = true; return;
    }
    for (const line of String(value).split('\n')) {
      if (!line.trim()) { gap = started; continue; }
      flushGap(); rawEmit(line); started = true;
    }
  };
  const block = () => { if (operation === 'install') gap = started; };
  ui.readAnswer = async (read, ...args) => {
    flushGap();
    try { return await read(...args); }
    finally { gap = started; }
  };
  const states = new Map();
  const stateOf = (label) => states.get(label) ?? states.set(label, {}).get(label);
  // The one place where a command of the output is written. `program` is the program as this terminal can start it now,
  // `linked` whether the installation holds the command link (a new terminal finds the command only then) and `dest`
  // the folder an install was told to use. Lines raised by other modules name the plain command: `resolve` rewrites them.
  const launch = { program: command, platform: process.platform, linked: false, dest: undefined, ...start };
  const launcher = (later) => (later && launch.linked ? shownCommand([command], launch.platform) : launch.program);
  const type = (words, { later = false, program } = {}) => {
    const list = operation === 'install' && launch.dest && words[0] === 'install' && !words.includes('--dest')
      ? [words[0], '--dest', launch.dest, ...words.slice(1)] : words;
    const rest = list.map((word) => quotedWord(word, launch.platform));
    // Nothing that runs is left (an uninstall took the command and the payload of this CLI away): the way back in is the
    // installer of the release, which takes the same flags.
    if (launch.program === null && !program) return [launch.platform === 'win32' ? './install.ps1' : 'sh install.sh', ...(list[0] === 'install' ? rest.slice(1) : rest)].join(' ');
    return `${program ?? launcher(later)} ${rest.join(' ')}`;
  };
  // Other modules write a command into their text as a token (`ui.command`); `resolve` swaps each token for what `type`
  // builds and touches nothing else, so a path or a message that happens to hold a command name stays as it is. A token
  // with no words is the program alone, for the texts that carry their own verb (`{command} setup`).
  const resolve = (line) => resolveTokens(line, (words, { later, program }) => (words.length ? type(words, { later, program }) : program ?? launcher(later)));
  let menu = false, titled = false, choices = false, organized = false, pathHint, modelsConfirmed = false, selectedClients, pendingModels;
  const title = (installation = false) => { if (titled) return; titled = true;
    if (installation && headers.length && operation !== 'uninstall' && (operation === 'install' || !headers.every((header) => stateOf(header.client).current))) {
      const action = operation === 'update' ? (pt ? 'atualização para' : 'update for') : (pt ? 'instalação para' : 'install for'); // locale:pt-BR
      emit(`${command} ${headers[0].version} — ${action} ${(selectedClients ?? [...new Set(headers.map((header) => header.client))]).join(', ')}`);
      return;
    }
    emit(`${command} — ${pt
    ? { install: 'Instalação', update: 'Atualização', uninstall: 'Desinstalação' }[operation] // locale:pt-BR
    : { install: 'Install', update: 'Update', uninstall: 'Uninstall' }[operation]}`); };
  const original = { ...ui };
  ui.humanOutput = true;
  ui.command = (words = [], { later = false, program } = {}) => commandToken(words, { later, program });
  // An install into a custom folder: the doctor reads no folder of its own, so no text offers one (see `finish`).
  ui.customFolder = operation === 'install' && Boolean(launch.dest);
  ui.beginClients = (clients) => { selectedClients = clients.map(clientLabel); };
  ui.header = (values) => {
    activeClient = normalizeClientLabel(values.client);
    headers.push({ ...values, client: activeClient });
  };
  ui.endClients = () => { activeClient = undefined; };
  // Live steps must already name the retained CLI once the release copy is installed.
  ui.installed = (record) => {
    if (EPHEMERAL.test(launch.program ?? '')) {
      launch.program = shownCommand([process.execPath, join(record.path, 'src/cli.js')], launch.platform);
    }
  };
  ui.modelsState = (clients) => { pendingModels = new Set(clients.map(clientLabel)); };
  ui.row = (label, status, detail = '') => {
    if (operation === 'install') block();
    label = normalizeClientLabel(label);
    if (label === ui.text('models') && status === 'ok') modelsConfirmed = true;
    if (label === ui.text('upToDate') && activeClient) stateOf(activeClient).current = true;
    if (label === ui.text('newVersion') && activeClient) stateOf(activeClient).newer = true;
    if (status === 'failed' && (activeClient || detail)) failures.push({ step: label, reason: detail, client: activeClient });
    globalLine = [ui.text('kit'), ui.text('models'), ui.text('policy')].includes(label);
    if (operation === 'install' && !(label === ui.text('selfcheckPath') && status === 'info')) {
      rowNotes = status === 'failed';
      title(true);
      const multiple = (selectedClients?.length ?? headers.length) > 1;
      const owner = multiple && activeClient && !globalLine ? `${activeClient} — ` : '';
      const mark = BASE_TEXTS.status[status]?.[ui.locale] ?? status;
      emit(`  ${(owner + label).padEnd(48)}  ${mark.padEnd(7)}  ${resolve(detail)}`.trimEnd());
      globalLine = false;
      return;
    }
    original.row(label, status, detail);
    notes.at(-1).row = { label, status, detail };
    globalLine = false;
  };
  ui.note = (value) => {
    globalLine = typeof value !== 'string';
    const previous = stepNote;
    stepNote ||= operation === 'install' && rowNotes;
    try { original.note(value); } finally { stepNote = previous; globalLine = false; }
  };
  ui.detail = (value) => { globalLine = typeof value !== 'string'; original.detail(value); globalLine = false; };
  ui.warn = original.warn;
  ui.summary = ({ hint }) => { pathHint = hint; };
  ui.confirm = async (read, options) => {
    if (!choices) {
      // The client menu precedes the installation heading when selection was interactive.
      if (menu) titled = false;
      title(true); choices = true;
      emit(`\n${pt ? 'Escolhas' : 'Choices'}`); // locale:pt-BR
    }
    emit('');
    for (const line of options.explain ?? []) emit(resolve(line));
    emit('');
    return ui.answer(await ui.readAnswer(read, ui.question(options.question, options.defaultYes)), options.defaultYes);
  };
  ui.failure = (failure) => { failures.push({ ...failure, client: failure.client ? clientLabel(failure.client) : undefined }); return []; };
  ui.sequence = (keys, values = {}) => {
    let n = 0;
    return (key) => ui.step(++n, keys.length, ui.text(key, values), key);
  };
  ui.step = (n, total, label, key) => {
    let ended = false;
    const end = (status, detail = '', extra = []) => {
      if (ended) return;
      ended = true;
      rowNotes = false;
      steps.push({ label, key, status, detail, client: headers.at(-1)?.client });
      if (operation === 'install') {
        title(true); block();
        const complete = status === 'ok' && detail !== ui.text('registerMarketplaceManual');
        const result = complete ? (pt ? 'concluído' : 'complete') : resolve(detail || (status === 'plan' ? ui.text('stepPlanned') : '')); // locale:pt-BR
        const extraDetail = complete && detail && !['get', 'local', 'files', 'register'].includes(key) ? ` — ${resolve(detail)}` : '';
        const name = key === 'register' ? `${pt ? 'Conectar' : 'Connect'} ${headers.at(-1)?.client}` : label; // locale:pt-BR
        const owner = (selectedClients?.length ?? headers.length) > 1 ? `${headers.at(-1)?.client} — ` : '';
        emit(`${steps.length}. ${owner}${name}${result || extraDetail ? `: ${result}${extraDetail}` : ''}`);
      }
      if (status === 'failed') failures.push({ step: label, reason: detail, client: activeClient });
      stepNote = true;
      try { extra.forEach(ui.note); } finally { stepNote = false; }
    };
    return { label, ok: (d, e) => end('ok', d, e), skip: (d, e) => end('skipped', d, e),
      plan: (d, e) => end('plan', d, e), fail: (d, e) => end('failed', d, e), get ended() { return ended; } };
  };
  ui.explain = (lines) => {
    rowNotes = false;
    if (lines[0] === ui.text('clientChoose')) {
      title(); menu = true;
      emit('');
      emit(pt ? 'Escolha um cliente de programação antes de instalar.' : 'Choose a coding client before installing.'); // locale:pt-BR
      for (const line of lines.slice(1)) emit(line.trimStart().replace(/^(\d+\. )(\S+)(.*)$/, (_, number, client, state) => {
        offered.push(client);
        return `${number}${clientLabel(client)}${state}`;
      }));
      emit('');
    } else if (!lines.includes(ui.text('dryRunDone'))) { title(true); lines.forEach((line) => emit(resolve(line))); }
  };
  return { ui, finish };
  /**
   * The outcome, told from the result of each client. `flags` and `program` are the arguments of the run and the way
   * to start the program: the commands that replay the operation are built from them.
   */
  function finish({ code, before = {}, after = {}, client, dryRun = false, purge = false, checkOnly = false, flags, program = launch.program, platform = launch.platform, destination, pathReady = true }) {
    if (!menu && !headers.length && !failures.length) return;
    if (!menu) title(!code && !dryRun && !checkOnly);
    const known = Object.keys({ ...before, ...after });
    const idOf = (label) => known.find((id) => clientLabel(id) === label) ?? label.toLowerCase().replaceAll(' ', '-');
    const seen = [...new Set([...headers.map((header) => header.client), ...failures.map((failure) => failure.client).filter(Boolean)])];
    // The arguments of the run, read the way the installer reads them (the last value of a repeated flag wins). `asked`
    // is the client the run was told to work on; with none, the clients in scope are the ones the run itself showed
    // (a header or a failure that names a client), or, for update and uninstall, the ones the installation holds.
    const options = flags ? flagsOf(operation, flags, { lenient: true }) : {};
    const asked = flags ? options.client : client;
    const ids = asked && asked !== 'all' ? [asked] : seen.length ? seen.map(idOf) : operation === 'install' ? [] : Object.keys(before);
    const sole = ids.length === 1, multiple = ids.length > 1;
    const names = (list) => list.map(clientLabel).join(', ');
    const stateOf = (id) => states.get(clientLabel(id));
    // A client was chosen when the run says so: it showed a header or a failure that names one. A menu that was shown
    // and answered is not a refused menu, whatever happened to the client chosen from it.
    const selected = headers.length > 0 || failures.some((failure) => failure.client);
    // With one client in scope, a failure that names none is that client's.
    const ownFailures = (id) => failures.filter((failure) => failure.client === clientLabel(id) || (!failure.client && sole));
    // Every command the output asks for is built by `type`: the program as this terminal can start it now (an operation to
    // replay), or with `later` the one a new terminal will find, when the installation that remains holds the command link
    // (`--no-link`, or an uninstall that removed the last link, leave none, and then the running program is the only one
    // that works). A custom folder of an install belongs to the commands that install again.
    Object.assign(launch, { program, platform, linked: pathReady && Object.values(after).some((record) => record?.link), dest: options.dest });
    const custom = operation === 'install' && Boolean(options.dest);
    const withClient = (id) => (id ? ['--client', id] : []);
    // A run of the release installer hands the CLI it unpacked the folder it unpacked into and the release it chose
    // (`--from`, `--repo`, `--asset`, `--fallback`): they are the installer's own business, never part of a retry.
    const unpacked = EPHEMERAL.test(`/${options.from ?? ''}/`);
    const internal = unpacked ? ['from', 'repo', 'asset', 'fallback'] : [];
    const replay = ({ omit = [], client: scope } = {}) => type([operation, ...withClient(scope),
      ...Object.entries(options).filter(([flag]) => !['client', 'locale', 'verbose', ...omit, ...internal].includes(flag))
        .flatMap(([flag, value]) => [`--${flag}`, ...(value === true ? [] : [value])])]);
    const doctor = (id) => type(['doctor', ...withClient(id)], { later: true });
    const check = doctor(sole ? ids[0] : undefined);
    // A rollback names its client when the installation holds several, so the others keep their version.
    const rollbackLine = (id) => `${pt ? 'Volte à versão guardada' : 'Return to the retained version'}${multiple ? ` (${clientLabel(id)})` : ''}: ${type(['update', '--rollback', ...(known.length > 1 ? withClient(id) : [])], { later: true })}`; // locale:pt-BR
    const scopes = asked ? [asked] : operation === 'install' ? ids : [undefined];
    const once = new Set();
    const say = (line) => { if (!once.has(line)) { once.add(line); emit(line); } };
    if (menu && !selected) {
      for (const failure of failures.filter(({ reason }) => reason !== ui.text('clientNoTty'))) say(resolve(localizeReason(failure.reason, ui.locale)));
      for (const id of offered) say(`${pt ? 'Instale para' : 'Install for'} ${clientLabel(id)}: ${replay({ client: id })}`); // locale:pt-BR
      return;
    }
    const absent = failures.some(({ reason }) => reason === 'No installation record found' || reason.startsWith('Client not registered:'));
    if (absent && operation !== 'install') {
      say(pt ? `Nenhuma instalação do plugin encontrada. Nada foi ${operation === 'update' ? 'atualizado' : 'removido'}.` // locale:pt-BR
        : `No plugin installation was found. Nothing was ${operation === 'update' ? 'updated' : 'removed'}.`);
      for (const failure of failures.filter(({ reason }) => reason.startsWith('Client not registered:'))) say(resolve(localizeReason(failure.reason, ui.locale)));
      // Without a client the run was told about, the first install is the one the program asks about; none is guessed.
      say(operation === 'update' ? `${pt ? 'Instale primeiro' : 'Install first'}: ${type(['install', ...withClient(asked)])}` // locale:pt-BR
        : `${pt ? 'Confira o estado local' : 'Check the local state'}: ${type(['doctor'])}`);
      return;
    }
    if (code !== 0) {
      const download = ui.text('get');
      const unplaced = (id) => ownFailures(id).some(({ step }) => [download, ui.text('backup'), ui.text('files')].includes(step));
      const failed = ids.filter((id) => ownFailures(id).length);
      const alone = sole && operation === 'install' && ownFailures(ids[0]).some(({ step }) => step === download);
      if (operation === 'install' && multiple && failed.some(unplaced)) {
        say(ids.every(unplaced) ? (pt ? 'Nenhum cliente foi instalado.' : 'No client was installed.') // locale:pt-BR
          : (pt ? 'Alguns clientes foram instalados. Outros precisam de atenção.' : 'Some clients were installed. Others need attention.')); // locale:pt-BR
      } else if (alone) say(pt ? 'Não foi possível baixar a versão. Nada foi instalado.' : 'The release could not be downloaded. Nothing was installed.'); // locale:pt-BR
      const causes = new Map();
      // The first failure of each client is its cause; the rows that follow it are told by the notes.
      for (const failure of [...failed.map((id) => ownFailures(id)[0]), ...failures.filter((failure) => !failure.client && !sole)]) {
        const key = `${failure.step}\n${failure.reason}`;
        if (!causes.has(key)) causes.set(key, { failure, owners: [] });
        if (failure.client) causes.get(key).owners.push(failure.client);
      }
      // A cause names its clients only when more than one client failed; the line starts with the cause itself.
      const told = new Set([...causes.values()].flatMap(({ owners }) => owners)).size > 1;
      for (const { failure, owners } of causes.values()) {
        const reason = resolve(localizeReason(failure.reason, ui.locale));
        const body = failure.step && !(alone && failure.step === download) ? ui.text('failedAt', { step: failure.step, reason }) : reason;
        say(`${body}${told && owners.length ? ` (${[...new Set(owners)].join(', ')})` : ''}`);
      }
      // What the run already did stays told: a backup folder or a retained version is how a failed update is recovered.
      renderSteps(say, { completed: true });
      // A purge needs every remaining client in one command, so its retry is that one command, never one per client.
      const purging = operation === 'uninstall' && Boolean(options.purge || purge);
      for (const scope of purging ? [asked] : failed.length ? failed : scopes) {
        const stuck = scope && ownFailures(scope).some(({ step }) => step === download);
        const verb = stuck ? (pt ? 'Confira sua conexão e tente' : 'Check your connection, then retry') : (pt ? 'Tente novamente' : 'Try again'); // locale:pt-BR
        say(`${verb}${multiple && scope ? ` (${clientLabel(scope)})` : ''}: ${replay({ client: scope })}`);
      }
      if (operation === 'update') {
        for (const id of failed.length ? failed : ids) {
          if (after[id]?.previous || before[id]?.previous) say(rollbackLine(id));
        }
      }
      flushNotes(say);
      return;
    }
    if (dryRun) {
      block();
      say(pt ? 'Somente prévia. Nada mudou.' : 'Preview only. Nothing changed.'); // locale:pt-BR
      renderSteps(say);
      for (const scope of scopes) say(`${pt ? 'Para aplicar' : 'Apply'}${scopes.length > 1 ? ` (${clientLabel(scope)})` : ''}: ${replay({ omit: ['dry-run'], client: scope })}`);
      flushNotes(say);
      return;
    }
    if (operation === 'update' && ids.length && ids.every((id) => stateOf(id)?.current)) {
      say(pt ? `${names(ids)} ${multiple ? 'estão' : 'está'} em dia. Nada mudou.` : `${names(ids)} ${multiple ? 'are' : 'is'} up to date. Nothing changed.`); // locale:pt-BR
      renderSteps(say);
      say(`${pt ? 'Verifique a instalação' : 'Check the installation'}: ${check}`); // locale:pt-BR
      flushNotes(say);
      return;
    }
    if (checkOnly) {
      for (const id of ids.filter((id) => stateOf(id)?.newer)) {
        say(`${pt ? 'Nova versão disponível' : 'New version available'}${multiple ? ` (${clientLabel(id)})` : ''}: ${headers.find((header) => header.client === clientLabel(id))?.version}`); // locale:pt-BR
      }
      for (const scope of scopes) say(`${pt ? 'Para atualizar' : 'Update'}: ${replay({ omit: ['check'], client: scope })}`);
      flushNotes(say);
      return;
    }
    if (operation === 'uninstall') {
      const remaining = Object.keys(after);
      if (remaining.length) {
        say(pt ? `Integração do ${names(ids)} removida. O comando foi mantido para ${names(remaining)}.` // locale:pt-BR
          : `Removed ${names(ids)} integration. The command is kept for ${names(remaining)}.`);
        // Nothing that runs is left (the command and the CLI of the kept installations are gone): the doctor cannot be
        // started, and the installer of the release puts the command back.
        if (launch.program === null) {
          for (const id of remaining) say(`${pt ? 'Instale novamente para restaurar o comando' : 'Install again to restore the command'}${remaining.length > 1 ? ` (${clientLabel(id)})` : ''}: ${type(['install', ...withClient(id)])}`); // locale:pt-BR
        } else say(`${pt ? 'Verifique a instalação restante' : 'Check the remaining installation'}: ${doctor(remaining.length === 1 ? remaining[0] : undefined)}`); // locale:pt-BR
      } else {
        say(pt ? `Plugin removido do ${names(ids)}.${purge ? '' : ' Seus ajustes foram mantidos.'}`
          : `Removed the plugin from ${names(ids)}.${purge ? '' : ' Your settings were kept.'}`);
        if (purge) say(pt ? 'Os ajustes também foram removidos.' : 'Settings were also removed.'); // locale:pt-BR
        for (const id of ids) say(`${pt ? 'Instale novamente quando precisar' : 'Install again when needed'}${multiple ? ` (${clientLabel(id)})` : ''}: ${type(['install', ...withClient(id)], { later: true })}`); // locale:pt-BR
      }
      renderSteps(say);
      flushNotes(say);
      return;
    }
    organized = true;
    block();
    for (const id of ids) {
      const name = clientLabel(id), record = after[id];
      const needsModels = pendingModels ? pendingModels.has(name) : !modelsConfirmed;
      say(operation === 'install'
        ? (pt ? `Instalado para ${name}.${needsModels ? ' Falta confirmar os modelos.' : ''}` : `Installed for ${name}.${needsModels ? ' Model choices still need confirmation.' : ''}`) // locale:pt-BR
        : stateOf(id)?.current ? (pt ? `${name} está em dia.` : `${name} is up to date.`) // locale:pt-BR
          : (pt ? `${name} atualizado de ${before[id]?.version} para ${record?.version}.` : `Updated ${name} from ${before[id]?.version} to ${record?.version}.`));
    }
    renderSteps(say);
    const changed = ids.filter((id) => !stateOf(id)?.current);
    // The doctor reads the folder of the settings and takes no folder of its own: for an install into a custom folder
    // the output says where the installation is instead of a check that would look somewhere else.
    if (operation === 'install') {
      notes.push({ line: custom ? `${pt ? 'Pasta da instalação' : 'Installation folder'}: ${destination ?? options.dest} ${pt ? '(o doctor só lê a pasta dos ajustes)' : '(the doctor reads only the folder of the settings)'}` // locale:pt-BR
        : `${pt ? 'Verifique a instalação' : 'Check the installation'}: ${check}` }); // locale:pt-BR
    }
    if (operation === 'update') for (const id of changed.filter((id) => after[id]?.previous)) notes.push({ line: rollbackLine(id) });
    flushNotes(say);
    if (verbose && notes.some(({ line }) => line.trimStart().startsWith(ui.text('kit')))) say(`${pt ? 'Confira novamente' : 'Check again'}: MCP kit_detect {}`);
    say(`\n${pt ? 'Próximo' : 'Next'}`); // locale:pt-BR
    if (pathHint) {
      say(pt ? 'Execute agora:' : 'Run this now:'); // locale:pt-BR
      say(pathHint);
      say(pt ? 'ou abra um terminal novo' : 'or open a new terminal'); // locale:pt-BR
    } else say(pt ? 'Abra um terminal novo.' : 'Open a new terminal.'); // locale:pt-BR
  }
  function renderSteps(say, { completed = false } = {}) {
    if (operation === 'install') return;
    const multiple = new Set(steps.map((step) => step.client)).size > 1;
    for (const [index, step] of steps.entries()) {
      // After a failure only the steps that were done are told, and a step that was skipped with a remedy (the quota
      // recording that is off and how to turn it on): the one that failed is the cause the output already gives.
      if (completed && step.status !== 'ok' && !(step.status === 'skipped' && hasCommand(step.detail))) continue;
      const name = step.key === 'register' ? `${pt ? 'Conectar' : 'Connect'} ${step.client}` : step.label;
      const complete = step.status === 'ok' && step.detail !== ui.text('registerMarketplaceManual');
      const result = complete ? (pt ? 'concluído' : 'complete') : resolve(step.detail || (step.status === 'plan' ? ui.text('stepPlanned') : '')); // locale:pt-BR
      const detail = complete && step.detail && !['get', 'local', 'files', 'register'].includes(step.key) ? ` — ${resolve(step.detail)}` : '';
      say(`${index + 1}. ${multiple ? `${step.client} — ` : ''}${name}${result || detail ? `: ${result}${detail}` : ''}`);
    }
  }
  function flushNotes(say) {
    const multiple = new Set(headers.map((header) => header.client)).size > 1;
    if (!organized) {
      for (const { line, client, shown } of notes) if (!shown) say(resolve(multiple && client ? `${client} — ${line.trimStart()}` : line));
      return;
    }
    const rows = notes.filter((note) => !note.shown && note.row && !(note.row.label === ui.text('selfcheckPath') && note.row.status === 'info'));
    const labelOf = ({ row, client }) => multiple && client ? `${client} — ${row.label}` : row.label;
    const width = Math.max(0, ...rows.map((note) => labelOf(note).length));
    for (const note of rows) {
      const { status, detail } = note.row;
      const mark = BASE_TEXTS.status[status]?.[ui.locale] ?? status;
      say(`  ${labelOf(note).padEnd(width)}  ${mark.padEnd(7)}  ${resolve(detail)}`.trimEnd());
    }
    const explanations = notes.filter((note) => !note.shown && !note.row);
    if (explanations.length) say(`\n${pt ? 'Notas' : 'Notes'}`); // locale:pt-BR
    for (const { line, client } of explanations) {
      const content = resolve(multiple && client ? `${client} — ${line.trimStart()}` : line);
      for (const item of content.split('\n')) say(`  ${item.trimStart()}`);
    }
  }
}

export function presentDiagnosis(result, { ui, command, client, clients, verbose = false, out, program = command, platform = process.platform }) {
  const pt = ui.locale === 'pt-BR';
  out(`${command} — ${pt ? 'Verificação da instalação' : 'Installation check'}`); // locale:pt-BR
  const { failed, warnings } = result;
  if (!failed && !warnings) out(pt
    ? `Pronto. ${result.rows.length === 1 ? 'A verificação passou' : `As ${result.rows.length} verificações passaram`}.` // locale:pt-BR
    : `Ready. ${result.rows.length === 1 ? 'The check passed' : `All ${result.rows.length} checks passed`}.`);
  else {
    const failures = pt ? `${failed} ${failed === 1 ? 'verificação falhou' : 'verificações falharam'}` : `${failed} failed ${failed === 1 ? 'check' : 'checks'}`; // locale:pt-BR
    const alerts = pt ? `${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}` : `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
    out(`${pt ? 'Precisa de atenção' : 'Needs attention'}: ${failed ? failures : alerts}${failed && warnings ? `; ${alerts}` : ''}; ${pt ? 'as demais passaram' : 'other checks passed'}.`); // locale:pt-BR
  }
  const shown = result.rows.filter((row) => !row.quiet || verbose);
  // The rows of a client name it, so two clients are told apart. The labels share one width, so every mark of the run
  // is in the same column.
  const labels = shown.map((row) => row.id === 'registration'
    ? (pt ? `Conexão com ${clientLabel(row.client)}` : `${clientLabel(row.client)} connection`) // locale:pt-BR
    : (row.client ? `${clientLabel(row.client)}: ${row.accountLabel ? `${row.accountLabel}: ` : ''}${row.label}` : row.label));
  out(pt ? '| Verificação | Resultado |' : '| Check | Result |'); // locale:pt-BR
  out('| --- | --- |');
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  for (const [index, row] of shown.entries()) {
    const detail = row.id === 'quota' || row.id === 'account-policy'
      ? ui.quotaPercent?.(row.detail) ?? row.detail : row.detail;
    out(`| ${cell(labels[index])} | ${cell(detail)} |`);
  }
  const check = `${program} doctor${client ? ` --client ${quotedWord(client, platform)}` : ''}`;
  const fixes = [...new Set(shown.filter((row) => ['failed', 'warn'].includes(row.status) && row.fix).map((row) => row.fix))];
  for (const fix of fixes) {
    out(`${pt ? 'Correção' : 'Fix'}: ${fix}`); // locale:pt-BR
    // One verification command is enough when several checks need repair.
  }
  if (fixes.length) out(`${pt ? 'Depois confira' : 'Then check'}: ${check}`); // locale:pt-BR
  if (shown.some((row) => row.id === 'session' && row.status === 'warn' && !row.fix)) {
    const open = (client ? [client] : clients?.length ? clients : [...new Set(result.rows.map((row) => row.client).filter(Boolean))])
      .map(clientLabel).join(', ');
    // With no client in evidence, none is named.
    out(pt ? `Nenhuma sessão de cliente aberta. Abra ${open || 'seu cliente'} e rode: ${check}` : `No client session is open. Open ${open || 'your client'}, then run: ${check}`); // locale:pt-BR
  }
  if (labels.some((label) => /MCP/.test(label)) || shown.some((row) => /MCP/.test(`${row.detail} ${row.fix ?? ''}`))) out(pt
    ? 'MCP é a conexão usada pelo assistente para chamar ferramentas do plugin.' // locale:pt-BR
    : 'MCP is the connection your assistant uses to call plugin tools.');
  if (!fixes.length) out(`${pt ? 'Verifique novamente quando precisar' : 'Check again when needed'}: ${check}`);
  if (result.gaps) out(readyLine(result, ui.locale));
}
export function presentModelOptions({ client, candidates, defaults, locale, out }) {
  out(`\n${clientLabel(client)}`);
  candidates.forEach((model, index) => {
    const classes = Object.entries(defaults).filter(([, value]) => value === model)
      .map(([name]) => workLabel(name, locale));
    out(`${index + 1}. ${model}${classes.length ? ` (${classes.join(', ')} — ${locale === 'pt-BR' ? 'padrão' : 'default'})` : ''}`); // locale:pt-BR
  });
}

export async function askNumberedModel({ ask, locale, client, className, candidates, attempts, out, recommended = candidates[0], showOptions = true }) {
  const pt = locale === 'pt-BR';
  if (showOptions) {
    out(`\n${workLabel(className, locale)} — ${clientLabel(client)}`);
    candidates.forEach((model, index) => out(`${index + 1}. ${model}${index === 0 ? (pt ? ' (recomendado)' : ' (recommended)') : ''}`)); // locale:pt-BR
  }
  const defaultIndex = Math.max(0, candidates.indexOf(recommended));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    out('');
    const answer = await ask(showOptions ? (pt ? 'Escolha um modelo [1]:' : 'Choose a model [1]:') // locale:pt-BR
      : `${workLabel(className, locale)} [${defaultIndex + 1}]:`);
    if (answer == null) return { cancelled: true };
    const clean = String(answer).trim();
    const index = clean === '' ? defaultIndex : /^[1-9]\d*$/.test(clean) ? Number(clean) - 1 : -1;
    if (candidates[index]) return { value: candidates[index] };
    const options = candidates.map((_, i) => i + 1).join(pt ? ' ou ' : ' or ');
    out(pt ? `Escolha ${options}.` : `Choose ${options}.`); // locale:pt-BR
  }
  return { invalid: true };
}
export function workLabel(name, locale) {
  const labels = locale === 'pt-BR'
    ? { simple: 'Tarefas pequenas', normal: 'Tarefas do dia a dia', hard: 'Tarefas complexas' } // locale:pt-BR
    : { simple: 'Small tasks', normal: 'Everyday tasks', hard: 'Complex tasks' };
  return labels[name] ?? name;
}

/**
 * `command` is the program the follow-ups start with. `doctor: false` leaves out every doctor line: an installation into a
 * custom folder is somewhere the doctor does not look (it reads the folder of the settings and takes no folder of its own).
 */
export function setupResultLines(result, locale, command, { doctor = true } = {}) {
  const pt = locale === 'pt-BR';
  if (result.cancelled) return [pt ? 'Cancelado. Nada foi salvo.' : 'Cancelled. Nothing was saved.', // locale:pt-BR
    pt ? `Tente novamente quando quiser: ${command} setup` : `Try again when ready: ${command} setup`];
  const clients = [...new Set([...result.changes, ...result.skipped].map((entry) => entry.client))];
  const check = `${command} doctor${clients.length === 1 ? ` --client ${clients[0]}` : ''}`;
  const advice = result.guidance ?? [];
  const kept = result.kept ?? [], omitted = result.omitted ?? [];
  if (result.changes.length || result.skipped.length || kept.length || omitted.length) {
    // Each group of the result is told by what it holds. With a single group the sentence is the short one; with
    // several, every group names its clients and classes, so one group never stands for another.
    const several = [result.changes, result.skipped, kept, omitted].filter((group) => group.length).length > 1;
    const who = (entries) => entries.filter((entry) => entry?.client)
      .map((entry) => (entry.class ? `${clientLabel(entry.client)} (${workLabel(entry.class, locale)})` : clientLabel(entry.client))).join(', ');
    const lines = [];
    if (result.changes.length) {
      const saved = several ? who(result.changes) : '';
      lines.push(saved
        ? (pt ? `${result.changes.length} escolhas de modelos salvas: ${saved}.` : `Saved ${result.changes.length} model choices: ${saved}.`) // locale:pt-BR
        : (pt ? `${result.changes.length} escolhas de modelos salvas para ${clients.map(clientLabel).join(', ')}.` // locale:pt-BR
          : `Saved ${result.changes.length} model choices for ${clients.map(clientLabel).join(', ')}.`));
    }
    if (result.skipped.length) {
      const already = several ? who(result.skipped) : '';
      lines.push(already ? (pt ? `Já salvas, sem mudança: ${already}.` : `Already saved, unchanged: ${already}.`) // locale:pt-BR
        : (pt ? 'Todas as escolhas de modelos já estão salvas. Nada mudou.' : 'All model choices are already saved. Nothing changed.')); // locale:pt-BR
    }
    if (kept.length) {
      const newer = who(kept);
      lines.push(pt ? `As escolhas mais novas foram mantidas${newer ? ` para ${newer}: elas mudaram enquanto você escolhia` : ''}. Confira: MCP config_get {}` // locale:pt-BR
        : `Newer choices were kept${newer ? ` for ${newer}: they changed while you were choosing` : ''}. Check them: MCP config_get {}`);
    }
    if (omitted.length) {
      const unmatched = several ? who(omitted) : '';
      lines.push(pt ? `Nenhuma escolha de modelo foi salva${unmatched ? ` para ${unmatched}` : ''}: os modelos ativos não correspondem às escolhas recomendadas.` // locale:pt-BR
        : `No model choices were saved${unmatched ? ` for ${unmatched}` : ''}: the active models did not match the recommended choices.`);
    }
    lines.push(...advice);
    if (result.changes.length) { if (doctor) lines.push(`${pt ? 'Próximo' : 'Next'}: ${check}`); } // locale:pt-BR
    else if (result.skipped.length) {
      if (doctor) lines.push(`${pt ? 'Verifique a instalação' : 'Check the installation'}: ${check}`); // locale:pt-BR
      lines.push(`${pt ? 'Altere os modelos' : 'Change models'}: ${command} setup --again`); // locale:pt-BR
    }
    return lines;
  }
  return [pt ? 'Nenhum cliente com modelo ativo foi encontrado. Nada foi salvo.' : 'No client with an active model was found. Nothing was saved.', // locale:pt-BR
    pt ? `Instale ou ative um modelo no seu cliente de programação e rode: ${command} setup` : `Install or enable a model in your coding client, then run: ${command} setup`, // locale:pt-BR
    `${pt ? 'Confira os clientes disponíveis' : 'Check which clients are available'}: MCP env_report {"locale":"${locale}"}`]; // locale:pt-BR
}

export function presentModelChoices({ locale, changes, command, out, defaultYes = false }) {
  const pt = locale === 'pt-BR';
  out(pt ? '\nEscolhas de modelos' : '\nModel choices'); // locale:pt-BR
  const several = new Set(changes.map((change) => change.client)).size > 1;
  out(`| ${several ? `${pt ? 'Cliente' : 'Client'} | ` : ''}${pt ? 'Trabalho | Modelo' : 'Work | Model'} |`); // locale:pt-BR
  out(`| ${several ? '--- | ' : ''}--- | --- |`);
  for (const change of changes) out(`| ${several ? `${clientLabel(change.client)} | ` : ''}${workLabel(change.class, locale)} | ${change.model}${change.singleOption ? (pt ? ' (única opção)' : ' (only option)') : ''} |`); // locale:pt-BR
  out(pt
    ? `\nAs escolhas valem para trabalhos futuros. Para alterá-las: ${command} setup --again` // locale:pt-BR
    : `\nThese choices apply to future work. You can change them with: ${command} setup --again`);
  out('');
  return pt ? `Salvar estas escolhas? [${defaultYes ? 'S/n' : 's/N'}]:` : `Save these choices? [${defaultYes ? 'Y/n' : 'y/N'}]:`; // locale:pt-BR
}
export const setupIntroduction = (locale, names) => locale === 'pt-BR'
  ? `Escolha modelos para ${names}; nada é salvo até sua confirmação.` // locale:pt-BR
  : `Choose models for ${names}; nothing is saved until you confirm.`;
