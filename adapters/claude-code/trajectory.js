import { trajectory, metrics } from '../../src/trajectory/schema.js';
import { records, textOf, sourceOf } from '../../src/trajectory/read.js';

export function readTrajectory(input, context = {}) {
  const rows = records(input), steps = [];
  for (const row of rows) {
    const message = row.message ?? (row.type === 'result' ? { content: row.result } : row);
    const content = message.content;
    if (content == null) continue;
    const parts = Array.isArray(content) ? content : [];
    const usage = row.type === 'result' && steps.some(item => item.metrics?.prompt_tokens != null)
      ? {} : message.usage ?? row.usage ?? {};
    steps.push({ timestamp: row.timestamp ?? null, source: sourceOf(message.role ?? row.type),
      message: textOf(content), model_name: message.model ?? null,
      reasoning_content: parts.filter(part => part.type === 'thinking').map(part => part.thinking).join('\n') || null,
      tool_calls: parts.filter(part => part.type === 'tool_use').map(part => ({
        tool_call_id: part.id ?? null, function_name: part.name, arguments: part.input ?? null })),
      observation: { results: parts.filter(part => part.type === 'tool_result').map(part => ({
        source_call_id: part.tool_use_id ?? null, content: part.is_error == null ? part.content ?? null
          : { output: part.content ?? null, is_error: part.is_error } })) },
      metrics: metrics({ prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
        cached_tokens: usage.cache_read_input_tokens, cost_usd: row.total_cost_usd ?? row.cost_usd }) });
  }
  return trajectory({ ...context, client: 'claude-code',
    model: steps.find(item => item.model_name)?.model_name ?? context.model,
    effort: rows.find(row => row.effort)?.effort ?? context.effort }, steps);
}
