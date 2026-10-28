import { createHash } from 'node:crypto';
import { environmentSnapshot } from '../../env/snapshot.js';
import { adapterQuotaReader } from '../../status.js';
import { limitsStatus } from '../../limits.js';
import { configOf, DEFAULT_CONFIG, profilePick } from '../../profiles.js';
import { smokePreflight } from '../client.js';
import { loadScenario, validateScenario } from './scenario.js';
import { resolveLimits } from './budget.js';
import { classify } from '../../classify.js';
import { runDemo } from './index.js';

const canonical = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object'
  && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

export async function smokeDemo(args = {}, deps = {}) {
  const locale = args.locale ?? 'en', pt = locale === 'pt-BR';
  const config = configOf(deps.snapshot?.config ?? deps.config);
  const snapshot = await environmentSnapshot({ ...deps, config, client: args.client, view: 'selected',
    readQuota: deps.readQuota ?? adapterQuotaReader({ stateRoot: deps.root, env: deps.env }),
    limits: deps.limits ?? (deps.snapshot ? undefined : await limitsStatus(deps.root, config)) });
  const client = args.client ?? snapshot.inUse;
  const scenario = validateScenario(deps.scenario ?? await loadScenario());
  const limits = resolveLimits(config.smoke, scenario.demands.length);
  const preflight = smokePreflight(snapshot, client, limits);
  const row = snapshot.clients.find((item) => item.client === client);
  const plan = { client, locale, scenario, limits, config, candidates: row?.candidates ?? [],
    quota: row ? { reading: row.reading, source: row.quota.source, remainingPct: row.quota.remainingPct,
      readAt: row.quota.readAt, recordedAt: row.quota.recordedAt, observedAt: row.quota.observedAt } : null,
    slots: row?.slots, selections: client ? scenario.demands.map((demand) => profilePick({ client,
      effort: classify({ title: demand.title.en, body: demand.body.en, kind: demand.kind }).effort,
      quota: preflight.quota, config })) : [] };
  const planHash = createHash('sha256').update(canonical(plan)).digest('hex');
  const quota = preflight.observed;
  const unknown = pt ? 'desconhecida' : 'unknown';
  const reportsCost = config.smokeDrivers?.[client]?.reportsCost ?? DEFAULT_CONFIG.smokeDrivers[client]?.reportsCost;
  const bounds = reportsCost
    ? (pt ? 'O custo informado é somado; novos trabalhos param ao atingir o teto em dinheiro. O tempo e o número de passos também são limitados.'
      : 'Reported spending is added up; new work stops at the money ceiling. Time and the number of steps are also limited.')
    : (pt ? 'Este ajudante não informa o custo em dinheiro. O trabalho é limitado pelo tempo e pelo número de passos.'
      : 'This helper does not report a money total. Work is limited by time and the number of steps.');
  const textAllowance = limits.maxTokens === null
    ? (pt ? 'Não há teto para a quantidade de texto lido e escrito. Para executar o Codex, defina "maxTokens" dentro de "smoke" em config.json como um número inteiro positivo.'
      : 'There is no ceiling on the amount of text read and written. Before running Codex, set "maxTokens" under "smoke" in config.json to a positive whole number.')
    : (pt ? `Novos trabalhos param ao atingir ${limits.maxTokens} na medição de texto lido e escrito pelo ajudante.`
      : `New work stops after ${limits.maxTokens} in the helper's measure of text read and written.`);
  const moneyLimit = reportsCost
    ? `${pt ? 'Teto total' : 'Total ceiling'}: USD ${limits.maxUsd}; ${pt ? 'por trabalho' : 'per task'}: USD ${limits.demoDemandMaxUsd}`
    : (pt ? 'Este ajudante não informa custo em dinheiro, então não há teto de dinheiro disponível.'
      : 'This helper does not report money, so no money ceiling is available.');
  const text = [pt ? 'Vou preparar trabalhos em uma pasta temporária, verificar os resultados e corrigir o total incorreto.'
    : 'I will prepare practice work in a temporary folder, check the results and correct the wrong total.',
  scenario.demands.map((demand) => demand.title[locale]).join('; '),
  `${pt ? 'Ajudante' : 'Helper'}: ${client ?? unknown}`,
  `${pt ? 'Cota atual' : 'Current allowance'}: ${quota?.remainingPct ?? unknown}% (${quota?.source ?? unknown}); ${pt ? 'idade em minutos' : 'age in minutes'}: ${quota?.ageMinutes ?? unknown}`,
  moneyLimit,
  `${pt ? 'Correções por trabalho' : 'Corrections per task'}: ${limits.demoMaxReworkRounds}; ${pt ? 'minutos' : 'minutes'}: ${limits.maxMinutes}; ${pt ? 'chamadas' : 'calls'}: ${limits.maxTurns}`,
  bounds, ...(limits.maxTokens !== null || !reportsCost ? [textAllowance] : []),
  pt ? 'Esta prévia não gasta cota. Trabalho real usa sua cota. Posso começar?' : 'This preview spends nothing. Real work uses your allowance. May I start?'];
  let reason = preflight.refusal || preflight.stale
    ? (pt ? 'Atualize sua cota antes de começar.' : 'Update your allowance before starting.') : null;
  if (!client || !row) reason = pt ? 'Escolha um ajudante disponível.' : 'Choose an available helper.';
  if (!args.dryRun && (!args.confirm || args.confirm !== planHash)) reason = pt
    ? 'Confirme a prévia atual antes de começar; mudanças exigem nova confirmação.'
    : 'Confirm the current preview before starting; changes need fresh confirmation.';
  if (!args.dryRun && !reason && !config.smoke.demoRequireQuotaConfirmation) reason = pt
    ? 'A confirmação de cota precisa estar habilitada.' : 'Allowance confirmation must be enabled.';
  if (!args.dryRun && !reason) {
    const { spawn: nodeSpawn } = await import('node:child_process');
    const result = await runDemo({ root: deps.root, snapshot, client, locale,
      mode: 'real', confirmed: true, spawn: deps.spawn ?? nodeSpawn, env: deps.env,
      scenario, signal: deps.signal });
    return { ...result, planHash, plan };
  }
  if (reason) text.push(reason);
  return { status: args.dryRun ? 'preview' : 'refused', exitCode: args.dryRun ? 0 : 2,
    confirmed: false, planHash, plan, reasons: reason ? [reason] : [], text: text.join('\n') };
}

export async function smokeDemoCommand(flags, deps) {
  const args = {};
  let json = false;
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--json') json = true;
    else if (['--client', '--locale', '--confirm'].includes(flag) && flags[i + 1]?.startsWith('--') === false) {
      args[flag.slice(2)] = flags[++i];
    } else { deps.err('Use smoke-demo --dry-run [--client <client>] [--locale en|pt-BR] [--json]; --confirm <preview>.'); return 2; }
  }
  if ((args.locale && !['en', 'pt-BR'].includes(args.locale))
    || (args.client && !Object.hasOwn(configOf().install.clients, args.client))) {
    deps.err('Choose a listed helper and language. / Escolha um ajudante e idioma da lista.'); return 2;
  }
  const result = await smokeDemo(args, deps);
  deps.out(json ? JSON.stringify(result) : result.text);
  if (!json && args.dryRun) deps.out(`--confirm ${result.planHash}`);
  return result.exitCode;
}
