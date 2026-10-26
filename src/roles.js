import { inScope } from './applies.js';
import { orderStatus } from './orders.js';

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
export const ROLE_ROUTING = 'Main session: Director by default. An explicit Role: Executor or Role: Critic briefing overrides this default. Ambiguous briefing: ask for clarification before work. / Sessão principal: Director por padrão. Briefing explícito Papel: Executor ou Papel: Critic substitui o padrão. Briefing ambíguo: pedir esclarecimento antes do trabalho.';
const clean = (value) => String(value ?? '').replace(/[\r\n\x00-\x1f]+/g, ' ').trim();

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
    reason: 'Clarify briefing role: Executor or Critic. / Esclareça o papel do briefing: Executor ou Critic.' };
  const now = snapshot?.now ?? Date.now();
  const applicable = (record) => inScope(record, cwd) && (!scope || !record.scope || record.scope === 'all' || record.scope === scope);
  const clients = snapshot?.clients ?? [];
  const appliedLimits = limits ?? snapshot?.config?.limits;
  const unknown = [];
  if (!snapshot) unknown.push('environment / ambiente');
  if (!orders) unknown.push('orders / ordens');
  if (!items) unknown.push('work / demandas');
  if (!appliedLimits) unknown.push('limits / limites');
  if (!clients.length) unknown.push('actors, quota and slots / atores, cota e vagas');
  for (const row of clients) {
    if (!row.actors?.length) unknown.push(`${row.client}: actors / atores`);
    if (row.quota?.remainingPct == null) unknown.push(`${row.client}: quota / cota`);
    if (!row.slots) unknown.push(`${row.client}: slots / vagas`);
  }
  return { status: 'ready', client, role, actor: actor ? { model: actor.model, effort: actor.effort ?? null } : null,
    briefing: briefing == null ? null : typeof briefing === 'string' ? briefing : briefing.text ?? briefing.body ?? '',
    policy: POLICY[role], orders: orders?.filter((order) => applicable(order) && orderStatus(order, now) === 'active').map((order) => clean(order.title ?? order.text)),
    limits: appliedLimits ?? null, work: items?.filter((item) => applicable(item) && !['consolidated', 'failed'].includes(item.status)).map((item) => clean(item.title)),
    actors: clients.flatMap((row) => (row.actors ?? []).map((entry) => ({ client: row.client, model: entry.model, effort: entry.effort,
      restrictions: entry.restrictions ?? [], quota: row.quota, slots: row.slots }))), unknown };
}

export function formatRoleContext(context, language = 'en') {
  if (context.status !== 'ready') return context.reason;
  const pt = language === 'pt' || language === 'pt-BR';
  const unknown = pt ? 'desconhecido' : 'unknown';
  const list = (values) => values == null ? unknown : values.length ? values.join('; ') : pt ? 'nenhum' : 'none';
  const [may, mustNot] = context.policy[pt ? 'pt' : 'en'];
  const actors = context.actors.map((actor) => `${actor.client}: ${actor.model} + ${actor.effort ?? unknown}; ${pt ? 'cota' : 'quota'} ${actor.quota?.remainingPct ?? unknown}%; ${pt ? 'vagas livres' : 'free slots'} ${actor.slots?.available ?? unknown}; ${pt ? 'restrições' : 'restrictions'}: ${list(actor.restrictions)}`);
  return [ROLE_ROUTING, `${pt ? 'Papel' : 'Role'}: ${context.role}`,
    `${pt ? 'Pode' : 'May'}: ${may}`, `${pt ? 'Não pode' : 'Must not'}: ${mustNot}`,
    `${pt ? 'Ordens' : 'Orders'}: ${list(context.orders)}`,
    `${pt ? 'Limites' : 'Limits'}: ${context.limits ? JSON.stringify(context.limits) : unknown}`,
    `${pt ? 'Demandas em mãos' : 'Work in hand'}: ${list(context.work)}`,
    `${pt ? 'Atores disponíveis' : 'Available actors'}: ${list(actors)}`,
    `${pt ? 'Fatos desconhecidos' : 'Unknown facts'}: ${list(context.unknown)}`,
    'Answer role questions with all these fields using order_list, inbox_list, actors_list, limits_status and env_report for current facts. Use readable titles, never demand/order ids. Environment questions are read-only: no setup save, launch or quota spend. / Responda perguntas de papel com todos estes campos usando essas leituras atuais. Use títulos legíveis, nunca ids de demanda/ordem. Perguntas de ambiente são somente leitura: sem salvar configuração, lançar trabalho ou gastar cota.',
    ].join('\n');
}

export function rolePrompt(options) {
  const context = roleContext(options);
  if (context.status !== 'ready') throw new TypeError(context.reason);
  return `${formatRoleContext(context)}\n${formatRoleContext(context, 'pt')}${context.briefing ? `\nBriefing: ${context.briefing}` : ''}`;
}
