import { inScope } from './applies.js';
import { orderStatus } from './orders.js';
import { accountName, accountRows } from './env/account-rows.js';

const POLICY = {
  Director: {
    en: ['Understand requests, record work and orders, choose actors within quota and slots, delegate and verify results.', 'Never invent capacity, evade orders or claim unverified success.'],
    pt: ['Entender pedidos, registrar trabalho e ordens, escolher atores dentro da cota e das vagas, delegar e verificar resultados.', 'Nunca inventar capacidade, contornar ordens ou declarar sucesso sem verificação.'],
  },
  Executor: {
    en: ['Carry out and verify only the briefed step in its directory and limits.', 'Never expand scope or publish or merge without briefing authorization.'],
    pt: ['Realizar e verificar somente o passo do briefing, na pasta e nos limites definidos.', 'Nunca ampliar escopo, publicar ou mesclar sem autorização no briefing.'],
  },
  Critic: {
    en: ['Inspect the diff and acceptance evidence; return pass, revise or reject with findings.', 'Never treat the executor report as proof or expand the assignment.'],
    pt: ['Inspecionar a diferença e as evidências de aceite; devolver pass, revise ou reject com achados.', 'Nunca tratar o relatório do executor como prova ou ampliar a tarefa.'],
  },
};
export const ROLE_ROUTING = { en: 'Main session: Director by default. An explicit Role: Executor or Role: Critic briefing overrides this default. Ambiguous briefing: ask for clarification before work.', 'pt-BR': 'Sessão principal: Director por padrão. Briefing explícito Papel: Executor ou Papel: Critic substitui o padrão. Briefing ambíguo: pedir esclarecimento antes do trabalho.' };
const clean = (value) => String(value ?? '').replace(/[\r\n\x00-\x1f]+/g, ' ').trim();
const UNKNOWN_FACTS = {
  environment: { en: 'environment', 'pt-BR': 'ambiente' },
  orders: { en: 'orders', 'pt-BR': 'ordens' },
  work: { en: 'work', 'pt-BR': 'demandas' },
  limits: { en: 'limits', 'pt-BR': 'limites' },
  'actors, quota and slots': { en: 'actors, quota and slots', 'pt-BR': 'atores, cota e vagas' },
  actors: { en: 'actors', 'pt-BR': 'atores' },
  quota: { en: 'quota', 'pt-BR': 'cota' },
  slots: { en: 'slots', 'pt-BR': 'vagas' },
};

export function briefedRole(briefing) {
  if (briefing == null) return 'Director';
  const roles = typeof briefing === 'object' ? [briefing.role]
    : [...String(briefing).matchAll(/^(?:role|papel)\s*:\s*(\w+)\s*$/gim)].map((m) => m[1]);
  const unique = [...new Set(roles.map((role) => String(role).toLowerCase()))];
  return unique.length === 1 ? ['Executor', 'Critic'].find((role) => role.toLowerCase() === unique[0]) ?? null : null;
}

/** Pure composition: no discovery, configuration writes, slots or quota spend. */
export function roleContext({ client, briefing, snapshot, items, orders, limits, cwd, scope, actor } = {}) {
  const role = briefedRole(briefing);
  if (!role) return { status: 'clarification', role: null,
    reason: 'Clarify briefing role: Executor or Critic.' };
  const now = snapshot?.now ?? Date.now();
  const applicable = (record) => inScope(record, cwd) && (!scope || !record.scope || record.scope === 'all' || record.scope === scope);
  // A client with several accounts is one row per account, each with its own quota, slots and actors; a client with
  // one account stays the row it always was.
  const clients = accountRows(snapshot?.clients ?? []);
  const appliedLimits = limits ?? snapshot?.config?.limits;
  const unknown = [];
  if (!snapshot) unknown.push('environment');
  if (!orders) unknown.push('orders');
  if (!items) unknown.push('work');
  if (!appliedLimits) unknown.push('limits');
  if (!clients.length) unknown.push('actors, quota and slots');
  for (const row of clients) {
    const name = clean(accountName(row));
    if (!row.actors?.length) unknown.push(`${name}: actors`);
    if (row.quota?.remainingPct == null) unknown.push(`${name}: quota`);
    if (!row.slots) unknown.push(`${name}: slots`);
  }
  return { status: 'ready', client, role, actor: actor ? { model: actor.model, effort: actor.effort ?? null } : null,
    briefing: briefing == null ? null : typeof briefing === 'string' ? briefing : briefing.text ?? briefing.body ?? '',
    policy: POLICY[role], orders: orders?.filter((order) => applicable(order) && orderStatus(order, now) === 'active').map((order) => clean(order.title ?? order.text)),
    limits: appliedLimits ?? null, work: items?.filter((item) => applicable(item) && !['consolidated', 'failed'].includes(item.status)).map((item) => clean(item.title)),
    actors: clients.flatMap((row) => (row.actors ?? []).map((entry) => ({ client: row.client,
      ...row.account ? { account: row.account, accountLabel: clean(row.accountLabel) } : {}, model: entry.model, effort: entry.effort,
      restrictions: entry.restrictions ?? [], quota: row.quota, slots: row.slots }))), unknown };
}

export function formatRoleContext(context, language = 'en') {
  const pt = language === 'pt' || language === 'pt-BR';
  const select = (text) => typeof text === 'object' ? text[pt ? 'pt-BR' : 'en'] : text;
  if (context.status !== 'ready') return select(context.reason);
  const unknown = pt ? 'desconhecido' : 'unknown';
  const list = (values) => values == null ? unknown : values.length ? values.map(select).join('; ') : pt ? 'nenhum' : 'none'; // locale:pt-BR
  const [may, mustNot] = context.policy[pt ? 'pt' : 'en'];
  const unknownFacts = context.unknown.map((fact) => {
    if (UNKNOWN_FACTS[fact]) return select(UNKNOWN_FACTS[fact]);
    const colon = fact.lastIndexOf(': '), label = fact.slice(colon + 2);
    return colon >= 0 && UNKNOWN_FACTS[label] ? `${fact.slice(0, colon)}: ${select(UNKNOWN_FACTS[label])}` : fact;
  });
  const actors = context.actors.map((actor) => `${accountName(actor)}: ${actor.model} + ${actor.effort ?? unknown}; ${pt ? 'cota' : 'quota'} ${actor.quota?.remainingPct ?? unknown}%; ${pt ? 'vagas livres' : 'free slots'} ${actor.slots?.available ?? unknown}; ${pt ? 'restrições' : 'restrictions'}: ${list(actor.restrictions)}`); // locale:pt-BR
  return [ROLE_ROUTING, `${pt ? 'Papel' : 'Role'}: ${context.role}`,
    `${pt ? 'Pode' : 'May'}: ${may}`, `${pt ? 'Não pode' : 'Must not'}: ${mustNot}`, // locale:pt-BR
    `${pt ? 'Ordens' : 'Orders'}: ${list(context.orders)}`, // locale:pt-BR
    `${pt ? 'Limites' : 'Limits'}: ${context.limits ? JSON.stringify(context.limits) : unknown}`,
    `${pt ? 'Demandas em mãos' : 'Work in hand'}: ${list(context.work)}`, // locale:pt-BR
    `${pt ? 'Atores disponíveis' : 'Available actors'}: ${list(actors)}`, // locale:pt-BR
    `${pt ? 'Fatos desconhecidos' : 'Unknown facts'}: ${list(unknownFacts)}`,
    { en: 'Answer role questions with all these fields using order_list, inbox_list, actors_list, limits_status and env_report for current facts. Use readable titles, never demand/order ids. Environment questions are read-only: no setup save, launch or quota spend.', 'pt-BR': 'Responda perguntas de papel com todos estes campos usando essas leituras atuais. Use títulos legíveis, nunca ids de demanda/ordem. Perguntas de ambiente são somente leitura: sem salvar configuração, lançar trabalho ou gastar cota.' },
    ].map(select).join('\n');
}

export function rolePrompt(options) {
  const context = roleContext(options);
  if (context.status !== 'ready') throw new TypeError(context.reason);
  return `${formatRoleContext(context)}${context.briefing ? `\nBriefing: ${context.briefing}` : ''}`;
}
