import { execFile } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inboxAdd } from '../inbox.js';
import { acquireSlot, canSpawn, releaseSlot } from '../limits.js';
import { purgeAfter } from '../orders.js';
import { normalizeLimits, profilePick } from '../profiles.js';
import { statusTable } from '../status.js';
import { readJson, withLock, writeJsonAtomic } from '../state.js';
import { templateAdd, templateRemove } from '../templates.js';
import { TOOL_NAMES } from '../mcp/tools.js';

const exec = promisify(execFile);
export const skip = (reason) => ({ status: 'skip', error: reason });
const verdict = (ok, evidence) => ({ status: ok ? 'pass' : 'fail',
  error: ok ? '' : 'Expected evidence missing or incorrect', logTail: JSON.stringify(evidence) });

export async function daemon(context, signal) {
  const { pluginRoot, env, run } = context;
  if (!pluginRoot) throw new Error('Installed plugin path unavailable');
  // A real tick can delegate pending work and open other templates. Refuse
  // that preparation rather than changing records this smoke does not own.
  const inbox = await readJson(join(context.root, 'inbox.json'), { items: [] });
  const templates = await readJson(join(context.root, 'templates.json'), { templates: [] });
  const orders = await readJson(join(context.root, 'orders.json'), { orders: [] });
  if (inbox.items.some((item) => item.status === 'pending' && !context.owned.inbox.has(item.id))
    || templates.templates.some((item) => item.name !== context.templateName)
    || orders.orders.some((item) => !context.owned.orders.has(item.id)
      && Date.parse(purgeAfter(item, context.config.orders?.retentionDays)) <= Date.now())) {
    return null;
  }
  const started = Date.now();
  // Fill only our own slots, so this tick cannot start another model outside
  // the smoke's dollar ceiling (including a freshly opened template child).
  await prepare({ id: 'C8' }, context, signal);
  const request = { command: process.execPath, args: [join(pluginRoot, 'src/cli.js'), 'daemon', 'run-once'], env, signal };
  context.command = [request.command, ...request.args];
  try { await (run ?? ((req) => exec(req.command, req.args, { env: req.env, signal: req.signal })))(request); }
  finally { await cleanup(context); }
  const files = (await readdir(join(context.root, 'logs'))).filter((name) => name.endsWith('.jsonl'));
  const lines = (await Promise.all(files.map((file) => readFile(join(context.root, 'logs', file), 'utf8')))).join('\n');
  return lines.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => Date.parse(line.at) >= started);
}

export async function prepare(step, ctx, signal) {
  const { root, config, client, fixtures, owned } = ctx;
  if ((step.id === 'C9' && ctx.C7?.answer?.ok !== true)
    || (['C16', 'C17'].includes(step.id) && !ctx.C15?.answer?.id)
    || (step.id === 'C20' && !ctx.C19?.answer?.id)) return skip('client-refused');
  if (step.id === 'C19') {
    const orders = await readJson(join(root, 'orders.json'), { orders: [] });
    ctx.existingOrders = new Set(orders.orders.map((entry) => entry.id));
  }
  if (step.id === 'C7' && !(await canSpawn(root, { client, config })).ok) return skip('client-refused');
  if (step.id === 'C8') {
    while ((await canSpawn(root, { client, config })).ok) {
      signal?.throwIfAborted();
      const id = `${fixtures.slot.runId}-fill-${owned.fillers.length}`;
      const answer = await acquireSlot(root, id, { client, config });
      if (!answer.ok) break;
      owned.fillers.push(id);
    }
  }
  if (step.id === 'C18') {
    fixtures.pending = await inboxAdd(root, { title: 'okit-smoke', body: fixtures.inbox.body, client });
    owned.inbox.add(fixtures.pending.id);
  }
  if (step.id === 'C5' || step.id === 'C21') {
    if (step.id === 'C21') {
      ctx.templateName = fixtures.dueTemplate.name;
      const created = await templateAdd(root, fixtures.dueTemplate);
      ctx.owned.template = created;
      ctx.owned.orders.add(created.order.id);
    }
    ctx.decisions = await daemon(ctx, signal);
    if (!ctx.decisions) return skip('client-refused');
  }
}

export async function cleanup(ctx) {
  for (const id of ctx.owned.fillers.splice(0)) {
    await releaseSlot(ctx.root, id);
    await rm(join(ctx.root, 'runs', `${id}.json`), { force: true });
  }
}

export async function finish(ctx, keep) {
  await cleanup(ctx);
  const slot = join(ctx.root, 'runs', `${ctx.fixtures.slot.runId}.json`);
  const held = await readJson(slot, null);
  if (held?.client === ctx.client) {
    await releaseSlot(ctx.root, ctx.fixtures.slot.runId);
    if (!keep) await rm(slot, { force: true });
  }
  if (keep) return;
  if (ctx.owned.template) {
    const inbox = await readJson(join(ctx.root, 'inbox.json'), { items: [] });
    for (const item of inbox.items.filter((item) => item.ext?.template === ctx.templateName)) ctx.owned.inbox.add(item.id);
    await templateRemove(ctx.root, ctx.templateName);
  }
  for (const [file, key, ids] of [['inbox.json', 'items', ctx.owned.inbox], ['orders.json', 'orders', ctx.owned.orders]]) {
    if (!ids.size) continue;
    const path = join(ctx.root, file);
    await withLock(path, async () => {
      const store = await readJson(path, null);
      if (store) await writeJsonAtomic(path, { ...store, [key]: store[key].filter((item) => !ids.has(item.id)) });
    });
  }
}

export async function judge(step, ctx, answers) {
  const { root, init, events, config, fixtures } = ctx;
  const answer = answers.find((entry) => entry.tool?.endsWith(step.call?.tool))?.value;
  if (step.call?.tool && answer === undefined) return verdict(false, answers);
  ctx[step.id] = { answer };
  const run = (id) => readJson(join(root, 'runs', `${id}.json`), null);
  const inbox = (await readJson(join(root, 'inbox.json'), { items: [] })).items;
  const orders = (await readJson(join(root, 'orders.json'), { orders: [] })).orders;
  const item = (id) => inbox.find((entry) => entry.id === id);
  let ok = false; let evidence = answer;
  switch (step.id) {
    case 'C1':
      evidence = init?.plugins;
      ok = evidence?.some((entry) => entry.name?.includes('okit') && typeof entry.path === 'string');
      break;
    case 'C2':
      evidence = init?.skills;
      ok = ['okit-director', 'okit-executor', 'okit-critic', 'okit-smoke', 'okit-setup'].every((name) =>
        evidence?.some((entry) => (typeof entry === 'string' ? entry : entry.name)?.endsWith(`:${name}`)));
      break;
    case 'C3':
      evidence = init;
      ok = init?.mcp_servers?.some((entry) => entry.name?.includes('okit') && entry.status === 'connected')
        && TOOL_NAMES.every((name) => init.tools?.some((tool) =>
          (typeof tool === 'string' ? tool : tool.name)?.endsWith(`__${name}`)));
      break;
    case 'C4': {
      let hooks;
      try { hooks = await readFile(join(ctx.pluginRoot, 'hooks/hooks.json'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!hooks) return skip('hook-evidence-unavailable');
      evidence = events.filter((event) => ['hook_started', 'hook_response'].includes(event.subtype ?? event.type));
      ok = evidence.some((event) => JSON.stringify(event).includes(ctx.pluginRoot));
      break;
    }
    case 'C5': evidence = ctx.decisions; ok = evidence?.some((entry) => Array.isArray(entry.opened)); break;
    case 'C6': ok = JSON.stringify(normalizeLimits(answer.limits)) === JSON.stringify(normalizeLimits(config.limits)); break;
    case 'C7': {
      evidence = await run(fixtures.slot.runId);
      ok = answer.ok === true && evidence?.status === 'live' && evidence.client === ctx.client;
      break;
    }
    case 'C8': ok = answer.ok === false && ['default limit', 'client limit'].includes(answer.reason)
      && await run(fixtures.refused.runId) === null; break;
    case 'C9': evidence = await run(fixtures.slot.runId); ok = answer.ok === true && evidence?.status === 'done'; break;
    case 'C10': ok = answer.ok === false && answer.reason === 'unknown run' && await run(fixtures.absent.runId) === null; break;
    case 'C11': case 'C12': case 'C13': {
      const effort = step.name.split('.').at(-1);
      const rule = { simple: 'short-body', normal: 'mid-body', hard: 'long-body' }[effort];
      ok = answer.effort === effort && answer.reasons?.some((reason) => reason.startsWith(`${rule}:`));
      break;
    }
    case 'C14': ok = answer.model === profilePick({ client: ctx.client,
      effort: fixtures.profile.effort, quota: ctx.profileQuota ?? ctx.quota, config }).model; break;
    case 'C15':
      if (answer.id && item(answer.id)?.body === fixtures.inbox.body) ctx.owned.inbox.add(answer.id);
      ok = item(answer.id)?.title === 'okit-smoke' && item(answer.id)?.body === fixtures.inbox.body; break;
    case 'C16': ok = Array.isArray(answer) && answer.some((entry) => entry.id === ctx.C15?.answer?.id); break;
    case 'C17': ok = answer.id === ctx.C15?.answer?.id && answer.status === 'delegated'
      && item(answer.id)?.status === 'delegated'; break;
    case 'C18': ok = answers.some((entry) => entry.isError || /invalid|cannot|refus|transition/i.test(JSON.stringify(entry.value)))
      && item(fixtures.pending.id)?.status === 'pending'; break;
    case 'C19':
      ok = !ctx.existingOrders.has(answer.id)
        && orders.some((entry) => entry.id === answer.id && entry.text === 'okit-smoke' && !entry.revokedReason);
      if (ok) ctx.owned.orders.add(answer.id);
      break;
    case 'C20': {
      const id = ctx.C19?.answer?.id;
      ok = orders.some((entry) => entry.id === id && entry.revokedReason === 'okit-smoke')
        && answers.some((entry) => entry.tool?.endsWith('order_list') && Array.isArray(entry.value)
          && !entry.value.some((order) => order.id === id));
      break;
    }
    case 'C21':
      evidence = { inbox, decisions: ctx.decisions };
      ok = inbox.some((entry) => entry.ext?.template === ctx.templateName
        && ctx.decisions?.some((decision) => decision.opened?.includes(entry.id)));
      for (const entry of inbox.filter((entry) => entry.ext?.template === ctx.templateName)) ctx.owned.inbox.add(entry.id);
      break;
    case 'C22': {
      const quota = await readJson(join(root, 'quota', `${ctx.client}.json`), null);
      const row = answer.rows?.find((entry) => entry.client === ctx.client);
      const table = await statusTable(root, { clients: [ctx.client], config, readQuota: async () => quota,
        cache: new Map(), orders: [], limits: { limits: config.limits, live: 0, byClient: {} } });
      const expected = table.rows[0];
      ok = row && ['fiveHour', 'week', 'status'].every((key) => row[key] === expected[key]);
      break;
    }
  }
  return verdict(Boolean(ok), evidence);
}
