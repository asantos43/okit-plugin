import { readiness } from '../env/ready.js';
import { accountRows, loginWord, shownWarnings, warningText } from '../env/account-rows.js';
import { accountReasonText } from '../accounts-choose.js';

// The rows of the doctor that answer "can the executors be launched?": the models and the quota of each client that is
// installed, the status bar collector and the kit. They are told from the environment snapshot, which the doctor takes
// read-only, and from the same `readiness` the other reports close with. A client that is not installed is optional and
// has no row; the kit is optional too and is never more than a skipped row.

const WORDS = {
  en: {
    models: 'Models', quota: 'Quota', collector: 'Status bar collector', kit: 'Kit', clients: 'Clients',
    modelsOk: (list) => `confirmed: ${list}`, modelsNone: 'no model confirmed',
    quotaOk: 'recorded', quotaOff: 'not recorded', quotaExpired: 'expired',
    collectorOn: 'active', collectorNoReading: 'active; no reading received yet', collectorOff: 'inactive', collectorUnknown: 'cannot be told',
    kitOk: (path, version) => `${path} (${version})`, kitAbsent: 'not found (optional)', kitBroken: 'found but broken (optional)',
    noClients: 'no client is installed',
    fixModels: (program) => `Choose the models: ${program} setup`,
    fixQuota: 'Enable the status bar collector below, or ask your assistant to call `quota_set` with the percentage that is left',
    fixCollector: (command) => `Enable it: ${command}`,
    fixClients: (program) => `Install a client, then run: ${program} install`,
  },
  'pt-BR': {
    models: 'Modelos', quota: 'Cota', collector: 'Coletor da barra de status', kit: 'Kit', clients: 'Clientes',
    modelsOk: (list) => `confirmados: ${list}`, modelsNone: 'nenhum modelo confirmado',
    quotaOk: 'registrada', quotaOff: 'não registrada', quotaExpired: 'expirada',
    collectorOn: 'ativo', collectorNoReading: 'ativo; nenhuma leitura recebida ainda', collectorOff: 'inativo', collectorUnknown: 'não foi possível saber',
    kitOk: (path, version) => `${path} (${version})`, kitAbsent: 'não encontrado (opcional)', kitBroken: 'encontrado, mas com defeito (opcional)',
    noClients: 'nenhum cliente está instalado',
    fixModels: (program) => `Escolha os modelos: ${program} setup`,
    fixQuota: 'Ative o coletor da barra de status abaixo, ou peça ao seu assistente para chamar `quota_set` com a porcentagem que resta',
    fixCollector: (command) => `Ative: ${command}`,
    fixClients: (program) => `Instale um cliente e depois rode: ${program} install`,
  },
};

/**
 * The rows of the readiness and the answer they come to.
 *
 * @param {object} input the snapshot (null when it could not be taken), the kit probe (or null), the presenter and the command
 * @returns {{rows: object[], ready: boolean, gaps: object[]}}
 */
export function readinessRows({ snapshot, kit, ui, program }) {
  const words = WORDS[ui.locale] ?? WORDS.en;
  const answer = readiness(snapshot);
  const rows = [];
  const installed = accountRows(snapshot?.clients).filter((row) => row.installed === true);
  if (snapshot && !installed.length) {
    rows.push({ id: 'clients', status: 'warn', label: words.clients, detail: words.noClients, fix: words.fixClients(program) });
  }
  for (const row of installed) {
    const account = row.account ? { account: row.account, accountLabel: row.accountLabel } : {};
    if (row.account) {
      rows.push({ id: 'login', client: row.client, ...account, label: 'Login',
        status: row.login === 'logged-out' ? 'warn' : row.login === 'unknown' ? 'skipped' : 'ok',
        detail: loginWord(row.login, ui.locale) });
    }
    for (const warning of shownWarnings(row)) rows.push({ id: warning.code, client: row.client, ...account,
      label: ui.locale === 'pt-BR' ? 'Aviso' : 'Warning', status: 'warn', detail: warningText(warning, ui.locale) });
    const models = row.models ?? [];
    rows.push({ id: 'models', client: row.client, ...account, label: words.models,
      ...models.length ? { status: 'ok', detail: words.modelsOk(models.join(', ')) }
        : { status: 'warn', detail: words.modelsNone, fix: words.fixModels(program) } });
    const expired = row.candidates.some((actor) => actor.restrictions.includes('expired-quota'));
    const state = row.quota.status === 'off' ? 'quotaOff' : expired ? 'quotaExpired' : 'quotaOk';
    rows.push({ id: 'quota', client: row.client, ...account, label: words.quota, status: state === 'quotaOk' ? 'ok' : 'warn',
      detail: words[state], ...state === 'quotaOk' ? {} : { fix: words.fixQuota + (row.account && row.account !== 'default'
        ? (ui.locale === 'pt-BR' ? ` com o cliente ${row.client} e a conta ${row.account}`
          : ` with the client ${row.client} and the account ${row.account}`) : '') } });
  }
  const line = snapshot?.plugin?.statusline;
  for (const choice of snapshot?.accountChoices ?? []) rows.push({
    id: 'account-policy', client: choice.client, account: choice.account,
    label: ui.locale === 'pt-BR' ? 'Escolha de conta' : 'Account choice',
    status: choice.account ? 'ok' : 'warn',
    detail: `${choice.actorClass}: ${choice.account ?? '—'}. ${accountReasonText(choice.reason, ui.locale)}`,
  });
  if (line) {
    const detail = line.active === null ? words.collectorUnknown : line.active
      ? (line.received === false ? words.collectorNoReading : words.collectorOn) : words.collectorOff;
    rows.push({ id: 'statusline', label: words.collector, detail,
      status: line.active === null ? 'skipped' : line.active ? 'ok' : 'warn',
      ...line.active === false ? { fix: words.fixCollector(line.command) } : {} });
  }
  if (kit) {
    rows.push({ id: 'kit', label: words.kit, status: kit.state === 'installed' ? 'ok' : 'skipped',
      detail: kit.state === 'installed' ? words.kitOk(kit.path, kit.version)
        : kit.state === 'broken' ? words.kitBroken : words.kitAbsent });
  }
  return { rows, ...answer };
}
