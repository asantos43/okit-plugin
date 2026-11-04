import { trajectory, metrics } from '../../src/trajectory/schema.js';
import { records, textOf, sourceOf } from '../../src/trajectory/read.js';

export function readTrajectory(input, context = {}) {
  const rows = records(input), steps = [];
  let hasPromptTokens = false, firstModel, firstEffort;
  for (const row of rows) {
    if (!firstEffort && row.effort) firstEffort = row.effort;
    const message = row.message ?? (row.type === 'result' ? { content: row.result } : row);
    const content = message.content;
    if (content == null) continue;
    const parts = Array.isArray(content) ? content : [];
    const reasoning = [], calls = [], results = [];
    for (const part of parts) {
      if (part.type === 'thinking') reasoning.push(part.thinking);
      if (part.type === 'tool_use') calls.push({ tool_call_id: part.id ?? null, function_name: part.name, arguments: part.input ?? null });
      if (part.type === 'tool_result') results.push({ source_call_id: part.tool_use_id ?? null,
        content: part.is_error == null ? part.content ?? null : { output: part.content ?? null, is_error: part.is_error } });
    }
    const usage = row.type === 'result' && hasPromptTokens
      ? {} : message.usage ?? row.usage ?? {};
    steps.push({ timestamp: row.timestamp ?? null, source: sourceOf(message.role ?? row.type),
      message: textOf(content), model_name: message.model ?? null,
      reasoning_content: reasoning.join('\n') || null, tool_calls: calls, observation: { results },
      metrics: metrics({ prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
        cached_tokens: usage.cache_read_input_tokens, cost_usd: row.total_cost_usd ?? row.cost_usd }) });
    if (steps.at(-1).metrics.prompt_tokens != null) hasPromptTokens = true;
    if (!firstModel && message.model) firstModel = message.model;
  }
  return trajectory({ ...context, client: 'claude-code',
    model: firstModel ?? context.model, effort: firstEffort ?? context.effort }, steps);
}
