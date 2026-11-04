export const instant = '2026-10-27T10:00:00.000Z';
export const claudeFixture = [
  { type: 'assistant', timestamp: instant, effort: 'high', message: { role: 'assistant', model: 'example-model',
    content: [{ type: 'text', text: 'Read the file' }, { type: 'thinking', thinking: 'Check first' },
      { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'sample.txt' } }],
    usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 } } },
  { type: 'user', timestamp: instant, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'call-1', content: 'File missing', is_error: true }] } },
];
export const codexFixture = [
  { type: 'turn_context', payload: { model: 'example-model', effort: 'high' } },
  { type: 'response_item', timestamp: instant, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Read the file' }] } },
  { type: 'response_item', timestamp: instant, payload: { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"sample.txt"}' } },
  { type: 'response_item', timestamp: instant, payload: { type: 'function_call_output', call_id: 'call-1', output: 'File missing' } },
  { type: 'event_msg', timestamp: instant, payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 3 } } } },
];
export const opencodeFixture = { messages: [{ info: { role: 'assistant', modelID: 'example-model', variant: 'high',
  time: { created: Date.parse(instant) }, tokens: { input: 12, output: 4, cache: { read: 3 } } },
parts: [{ type: 'text', text: 'Read the file' }, { type: 'tool', tool: 'read_file', callID: 'call-1',
  state: { input: { path: 'sample.txt' }, status: 'error', error: 'File missing' } }] }] };
import { readTrajectory as claude } from '../../adapters/claude-code/trajectory.js';
import { readTrajectory as codex } from '../../adapters/codex/trajectory.js';
import { readTrajectory as opencode } from '../../adapters/opencode/trajectory.js';
export const samples = [['claude-code', claude, claudeFixture], ['codex', codex, codexFixture],
  ['opencode', opencode, opencodeFixture]];
