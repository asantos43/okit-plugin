import { trajectory, metrics } from '../../src/trajectory/schema.js';
import { records, textOf, sourceOf } from '../../src/trajectory/read.js';

export function readTrajectory(input, context = {}) {
  const rows = records(input), steps = [];
  const turn = rows.find(row => row.type === 'turn_context')?.payload ?? {};
  for (const row of rows) {
    const item = row.payload ?? row.item ?? row;
    if (row.type === 'turn_context' || row.type === 'session_meta') continue;
    if (item.type === 'token_count' || row.type === 'turn.completed') {
      const usage = item.info?.last_token_usage ?? row.usage ?? {};
      steps.push({ timestamp: row.timestamp ?? null, source: 'system', message: null,
        metrics: metrics({ prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
          cached_tokens: usage.cached_input_tokens }) }); continue;
    }
    if (!['message', 'function_call', 'function_call_output', 'reasoning', 'agent_message', 'command_execution'].includes(item.type)) continue;
    steps.push({ timestamp: row.timestamp ?? null, source: sourceOf(item.role),
      message: textOf(item.content) ?? item.text ?? null, model_name: turn.model ?? context.model ?? null,
      reasoning_content: item.type === 'reasoning' ? textOf(item.summary) : null,
      tool_calls: ['function_call', 'command_execution'].includes(item.type) ? [{ tool_call_id: item.call_id ?? item.id ?? null,
        function_name: item.name ?? 'shell', arguments: item.arguments ?? item.command ?? null }] : [],
      observation: { results: ['function_call_output', 'command_execution'].includes(item.type) ? [{
        source_call_id: item.call_id ?? item.id ?? null, content: item.exit_code == null
          ? item.output ?? item.aggregated_output ?? null : { output: item.output ?? item.aggregated_output ?? null,
            is_error: item.exit_code !== 0 } }] : [] } });
  }
  return trajectory({ ...context, client: 'codex', model: turn.model ?? context.model,
    effort: turn.effort ?? turn.reasoning_effort ?? context.effort }, steps);
}
