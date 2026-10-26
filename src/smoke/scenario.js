// The ordered C table of docs/maintainers/SMOKE.md. No I/O or client invocation here.
import { CLASSIFIER_RULES } from '../classify.js';
import { TOOL_NAMES } from '../mcp/tools.js';

const TAG = 'okit-smoke';
const ref = (path) => ({ $ref: path });
const client = ref('client');
const runId = ref('fixtures.slot.runId');
const tagged = (action, input = {}) => ({ action, tag: TAG, ...input });
const call = (tool, args = {}) => {
  const name = TOOL_NAMES.find((name) => name === tool);
  if (!name) throw new Error(`Unknown scenario tool: ${tool}`);
  return { tool: name, arguments: args };
};

// Probe the exported predicates rather than duplicating their word thresholds.
function demandFor(ruleId) {
  const rule = CLASSIFIER_RULES.find((entry) => entry.id === ruleId);
  const signals = { bodyWords: 1, steps: 0, acceptChecks: 0, hardHints: [], easyHints: [] };
  while (!rule.test(signals)) signals.bodyWords += 1;
  return { title: TAG, body: Array(signals.bodyWords).fill('item').join(' ') };
}

const step = (id, name, resource, kind, call, behaviour, judgedFrom) =>
  ({ id, name, resource, kind, call, behaviour, judgedFrom });

export const SCENARIO = [
  step('C1', 'plugin.loaded', 'plugin', 'reading', null,
    'The client loaded the installed plugin.', 'init.plugins[]: plugin name and loaded path'),
  step('C2', 'skills.visible', 'skills', 'reading', null,
    'okit-director, okit-executor, okit-critic, okit-smoke and okit-setup are visible under the plugin namespace.',
    'init.skills[]'),
  step('C3', 'mcp.connected', 'MCP', 'reading', { methods: ['initialize', 'tools/list'], tools: TOOL_NAMES },
    'The real stdio server is connected and answers the handshake with every tool name.',
    'init.mcp_servers[].status and initialize/tools/list JSON answers'),
  step('C4', 'hooks.fired', 'hooks', 'reading', null,
    'A plugin hook fired; skip hook-evidence-unavailable while no hook is shipped.',
    'Client hook_started and hook_response events'),
  step('C5', 'daemon.ticked', 'daemon', 'preparation',
    tagged('installed-bin', { argv: ['daemon', 'run-once'] }),
    'The installed daemon ticks and records its decision.', 'logs/<date>.jsonl decision line'),
  step('C6', 'caps.reported', 'caps', 'call', call('limits_status'),
    'Reported caps match config.limits, using core defaults for absent keys.',
    'Tool JSON answer against config.json limits'),
  step('C7', 'slot.acquired', 'slot', 'call', {
    ...call('acquire_slot', { runId, client }),
    preparation: tagged('ensure-room-under-caps', { limits: ref('config.limits') }),
  }, 'Under the configured caps, ok is true and the named client owns a live run.',
  'Tool JSON answer and runs/<fixtures.slot.runId>.json: live, client'),
  step('C8', 'slot.refused', 'slot', 'call', {
    ...call('acquire_slot', { runId: ref('fixtures.refused.runId'), client }),
    preparation: tagged('fill-to-cap', { limits: ref('config.limits') }),
    cleanup: tagged('release-fillers'),
  }, 'At the configured cap, ok is false and reason names the refusing cap.',
  'Tool JSON reason and absence of runs/<fixtures.refused.runId>.json'),
  step('C9', 'slot.released', 'slot', 'call', call('release_slot', { runId }),
    'Release returns ok true and the acquired slot becomes done.',
    'Tool JSON answer and runs/<fixtures.slot.runId>.json: done'),
  step('C10', 'slot.unknown', 'slot', 'call',
    call('release_slot', { runId: ref('fixtures.absent.runId') }),
    'A never-existing run returns ok false with unknown run and writes nothing.',
    'Tool JSON answer and absence of runs/<fixtures.absent.runId>.json'),
  step('C11', 'effort.simple', 'effort', 'call', call('classify', demandFor('short-body')),
    'The known short demand is simple with reason short-body.', 'Tool JSON effort and reasons'),
  step('C12', 'effort.normal', 'effort', 'call', call('classify', demandFor('mid-body')),
    'The known mid demand is normal with reason mid-body.', 'Tool JSON effort and reasons'),
  step('C13', 'effort.hard', 'effort', 'call', call('classify', demandFor('long-body')),
    'The known long demand is hard with reason long-body.', 'Tool JSON effort and reasons'),
  step('C14', 'profile.picked', 'profile', 'call', {
    ...call('profile_pick', { client, effort: ref('fixtures.profile.effort'), quota: ref('quota') }),
    variants: [ref('fixtures.profile.atFloor'), ref('fixtures.profile.belowFloor')],
  }, 'Resolve the configured profile and lowered class below config.lowQuotaPct; '
    + 'skip config-missing without config.json and report the installation incomplete.',
  'Tool JSON model against config.profiles.<client>.<class>, quota and config.lowQuotaPct'),
  step('C15', 'inbox.added', 'inbox', 'call',
    call('inbox_add', { title: TAG, body: ref('fixtures.inbox.body'), client }),
    'The returned demand is stored with the title sent.', 'Tool JSON answer and inbox.json item'),
  step('C16', 'inbox.listed', 'inbox', 'call', call('inbox_list'),
    'The list contains the demand returned by C15.', 'Tool JSON list: C15 answer id'),
  step('C17', 'inbox.moved', 'inbox', 'call',
    call('inbox_set_status', { id: ref('C15.answer.id'), status: 'delegated' }),
    'The demand moves to delegated and the move persists.', 'Tool JSON answer and inbox.json: delegated'),
  step('C18', 'inbox.refused', 'inbox', 'call', {
    ...call('inbox_set_status', { id: ref('fixtures.pending.id'), status: 'consolidated' }),
    preparation: tagged('inbox_add', { title: TAG, body: ref('fixtures.inbox.body'), client }),
  }, 'The pending to consolidated move is refused and the fresh demand stays pending.',
  'Tool JSON refusal and inbox.json: pending'),
  step('C19', 'order.added', 'order', 'call', call('order_add', { text: TAG }),
    'The returned order is stored and active.', 'Tool JSON answer and orders.json active row'),
  step('C20', 'order.revoked', 'order', 'call', {
    ...call('order_remove', { id: ref('C19.answer.id'), reason: TAG }),
    then: call('order_list'),
  }, 'Revocation keeps the row with revokedReason and removes it from the active list.',
  'orders.json revokedReason and order_list JSON without C19 answer id'),
  step('C21', 'template.opened', 'template', 'preparation',
    tagged('template-and-daemon', { template: ref('fixtures.dueTemplate'), argv: ['daemon', 'run-once'] }),
    'A due tagged template opens a child demand and the daemon records that id under opened.',
    'inbox.json child and logs/<date>.jsonl opened[]'),
  step('C22', 'status.matches', 'status', 'call', call('status'),
    'The client row matches the quota percentage and the status word follows the configured floor.',
    'Tool JSON status row against quota/<client>.json and config.lowQuotaPct'),
  step('C23', 'report.written', 'report', 'reading', null,
    'Both artifacts exist at the printed paths.',
    'Printed paths: logs/smoke/smoke-<runid>.jsonl and smoke-<runid>.log'),
];

export default SCENARIO;
