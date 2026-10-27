// Compatibility shape; see the follow-up in the component documentation.
export const SCHEMA_VERSION = 'ATIF-v1.4';
export const unavailable = null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function metrics(values = {}) {
  return Object.fromEntries(['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd']
    .map(key => [key, numeric(values[key])]));
}
export function step(value = {}) {
  return { step_id: value.step_id, timestamp: value.timestamp ?? null,
    source: value.source ?? 'agent', message: value.message ?? null,
    model_name: value.model_name ?? null, ...value, metrics: metrics(value.metrics) };
}
export function trajectory(context = {}, steps = []) {
  return { schema_version: SCHEMA_VERSION, session_id: context.session_id ?? null,
    agent: { name: 'okit-plugin', version: context.version ?? null, model_name: context.model ?? null,
      extra: { role: context.role ?? 'executor', client: context.client ?? null,
        effort: context.effort ?? null, demand: context.demand ?? null, step: context.step ?? null,
        ...(context.role === 'critic' ? { critic_of: context.critic_of ?? null } : {}) } },
    steps: steps.map((value, index) => step({ ...value, model_name: value.model_name ?? context.model ?? null, step_id: index + 1 })),
    final_metrics: totals(steps) };
}
export function totals(steps) {
  const result = { total_steps: steps.length };
  for (const key of ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd']) {
    const values = steps.map(item => item.metrics?.[key]);
    result[`total_${key}`] = values.some(value => value != null)
      ? values.reduce((sum, value) => sum + (value ?? 0), 0) : null;
  }
  return result;
}
export function validate(data) {
  if (data?.schema_version !== SCHEMA_VERSION || typeof data.session_id !== 'string'
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
