export const SCHEMA_VERSION = 'ATIF-v1.4';
export const unavailable = null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function metrics(values = {}) {
  return Object.fromEntries(['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd']
    .map(key => [key, numeric(values?.[key])]));
}
export function step(value = {}) {
  return { step_id: value.step_id, timestamp: value.timestamp ?? null,
    source: value.source ?? 'agent', message: value.message ?? null,
    model_name: value.model_name ?? null, ...value, metrics: metrics(value.metrics) };
}
export function trajectory(context = {}, steps = []) {
  return normalize({ schema_version: SCHEMA_VERSION, session_id: context.session_id ?? null,
    agent: { name: 'okit-plugin', version: context.version ?? null, model_name: context.model ?? null,
      extra: { role: context.role ?? 'executor', client: context.client ?? null,
        effort: context.effort ?? null, demand: context.demand ?? null, step: context.step ?? null,
        ...(context.role === 'critic' ? { critic_of: context.critic_of ?? null } : {}) } },
    steps: steps.map((value, index) => step({ ...value, model_name: value.model_name ?? context.model ?? null, step_id: index + 1 })),
    final_metrics: totals(steps) });
}
export function totals(steps) {
  const result = { total_steps: steps.length };
  for (const key of ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd']) {
    const values = steps.map(item => item?.metrics?.[key]);
    result[`total_${key}`] = values.some(value => value != null)
      ? values.reduce((sum, value) => sum + (value ?? 0), 0) : null;
  }
  return result;
}
const agentFields = ['model_name', 'reasoning_effort', 'reasoning_content', 'tool_calls', 'metrics'];
const stepFields = ['step_id', 'timestamp', 'source', 'message', 'extra', 'observation', ...agentFields];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function argumentsObject(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (object(parsed)) return parsed; } catch { /* Plain input. */ }
  }
  return object(value) ? value : { input: value };
}
function normalizeStep(value) {
  const item = step(structuredClone(object(value) ? value : { message: value }));
  if (!['agent', 'user', 'system'].includes(item.source)) item.source = 'agent';
  if (typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp))) item.timestamp = null;
  if (!object(item.extra)) delete item.extra;
  for (const key of ['model_name', 'reasoning_effort']) {
    if (item[key] != null && typeof item[key] !== 'string') delete item[key];
  }
  if (typeof item.reasoning_content !== 'string') delete item.reasoning_content;
  item.message = item.message == null ? '' : typeof item.message === 'string' ? item.message : JSON.stringify(item.message);
  for (const key of Object.keys(item).filter(key => !stepFields.includes(key))) {
    item.extra = { ...item.extra, [key]: item[key] }; delete item[key];
  }
  item.tool_calls = (Array.isArray(item.tool_calls) ? item.tool_calls : []).map(call => ({
    tool_call_id: call?.tool_call_id, function_name: String(call?.function_name ?? 'unknown'),
    arguments: argumentsObject(call?.arguments) }));
  const results = Array.isArray(item.observation?.results) ? item.observation.results : [];
  item.observation = { results: results.map(result => ({ source_call_id: result?.source_call_id ?? null, content: result?.content })) };
  for (const [index, result] of item.observation.results.entries()) {
    if (result.content?.is_error) item.extra = { ...item.extra,
      failed_results: [...new Set([...(Array.isArray(item.extra?.failed_results) ? item.extra.failed_results : []), index])] };
    if (typeof result.content !== 'string') result.content = JSON.stringify(result.content ?? null);
  }
  return item;
}
function moveResults(item, preceding) {
  const results = item.observation?.results ?? [];
  const failed = new Set(Array.isArray(item.extra?.failed_calls) ? item.extra.failed_calls.filter(id => typeof id === 'string' && !!id.trim()) : []);
  const failedResults = new Set(Array.isArray(item.extra?.failed_results) ? item.extra.failed_results : []);
  if (item.extra) {
    item.extra.failed_calls = [...failed].filter(id => item.tool_calls.some(call => call.tool_call_id === id)
      && !results.some(result => result.source_call_id === id));
    delete item.extra.failed_results;
  }
  delete item.observation;
  for (const [index, result] of results.entries()) {
    const id = result.source_call_id;
    const matches = candidate => typeof id === 'string' && !!id.trim() && candidate.tool_calls?.some(call => call.tool_call_id === id);
    const target = matches(item) ? item : preceding.findLast(matches);
    const destination = target ?? item;
    if (!target) result.source_call_id = null;
    destination.observation ??= { results: [] };
    const resultIndex = destination.observation.results.length;
    destination.observation.results.push(result);
    if (failed.has(id) || failedResults.has(index)) {
      const key = result.source_call_id === null ? 'failed_results' : 'failed_calls';
      destination.extra = { ...destination.extra,
        [key]: [...new Set([...(destination.extra?.[key] ?? []), key === 'failed_results' ? resultIndex : result.source_call_id])] };
    }
  }
  if (item.extra?.failed_calls?.length === 0) delete item.extra.failed_calls;
  if (item.extra && Object.keys(item.extra).length === 0) delete item.extra;
}
function assignCallIds(steps) {
  const calls = steps.flatMap(item => item.tool_calls ?? []);
  const validId = id => typeof id === 'string' && !!id.trim();
  const used = new Set(calls.map(call => call.tool_call_id).filter(validId));
  for (const item of steps) for (const [index, call] of (item.tool_calls ?? []).entries()) {
    if (validId(call.tool_call_id)) continue;
    const base = `call-${item.step_id}-${index + 1}`;
    let id = base, suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    call.tool_call_id = id; used.add(id);
  }
}
export function normalize(data = {}) {
  const steps = [], result = { ...data, schema_version: SCHEMA_VERSION };
  for (const value of Array.isArray(data.steps) ? data.steps : []) {
    const item = normalizeStep(value);
    moveResults(item, steps);
    let usage = Object.fromEntries(Object.entries(metrics(item.metrics)).filter(([, n]) => n !== null));
    const previous = steps.findLast(candidate => candidate.source === 'agent');
    const empty = !item.message && !item.tool_calls.length && !item.observation?.results?.length && !item.reasoning_content;
    const keepExtra = Object.keys(item.extra ?? {}).some(key => !['failed_calls', 'failed_results'].includes(key));
    if ((item.source !== 'agent' || empty) && Object.keys(usage).length) {
      if (previous) {
        for (const [key, n] of Object.entries(usage)) previous.metrics = { ...previous.metrics, [key]: (previous.metrics?.[key] ?? 0) + n };
        usage = {};
      }
      else item.source = 'agent';
    }
    if (item.tool_calls.length || item.observation?.results?.length || item.reasoning_content || (empty && keepExtra)) item.source = 'agent';
    if (item.source !== 'agent') for (const key of agentFields) delete item[key];
    else {
      if (Object.keys(usage).length) item.metrics = usage; else delete item.metrics;
      if (!item.tool_calls.length) delete item.tool_calls;
      if (!item.reasoning_content) delete item.reasoning_content;
    }
    if (!item.observation?.results?.length) delete item.observation;
    if (!item.message && !item.tool_calls?.length && !item.observation && !item.reasoning_content && !item.metrics && !keepExtra) continue;
    steps.push(item);
  }
  if (!steps.length) steps.push({ timestamp: null, source: 'system', message: '' });
  result.steps = steps.map((item, index) => ({ ...item, step_id: index + 1 }));
  assignCallIds(result.steps);
  result.final_metrics = totals(result.steps);
  if (!validate(result)) throw new Error('Invalid saved run / Execução salva inválida');
  return result;
}
export function validate(data) {
  if (data?.schema_version !== SCHEMA_VERSION || !Array.isArray(data.steps) || !data.steps.length || !data.steps.every(object)) return false;
  return validEnvelope(data) && typeof data.agent.name === 'string' && !!data.agent.name
    && (data.agent.version === null || typeof data.agent.version === 'string')
    && (data.agent.model_name === null || typeof data.agent.model_name === 'string')
    && data.steps.every((item, index) => item.step_id === index + 1
    && ['agent', 'user', 'system'].includes(item.source)
    && typeof item.message === 'string' && Object.keys(item).every(key => stepFields.includes(key))
    && (item.timestamp === null || (typeof item.timestamp === 'string' && Number.isFinite(Date.parse(item.timestamp))))
    && (item.extra === undefined || object(item.extra))
    && ['model_name', 'reasoning_effort'].every(key => item[key] == null || typeof item[key] === 'string')
    && (item.source === 'agent' || ![...agentFields, 'observation'].some(key => Object.hasOwn(item, key)))
    && (!Object.hasOwn(item, 'metrics') || (object(item.metrics) && Object.keys(item.metrics).length > 0
      && Object.entries(item.metrics).every(([key, value]) => Object.hasOwn(metrics(), key) && numeric(value) !== null)))
    && (!Object.hasOwn(item, 'tool_calls') || (Array.isArray(item.tool_calls) && item.tool_calls.length > 0
      && item.tool_calls.every(call => object(call) && typeof call.function_name === 'string'
        && object(call.arguments) && typeof call.tool_call_id === 'string' && !!call.tool_call_id.trim())))
    && (!Object.hasOwn(item.extra ?? {}, 'failed_calls') || (Array.isArray(item.extra.failed_calls)
      && item.extra.failed_calls.every(id => typeof id === 'string' && !!id.trim()
        && item.tool_calls?.some(call => call.tool_call_id === id))))
    && (!Object.hasOwn(item.extra ?? {}, 'failed_results') || (Array.isArray(item.extra.failed_results)
      && item.extra.failed_results.every(index => Number.isInteger(index) && index >= 0
        && index < (item.observation?.results?.length ?? 0) && item.observation.results[index]?.source_call_id === null)))
    && (!Object.hasOwn(item, 'reasoning_content') || (typeof item.reasoning_content === 'string' && !!item.reasoning_content))
    && (!Object.hasOwn(item, 'observation') || (item.observation?.results?.length > 0
      && Array.isArray(item.observation.results) && item.observation.results.every(result => object(result) && typeof result.content === 'string'
        && (result.source_call_id === null || item.tool_calls?.some(call => call.tool_call_id === result.source_call_id))))));
}
export function readable(data) {
  return /^ATIF-v1\.[0-7]$/.test(data?.schema_version)
    && (validate({ ...data, schema_version: SCHEMA_VERSION }) || validateLegacy({ ...data,
      final_metrics: { ...totals(Array.isArray(data.steps) ? data.steps : []), ...data.final_metrics } }));
}
function validEnvelope(data) {
  if (!/^ATIF-v1\.[0-7]$/.test(data?.schema_version) || typeof data.session_id !== 'string'
    || !data.session_id || !['executor', 'critic'].includes(data.agent?.extra?.role)
    || !Object.hasOwn(data.agent ?? {}, 'model_name')
    || !Object.hasOwn(data.agent?.extra ?? {}, 'effort') || !Array.isArray(data.steps)
    || !data.final_metrics || data.final_metrics.total_steps !== data.steps.length
    || !Object.hasOwn(data.agent, 'name') || !Object.hasOwn(data.agent, 'version')
    || ['client', 'demand', 'step'].some(key => !Object.hasOwn(data.agent.extra, key))
    || (data.agent.extra.role === 'critic' && !Object.hasOwn(data.agent.extra, 'critic_of'))
    || ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd'].some(key => {
      const value = data.final_metrics[`total_${key}`];
      return value !== null && numeric(value) === null;
    })) return false;
  return true;
}
export function validateLegacy(data) {
  if (!validEnvelope(data)) return false;
  return data.steps.every((item, index) => item && typeof item === 'object' && item.step_id === index + 1
    && ['system', 'user', 'agent'].includes(item.source)
    && (item.timestamp === null || Number.isFinite(Date.parse(item.timestamp)))
    && Object.hasOwn(item, 'message')
    && item.metrics && Object.keys(metrics()).every(key => item.metrics[key] === null || numeric(item.metrics[key]) !== null)
    && (!item.tool_calls || Array.isArray(item.tool_calls))
    && (item.tool_calls ?? []).every(call => call && typeof call.function_name === 'string'
      && Object.hasOwn(call, 'arguments') && Object.hasOwn(call, 'tool_call_id'))
    && (!item.observation || (Array.isArray(item.observation.results)
      && item.observation.results.every(result => result && Object.hasOwn(result, 'source_call_id')
        && Object.hasOwn(result, 'content')))));
}
